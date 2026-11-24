import { Link } from '@tanstack/react-router'
import { ArrowUpRightIcon, BoxIcon, CornerDownLeftIcon, GlobeIcon, XIcon } from 'lucide-react'
import { type FormEvent, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetClose, SheetContent } from '@/components/ui/sheet'
import type { MuteRule, MuteScope, MuteShape } from '@/gen'
import { useSources } from '@/lib/api'
import { draftRule, globalOff, matchesMute, routePath, ruleTarget, ruleText, sameRule, storedAs } from '@/lib/mute'
import {
  ruleHits,
  sumHits,
  useAddMuteRule,
  useDeleteMuteRule,
  useMutePreview,
  useMuteStats,
  useUpdateMuteRule,
} from '@/lib/mute-api'
import { useSettings } from '@/lib/settings-api'
import { useSourceFields } from '@/lib/stream-api'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'
import { HitsBySource, offOn } from './hits-by-source'
import {
  fmtN,
  fmtShare,
  MethodSplit,
  OWNERS_ONLY_GLOBAL,
  perMinute,
  SampleLine,
  Segmented,
  SourceBars,
  shareOf,
  WARN_SHARE,
  Warn,
} from './rule-bits'

export const SHAPES: { value: Exclude<MuteShape, 'text'>; label: string }[] = [
  { value: 'route', label: 'Route' },
  { value: 'method_route', label: 'Method + route' },
  { value: 'message', label: 'Exact message' },
  { value: 'field', label: 'Field rule' },
]
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export interface Draft {
  shape: MuteShape
  route: string
  method: string
  message: string
  field: string
  value: string
}

export function fromRule(r?: MuteRule): Draft {
  if (!r) return { shape: 'route', route: '', method: 'GET', message: '', field: '', value: '' }
  return {
    shape: r.shape === 'text' ? 'field' : r.shape,
    route: r.shape === 'route' || r.shape === 'method_route' ? r.value : '',
    method: r.method ?? 'GET',
    message: r.shape === 'message' ? r.value : '',
    field: r.shape === 'field' ? (r.field ?? '') : '',
    value: r.shape === 'field' || r.shape === 'text' ? r.value : '',
  }
}

export function toRule(d: Draft, scope: MuteScope, keepField: string | null): MuteRule {
  switch (d.shape) {
    case 'route':
      return draftRule('route', routePath(d.route), { scope, field: keepField })
    case 'method_route':
      return draftRule('method_route', routePath(d.route), { scope, field: keepField, method: d.method })
    case 'message':
      return draftRule(
        'message',
        d.message
          .trim()
          .replace(/^msg:/, '')
          .replace(/^"(.*)"$/, '$1'),
        { scope },
      )
    default:
      return draftRule('field', d.value.trim(), { scope, field: d.field.trim() || null })
  }
}

/**
 * Add rule (06.14 route · 06.15 method + route · 06.16 exact message · 06.17
 * field rule) on a source or every source, with a live "Will hide" preview,
 * a warning above ~30% of a source, "already hidden by a global rule"
 * (06.20) and "sources already mute it" (07.14). With `edit`, the same form
 * changes an existing rule (07.16).
 */
