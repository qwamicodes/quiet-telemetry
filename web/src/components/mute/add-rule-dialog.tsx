import { GlobeIcon, BoxIcon, CornerDownLeftIcon, InfoIcon } from 'lucide-react'
import { type FormEvent, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { MuteRule, MuteScope, MuteShape } from '@/gen'
import { useAddMuteRule, useDeleteMuteRule, useMutePreview, useUpdateMuteRule } from '@/lib/mute-api'
import { draftRule, globalOff, matchesMute, routePath, ruleText, ruleTarget, sameRule, storedAs } from '@/lib/mute'
import { useSettings } from '@/lib/settings-api'
import { useSourceFields } from '@/lib/stream-api'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounced'
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

const SHAPES: { value: Exclude<MuteShape, 'text'>; label: string }[] = [
  { value: 'route', label: 'Route' },
  { value: 'method_route', label: 'Method + route' },
  { value: 'message', label: 'Exact message' },
  { value: 'field', label: 'Field rule' },
]
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

interface Draft {
  shape: MuteShape
  route: string
  method: string
  message: string
  field: string
  value: string
}

function fromRule(r?: MuteRule): Draft {
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

function toRule(d: Draft, scope: MuteScope, keepField: string | null): MuteRule {
  switch (d.shape) {
    case 'route':
      return draftRule('route', routePath(d.route), { scope, field: keepField })
    case 'method_route':
      return draftRule('method_route', routePath(d.route), { scope, field: keepField, method: d.method })
    case 'message':
      return draftRule('message', d.message.trim().replace(/^msg:/, '').replace(/^"(.*)"$/, '$1'), { scope })
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
  onDone,
}: {
  source: string | null
  initialScope: MuteScope
  lockScope: boolean
  canGlobal: boolean
  edit?: MuteRule
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

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-5" aria-label={edit ? 'Edit rule' : 'Add rule'}>
      <div className="flex items-center gap-2 pr-8">
        <DialogTitle className="font-semibold text-lg">
          {edit ? (scope === 'global' ? 'Edit global rule' : 'Edit rule') : scope === 'global' && lockScope ? 'Add global rule' : 'Add rule'}
        </DialogTitle>
        <span className="border px-1.5 py-px font-mono text-[11px] text-muted-foreground">
          {scope === 'global' ? 'global' : source}
        </span>
      </div>

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
        <span className="text-sm">Hide lines where</span>
        <Segmented
          label="Rule shape"
          size="sm"
          value={d.shape === 'text' ? 'field' : (d.shape as Exclude<MuteShape, 'text'>)}
          onChange={(shape) => set({ shape })}
          options={SHAPES}
        />
      </div>

      {(d.shape === 'route' || d.shape === 'method_route') && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-route`} className="text-sm">
            Route
          </label>
          <div className="flex gap-2">
            {d.shape === 'method_route' && (
              <select
                aria-label="Method"
                value={d.method}
                onChange={(e) => set({ method: e.target.value })}
                className="h-9 border bg-transparent px-2 font-mono text-sm"
              >
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            )}
            <div className="relative flex-1">
              <Input
                id={`${id}-route`}
                autoFocus
                value={d.route}
                onChange={(e) => set({ route: e.target.value })}
                placeholder="/api/v1/health"
                className="pr-24 font-mono"
              />
              {d.shape === 'route' && (
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
                  any method
                </span>
              )}
            </div>
          </div>
          <span className="text-muted-foreground text-xs">
            {d.shape === 'route' ? 'Matches every method. ' : `Only ${d.method} requests. `}?query and #hash are ignored. *
            matches the rest of one segment (/api/v1/orders/*).
          </span>
        </div>
      )}
      {d.shape === 'message' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-msg`} className="text-sm">
            Message
          </label>
          <Input
            id={`${id}-msg`}
            autoFocus
            value={d.message}
            onChange={(e) => set({ message: e.target.value })}
            placeholder="request completed"
            className="font-mono"
          />
          <span className="text-muted-foreground text-xs">
            The whole message (msg or message), any case. * is a wildcard.
          </span>
        </div>
      )}
      {d.shape === 'field' && (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_40px_minmax(0,1.5fr)] items-end gap-2">
            <label className="flex flex-col gap-1.5 text-sm">
              Field
              <Input
                autoFocus
                list={`${id}-fields`}
                value={d.field}
                onChange={(e) => set({ field: e.target.value })}
                placeholder="user_agent"
                className="font-mono"
              />
            </label>
            <span className="flex h-9 items-center justify-center border font-mono text-muted-foreground">=</span>
            <label className="flex flex-col gap-1.5 text-sm">
              Value
              <Input
                value={d.value}
                onChange={(e) => set({ value: e.target.value })}
                placeholder="kube-probe/*"
                className="font-mono"
              />
            </label>
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

      <WillHide preview={p} loading={preview.isFetching} scope={scope} where={where} empty={!rule.value} />

      {p && share > WARN_SHARE && (
        <Warn title={`Hides ${fmtShare(share)} of ${scope === 'global' ? 'all lines' : source}`}>
          That is a big share of {scope === 'global' ? 'what quiet receives' : 'this source'}. Consider a level filter in
          the stream instead, or narrow the rule.
        </Warn>
      )}
      {covering && (
        <Warn title="Already hidden by a global rule · 0 more lines">
          Global rule <span className="font-mono">{ruleText(covering)}</span> hides every line this would. Add anyway: it
          takes over if the global rule is switched off here.
        </Warn>
      )}
      {duplicate && (
        <p role="alert" className="text-status-err text-xs">
          {scope === 'global' ? 'There is already a global rule like this.' : `${source} already has this rule.`}
        </p>
      )}
      {sourceCopies.length > 0 && !edit && (
        <div className="flex flex-col gap-2 border px-3 py-2.5">
          <span className="flex items-center gap-2 text-sm">
            <InfoIcon className="size-3.5 text-muted-foreground" aria-hidden />
            {sourceCopies.length} {sourceCopies.length === 1 ? 'source already mutes' : 'sources already mute'} it:{' '}
            <span className="font-mono text-muted-foreground text-xs">{sourceCopies.map(([n]) => n).join(', ')}</span>
          </span>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={removeSourceRules} onCheckedChange={(v) => setRemoveSourceRules(Boolean(v))} />
            Also remove the {sourceCopies.length} source {sourceCopies.length === 1 ? 'rule' : 'rules'} (the global rule
            covers them)
          </label>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {rule.value ? `stored as ${storedAs(rule)}` : ''}
        </span>
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
            <CornerDownLeftIcon className="opacity-60" />
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
}: {
  preview: import('@/gen').MutePreview | undefined
  loading: boolean
  scope: MuteScope
  where: string
  empty: boolean
}) {
  return (
    <section aria-label="Will hide" aria-live="polite" className="flex flex-col gap-1.5 bg-muted/40 px-3 py-3">
      <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
        <span>Will hide</span>
        <span className="flex items-center gap-1.5 normal-case tracking-normal">
          <span className={loading ? 'size-1.5 animate-pulse bg-status-warn' : 'size-1.5 bg-status-ok'} />
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
            <span className="font-mono font-semibold text-lg">
              {p.estimated ? '~' : ''}
              {fmtN(p.total)} lines
            </span>
            <span className="text-muted-foreground text-xs">
              {perMinute(p.total)} · {fmtShare(shareOf(p))} of {where}
              {scope === 'global' ? ` · on ${Object.keys(p.per_source).length} sources` : ''}
            </span>
          </div>
          {scope === 'global' ? (
            Object.keys(p.per_source).length > 0 && (
              <SourceBars per={p.per_source} names={Object.keys(p.per_source).sort((a, b) => p.per_source[b] - p.per_source[a]).slice(0, 6)} />
            )
          ) : (
            <MethodSplit p={p} />
          )}
          {p.samples.map((l) => (
            <SampleLine key={l.id} line={l} />
          ))}
          {scope === 'global' && (
            <span className="text-muted-foreground text-xs">New sources get this rule too. Each source can switch it off.</span>
          )}
        </>
      )}
    </section>
  )
}