export function AddRuleDialog({
  open,
  onOpenChange,
  source,
  scope: initialScope,
  lockScope = false,
  canGlobal,
  edit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The source being edited; `null` from Settings (global only). */
  source: string | null
  scope: MuteScope
  /** Settings → Add global rule: no Where switch. */
  lockScope?: boolean
  canGlobal: boolean
  edit?: MuteRule
}) {
  // 07.16: a global rule is edited in a side panel with its hits by source.
  if (edit?.scope === 'global')
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent width={520} aria-describedby={undefined}>
          {open && (
            <Form
              source={source}
              initialScope="global"
              lockScope
              canGlobal={canGlobal}
              edit={edit}
              sheet
              onDone={() => onOpenChange(false)}
            />
          )}
        </SheetContent>
      </Sheet>
    )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[600px]" showCloseButton>
        {open && (
          <Form
            source={source}
            initialScope={edit?.scope ?? initialScope}
            lockScope={lockScope || Boolean(edit)}
            canGlobal={canGlobal}
            edit={edit}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Form({
  source,
  initialScope,
  lockScope,
  canGlobal,
  edit,
  sheet = false,
  onDone,
}: {
  source: string | null
  initialScope: MuteScope
  lockScope: boolean
  canGlobal: boolean
  edit?: MuteRule
  /** Laid out as a side panel (07.16) instead of a dialog. */
  sheet?: boolean
  onDone: () => void
}) {
  const id = useId()
  const data = useSettings().data
  const [scope, setScope] = useState<MuteScope>(source ? initialScope : 'global')
  const [d, setD] = useState<Draft>(() => fromRule(edit))
  const [removeSourceRules, setRemoveSourceRules] = useState(false)
  const [force, setForce] = useState(false)
  const add = useAddMuteRule()
  const update = useUpdateMuteRule()
  const del = useDeleteMuteRule()
  const fields = useSourceFields(source ?? '').data
  const set = (p: Partial<Draft>) => {
    setD((x) => ({ ...x, ...p }))
    setForce(false)
  }

  const keepField = edit && (edit.shape === 'route' || edit.shape === 'method_route') ? edit.field : null
  const rule = toRule(d, scope, keepField)
  const debounced = useDebounced(rule, 250)
  const inScope = scope === 'global' || !source ? [] : [source]
  const preview = useMutePreview([debounced], inScope, debounced.value.length > 0)
  const p = rule.value ? preview.data?.[0] : undefined
  const share = shareOf(p)

  // Same rule already there (in this scope), or the same rule on sources (global).
  const own = source ? data?.sources[source] : undefined
  const duplicate =
    scope === 'global'
      ? (data?.muted_global ?? []).some((r) => r.id !== edit?.id && sameRule(r, rule))
      : (own?.muted ?? []).some((r) => r.id !== edit?.id && sameRule(r, rule))
  const sourceCopies = useMemo(
    () =>
      scope === 'global' && rule.value
        ? Object.entries(data?.sources ?? {}).filter(([, s]) => s.muted.some((r) => sameRule(r, rule)))
        : [],
    [scope, rule, data],
  )
  // 06.20: every matching line is already hidden by a global rule applying here.
  const covering = useMemo(() => {
    if (scope !== 'source' || !p || p.total === 0 || p.already_hidden < p.total) return undefined
    const applying = (data?.muted_global ?? []).filter((g) => g.enabled && !globalOff(own, g.id))
    return applying.find((g) => p.samples.every((l) => matchesMute(l, g))) ?? applying[0]
  }, [scope, p, data, own])

  const valid =
    rule.value.length > 0 &&
    (rule.shape !== 'field' || Boolean(rule.field)) &&
    (rule.shape !== 'method_route' || Boolean(rule.method)) &&
    (rule.shape !== 'route' && rule.shape !== 'method_route' ? true : rule.value.startsWith('/'))
  const blocked = !valid || duplicate || (Boolean(covering) && !force)
  const busy = add.isPending || update.isPending

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (blocked || busy) return
    try {
      if (edit) {
        await update.mutateAsync({
          id: edit.id,
          patch: { shape: rule.shape, field: rule.field, value: rule.value, method: rule.method },
        })
        toast.success(`Rule saved · ${ruleText(rule)}`, {
          description: scope === 'global' ? 'Applies to every source that keeps it on.' : `On ${source}.`,
        })
      } else {
        const res = await add.mutateAsync({
          rule,
          source: scope === 'source' ? (source ?? undefined) : undefined,
          remove_source_rules: removeSourceRules,
        })
        const where = res.rule.scope === 'global' ? 'everywhere' : `on ${source}`
        toast.success(`Muted ${ruleTarget(res.rule)} ${where}`, {
          description: `${p ? `${fmtN(p.total)} lines hidden · ` : ''}rule ${ruleText(res.rule)}`,
          duration: 8000,
          button: { title: 'Undo', onClick: () => del.mutate(res.rule.id) },
        })
      }
      onDone()
    } catch (err) {
      toast.error(edit ? 'Could not save the rule' : 'Could not add the rule', {
        description: (err as Error).message,
      })
    }
  }

  const fieldKeys = fields?.fields.map((f) => f.key) ?? []
  const where = scope === 'global' ? 'all sources' : (source ?? '')
  const title = edit
    ? scope === 'global'
      ? 'Edit global rule'
      : 'Edit rule'
    : scope === 'global' && lockScope
      ? 'Add global rule'
      : 'Add rule'
  const stored = rule.value
    ? `stored as ${rule.shape === 'method_route' ? `${rule.method} ${rule.value}` : storedAs(rule)}${covering ? ' · overlaps global' : !edit && scope === 'global' ? ' · scope global' : ''}`
    : ''

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (sheet && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e)
      }}
      className={cn('flex flex-col gap-4', sheet ? 'h-full gap-0' : 'p-5')}
      aria-label={edit ? 'Edit rule' : 'Add rule'}
    >
      {sheet ? (
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
          <DialogTitle className="font-semibold text-lg">{title}</DialogTitle>
          <SheetClose render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" />}>
            <XIcon />
          </SheetClose>
        </div>
      ) : (
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle className="font-semibold text-lg">{title}</DialogTitle>
          <span className="border px-1.5 py-px font-mono text-[11px] text-muted-foreground">
            {scope === 'global' ? 'all sources' : source}
          </span>
        </div>
      )}
      <div className={cn('flex flex-col gap-4', sheet && 'min-h-0 flex-1 overflow-y-auto p-5')}>
        {source && !lockScope && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm">Where</span>
            <Segmented
              label="Where"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'source', label: 'This source', sub: source, icon: <BoxIcon /> },
                {
                  value: 'global',
                  label: 'All sources',
                  sub: 'global',
                  icon: <GlobeIcon />,
                  disabled: !canGlobal,
                  reason: OWNERS_ONLY_GLOBAL,
                },
              ]}
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {!sheet && <span className="text-sm">Hide lines where</span>}
          <Segmented
            label="Rule shape"
            size="sm"
            pack
            value={d.shape === 'text' ? 'field' : (d.shape as Exclude<MuteShape, 'text'>)}
            onChange={(shape) => set({ shape })}
            options={SHAPES}
          />
        </div>

        {(d.shape === 'route' || d.shape === 'method_route') && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-end gap-2">
              {d.shape === 'method_route' && (
                <div className="flex flex-col gap-1.5 text-sm">
                  <span id={`${id}-method`}>Method</span>
                  <Select value={d.method} onValueChange={(v) => v && set({ method: v })}>
                    <SelectTrigger aria-labelledby={`${id}-method`} aria-label="Method" className="h-9 w-24 font-mono">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METHODS.map((m) => (
                        <SelectItem key={m} value={m} className="font-mono">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="relative flex flex-1 flex-col gap-1.5 text-sm">
                <label htmlFor={`${id}-route`}>Route</label>
                <Input
                  id={`${id}-route`}
                  autoFocus
                  value={d.route}
                  onChange={(e) => set({ route: e.target.value })}
                  placeholder="/api/v1/health"
                  className="pr-24 font-mono"
                />
                {d.shape === 'route' && (
                  <span className="pointer-events-none absolute right-2.5 bottom-2.5 font-mono text-[11px] text-muted-foreground">
                    any method
                  </span>
                )}
              </div>
            </div>
            <span className="text-muted-foreground text-xs">
              {d.shape === 'route'
                ? 'Matches every method. ?query and #hash are ignored. * matches the rest of one segment (/api/v1/orders/*).'
                : `Only ${d.method} is hidden. ${METHODS.filter((m) => m !== d.method)
                    .slice(0, 2)
                    .join(', ')} and others on this route still show.`}
            </span>
          </div>
        )}
        {d.shape === 'message' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-msg`} className="text-sm">
              Message
            </label>
            <div className="relative">
              <Input
                id={`${id}-msg`}
                autoFocus
                value={d.message}
                onChange={(e) => set({ message: e.target.value })}
                placeholder="request completed"
                className="pr-14 font-mono"
              />
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
                exact
              </span>
            </div>
            {/* quiet matches messages ignoring case, with * wildcards; the board's "case-sensitive" is not what the server does. */}
            <span className="text-muted-foreground text-xs">
              Whole text of the msg / message field, any case. Lines with extra words still show. * is a wildcard.
            </span>
          </div>
        )}
        {d.shape === 'field' && (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_40px_minmax(0,1.5fr)] items-end gap-2">
              <div className="flex flex-col gap-1.5 text-sm">
                <label htmlFor={`${id}-field`}>Field</label>
                <Input
                  id={`${id}-field`}
                  autoFocus
                  list={`${id}-fields`}
                  value={d.field}
                  onChange={(e) => set({ field: e.target.value })}
                  placeholder="user_agent"
                  className="font-mono [&::-webkit-calendar-picker-indicator]:hidden"
                />
              </div>
              <span className="flex h-9 items-center justify-center border font-mono text-muted-foreground">=</span>
              <div className="flex flex-col gap-1.5 text-sm">
                <label htmlFor={`${id}-value`}>Value</label>
                <Input
                  id={`${id}-value`}
                  value={d.value}
                  onChange={(e) => set({ value: e.target.value })}
                  placeholder="kube-probe/*"
                  className="font-mono"
                />
              </div>
            </div>
            <datalist id={`${id}-fields`}>
              {fieldKeys.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
            <span className="text-muted-foreground text-xs">
              Any field = value. * is a wildcard (user_agent=kube-probe/*).
              {fieldKeys.length > 0 && ' Fields detected on this source autocomplete.'}
            </span>
          </div>
        )}

        {sourceCopies.length > 0 && !edit && (
          <>
            <Warn
              title={`${sourceCopies.length} ${sourceCopies.length === 1 ? 'source already mutes' : 'sources already mute'} this ${SHAPE_NOUN[rule.shape]}`}
            >
              {listNames(sourceCopies.map(([n]) => n))} {sourceCopies.length === 1 ? 'has its' : 'each have their'} own{' '}
              <span className="font-mono">{storedAs(rule)}</span> rule. The global rule covers{' '}
              {sourceCopies.length === 1
                ? 'it; its own rule stays unless you remove it.'
                : 'them; their own rules stay unless you remove them.'}
            </Warn>
            <div className="flex items-center gap-2.5 text-[13px]">
              <Checkbox
                aria-label="Also remove the source rules"
                checked={removeSourceRules}
                onCheckedChange={(v) => setRemoveSourceRules(Boolean(v))}
              />
              Also remove the {sourceCopies.length} source {sourceCopies.length === 1 ? 'rule' : 'rules'}
              <span className="font-mono text-[11px] text-muted-foreground">
                {sourceCopies.map(([n]) => n).join(' · ')}
              </span>
            </div>
          </>
        )}

        {sheet && edit ? (
          <EditImpact rule={edit} draft={rule} preview={p} loading={preview.isFetching} />
        ) : (
          <WillHide
            preview={p}
            loading={preview.isFetching}
            scope={scope}
            where={where}
            empty={!rule.value}
            warn={Boolean(p && share > WARN_SHARE)}
            method={rule.shape === 'method_route' ? (rule.method ?? undefined) : undefined}
            rule={rule}
            copies={sourceCopies.map(([n]) => n)}
          />
        )}

        {p && share > WARN_SHARE && (
          <Warn title={`Hides ${fmtShare(share)} of ${scope === 'global' ? 'all lines' : source}`}>
            {rule.shape === 'field' && rule.field === 'level'
              ? `${rule.value.charAt(0).toUpperCase()}${rule.value.slice(1)} lines are`
              : 'That is'}{' '}
            a big share of {scope === 'global' ? 'what quiet receives' : 'this source'}. Consider a level filter in the
            stream instead, or narrow the rule
            {rule.shape === 'field' && rule.field === 'level' ? ` (level=${rule.value} + msg)` : ''}.
          </Warn>
        )}
        {covering && (
          <Warn
            title={
              <span className="flex items-center gap-3">
                Already hidden by a global rule
                <Link
                  to="/settings/muted-lines"
                  className="inline-flex items-center gap-1 font-normal text-xs hover:underline"
                >
                  View global rule <ArrowUpRightIcon className="size-3" />
                </Link>
              </span>
            }
          >
            Global rule <span className="font-mono">{ruleText(covering)}</span> hides every line this would, so it hides
            0 more lines. Add anyway: it takes over if the global rule is switched off here.
          </Warn>
        )}
        {duplicate && (
          <p role="alert" className="text-status-err text-xs">
            {scope === 'global' ? 'There is already a global rule like this.' : `${source} already has this rule.`}
          </p>
        )}
      </div>
      <div className={cn('flex items-center gap-2', sheet ? 'shrink-0 border-t px-5 py-3' : 'pt-1')}>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{stored}</span>
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {covering && !force ? (
          <Button type="button" variant="outline" onClick={() => setForce(true)}>
            Add anyway
          </Button>
        ) : (
          <Button type="submit" disabled={blocked || busy}>
            {edit ? 'Save rule' : scope === 'global' ? 'Add global rule' : 'Add rule'}
            {sheet ? (
              <KbdGroup className="ml-1">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
            ) : (
              <CornerDownLeftIcon className="opacity-60" />
            )}
          </Button>
        )}
      </div>
    </form>
  )
}

/** The live "Will hide" box (06.14, 07.13). */
export function WillHide({
  preview: p,
  loading,
  scope,
  where,
  empty,
  warn = false,
  method,
  rule,
  copies = [],
}: {
  /** The draft, for the global summary's `path:/readyz · any method · new sources too`. */
  rule?: MuteRule
  /** Sources with their own copy of this rule (07.14): their lines are already hidden. */
  copies?: string[]
  preview: import('@/gen').MutePreview | undefined
  loading: boolean
  scope: MuteScope
  where: string
  empty: boolean
  /** A big share: the total is drawn in amber (06.17). */
  warn?: boolean
  /** A method + route rule: `GET only · HEAD 14 stay visible` (06.15). */
  method?: string
}) {
  const all = useSources().data ?? []
  const hit = p ? Object.keys(p.per_source).filter((s) => p.per_source[s] > 0) : []
  const zero = all.map((s) => s.name).filter((n) => !hit.includes(n))
  const fresh = p ? hit.filter((s) => !copies.includes(s)) : []
  const newly = p ? Math.max(0, p.total - p.already_hidden) : 0
  return (
    <section aria-label="Will hide" aria-live="polite" className="flex flex-col gap-1.5 bg-muted/40 px-3 py-3">
      <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
        <span>Will hide</span>
        <span className="flex items-center gap-1.5 normal-case tracking-normal">
          <span className={cn('size-1.5 rounded-full', loading ? 'animate-pulse bg-status-warn' : 'bg-status-ok')} />
          live preview · last 24h
        </span>
      </div>
      {empty ? (
        <span className="text-muted-foreground text-xs">Type a rule to see what it hides.</span>
      ) : !p ? (
        <span className="text-muted-foreground text-xs">Counting…</span>
      ) : p.invalid ? (
        <span className="text-muted-foreground text-xs">{p.invalid}</span>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className={cn('font-mono font-semibold text-lg', warn && 'text-status-warn')}>
              {p.estimated ? '~' : ''}
              {fmtN(p.total)} lines
            </span>
            <span className="text-muted-foreground text-xs">
              {scope !== 'global'
                ? `${perMinute(p.total)} · ${fmtShare(shareOf(p))} of ${where}`
                : copies.length > 0 && p.already_hidden > 0
                  ? `on ${hit.length} ${hit.length === 1 ? 'source' : 'sources'} · ${fmtN(p.already_hidden)} already hidden by source rules`
                  : `on ${hit.length} of ${Math.max(all.length, hit.length)} sources · ${perMinute(p.total)}`}
            </span>
          </div>
          {scope === 'global' && rule && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {copies.length > 0 && p.already_hidden > 0
                ? `+${fmtN(newly)} newly hidden${fresh.length ? ` · ${fresh.map((s) => `${s} ${fmtN(p.per_source[s])}`).join(' · ')}` : ''}`
                : [
                    storedAs(rule),
                    rule.shape === 'route'
                      ? 'any method'
                      : rule.shape === 'method_route'
                        ? `${rule.method} only`
                        : null,
                    'new sources too',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          )}
          {scope === 'global' ? (
            Object.keys(p.per_source).length > 0 && (
              <SourceBars
                per={p.per_source}
                names={Object.keys(p.per_source)
                  .sort((a, b) => p.per_source[b] - p.per_source[a])
                  .slice(0, 6)}
              />
            )
          ) : (
            <MethodSplit p={p} method={method} />
          )}
          {scope !== 'global' && p.samples.map((l) => <SampleLine key={l.id} line={l} />)}
          {scope === 'global' && zero.length > 0 && !(copies.length > 0 && p.already_hidden > 0) && (
            <span className="font-mono text-[11px] text-muted-foreground">{zero.join(', ')}: 0 matches</span>
          )}
        </>
      )}
    </section>
  )
}

const SHAPE_NOUN: Record<MuteShape, string> = {
  route: 'route',
  method_route: 'route',
  message: 'message',
  field: 'field value',
  text: 'text',
}

/** `a`, `a and b`, `a, b and c`. */
function listNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * 07.16: what saving the edit changes, `2,806 → 2,790 hidden · 24h −16 · …`,
 * then hits by source for the edited rule (sources that switched it off show
 * what it would hide).
 */
function EditImpact({
  rule,
  draft,
  preview: p,
  loading,
}: {
  rule: MuteRule
  draft: MuteRule
  preview: import('@/gen').MutePreview | undefined
  loading: boolean
}) {
  const data = useSettings().data
  const stats = useMuteStats().data
  const off = new Map(offOn(data, rule.id))
  const before = ruleHits(stats, rule.id)
  const after = p && !p.invalid ? p.per_source : before
  const count = (h: Record<string, number>) => sumHits(h, (s) => !off.has(s))
  const was = rule.enabled ? count(before) : 0
  const now = rule.enabled ? count(after) : 0
  const delta = now - was
  const moved = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((s) => !off.has(s))
    .map((s) => [s, (after[s] ?? 0) - (before[s] ?? 0)] as const)
    .filter(([, d]) => d !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  const changed = !sameRule(rule, draft)
  return (
    <>
      <p aria-live="polite" className="font-mono text-xs">
        {fmtN(was)} → {loading && changed ? '…' : fmtN(now)} hidden · 24h
        {changed && delta !== 0 && moved[0] && (
          <span className="text-status-warn">
            {' '}
            {delta > 0 ? '+' : '−'}
            {fmtN(Math.abs(delta))} · {fmtN(Math.abs(moved[0][1]))} on {moved[0][0]}{' '}
            {moved[0][1] < 0 ? 'show again' : 'newly hidden'}
            {moved.length > 1 && ` · ${moved.length - 1} more ${moved.length === 2 ? 'source' : 'sources'}`}
          </span>
        )}
      </p>
      <HitsBySource hits={after} off={off} />
    </>
  )
}
