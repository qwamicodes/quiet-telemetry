import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { AddRuleDialog } from '@/components/mute/add-rule-dialog'
import { HitsBySource, offOn } from '@/components/mute/hits-by-source'
import { fmtDay, fmtN, GlobalTag, Meta, OriginNote, OWNERS_ONLY, Pattern, ShapeChip } from '@/components/mute/rule-bits'
import { PageHeader, SettingRow } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import type { MuteRule } from '@/gen'
import { useSources } from '@/lib/api'
import { isOwner, useMe, useMembers } from '@/lib/auth-api'
import { ruleText } from '@/lib/mute'
import {
  restoreOf,
  ruleHits,
  sumHits,
  useAddMuteRule,
  useDeleteMuteRule,
  useMuteStats,
  useSaveMutedSearch,
  useUpdateMuteRule,
} from '@/lib/mute-api'
import { useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 flex gap-2.5 border border-brand/40 bg-brand/5 px-4 py-3">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-sm">{title}</span>
        <span className="text-muted-foreground text-xs">{children}</span>
      </div>
    </div>
  )
}

/** Search query that brings a rule's lines back (`muted=include`). */
function searchQueryOf(r: MuteRule): string {
  switch (r.shape) {
    case 'route':
    case 'method_route':
      return `${r.field ?? 'path'}:${r.value}${r.method ? ` method:${r.method}` : ''}`
    case 'message':
      return `"${r.value}"`
    case 'field':
      return r.field ? `${r.field}:${r.value}` : `"${r.value}"`
    default:
      return `"${r.value}"`
  }
}

/**
 * Settings → Muted lines (07.12–07.20): global rules hide matching lines on
 * every source, including new ones; each source can switch one off for itself.
 * The instance Include muted lines in search default lives here (07.20).
 */
export function MutedLinesSettings() {
  const owner = isOwner(useMe())
  const data = useSettings().data
  const stats = useMuteStats().data
  const global = data?.muted_global ?? []
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<MuteRule | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<MuteRule | null>(null)
  const update = useUpdateMuteRule()
  const owners = (useMembers().data?.members ?? []).filter((m) => m.role === 'owner').map((m) => m.name.split(' ')[0])

  const hiddenBy = (r: MuteRule) => {
    const off = new Set(offOn(data, r.id).map(([n]) => n))
    const h = ruleHits(stats, r.id)
    return {
      n: r.enabled ? sumHits(h, (s) => !off.has(s)) : 0,
      sources: Object.keys(h).filter((s) => !off.has(s)).length,
    }
  }
  const total = global.reduce((n, r) => n + hiddenBy(r).n, 0)
  const perSource = Object.values(data?.sources ?? {}).filter((s) => s.muted.length > 0)
  const perSourceRules = perSource.reduce((n, s) => n + s.muted.length, 0)
  const toggle = (r: MuteRule, on: boolean) =>
    update.mutate(
      { id: r.id, patch: { enabled: on } },
      {
        onSuccess: () =>
          toast.success(on ? `Global rule on · ${ruleText(r)}` : `Global rule paused · ${ruleText(r)}`, {
            description: on ? 'Hides its lines on every source that keeps it on.' : 'Paused on every source.',
            button: { title: 'Undo', onClick: () => update.mutate({ id: r.id, patch: { enabled: !on } }) },
          }),
        onError: (e) => toast.error('Could not change the rule', { description: e.message }),
      },
    )

  return (
    <div className="max-w-190">
      <PageHeader
        title="Muted lines"
        sub="Global rules hide matching lines on every source, including new ones."
        aside={
          <>
            <span className="border px-1.5 py-px font-mono text-[11px] text-muted-foreground">
              {owner ? 'owner' : 'member'}
            </span>
            {owner ? (
              <Button onClick={() => setAdding(true)}>
                <PlusIcon /> Add global rule
              </Button>
            ) : (
              <Button disabled title={OWNERS_ONLY}>
                <LockIcon /> Add rule
              </Button>
            )}
          </>
        }
      />
      {owner ? (
        <Callout title="How rules combine">
          A line is hidden when any rule matches: global rules plus that source's own rules. A source can switch a
          global rule off for itself (Sources → edit → Muted lines → Don't apply here). Muted lines are still stored;
          Show muted brings them back.
        </Callout>
      ) : (
        <Callout title="Only owners can edit muted lines">
          You can see every global rule and where it applies. Ask an owner
          {owners.length ? ` (${owners.join(', ')})` : ''} to change one.
        </Callout>
      )}

      {global.length === 0 ? (
        <div
          className="mt-4 flex flex-col items-center gap-3 border border-dashed px-6 py-10 text-center"
          data-testid="muted-empty"
        >
          <span className="flex size-8 items-center justify-center border bg-secondary text-muted-foreground">
            <GlobeIcon className="size-3.5" />
          </span>
          <span className="font-semibold text-sm">No global rules yet</span>
          <span className="max-w-115 text-muted-foreground text-xs leading-[18px]">
            A global rule hides matching lines on every source, like health checks or /metrics scrapes that every
            service gets. Add one here, or from any stream row: Mute ▾ → All sources.
          </span>
          <span className="flex items-center gap-2">
            {owner && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <PlusIcon /> Add global rule
              </Button>
            )}
            <Button size="sm" variant="ghost" render={<Link to="/" />}>
              Open stream <ArrowRightIcon />
            </Button>
          </span>
          {perSourceRules > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {perSourceRules} per-source {perSourceRules === 1 ? 'rule' : 'rules'} on {perSource.length}{' '}
              {perSource.length === 1 ? 'source' : 'sources'} keep working
            </span>
          )}
        </div>
      ) : (
        <table className="mt-4 w-full border bg-card text-sm" aria-label="Global rules">
          <thead className="border-b font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            <tr>
              <th className="px-3 py-2 text-left font-normal">Rule</th>
              <th className="px-3 py-2 text-right font-normal">Hidden · 24h</th>
              <th className="px-3 py-2 text-left font-normal">Added</th>
              <th className="px-3 py-2 text-left font-normal">On</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {global.map((r) => {
              const off = offOn(data, r.id)
              const h = hiddenBy(r)
              return (
                <tr key={r.id} className="border-b hover:bg-muted/30" data-rule={r.id}>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-col gap-1 text-left"
                      onClick={() => setDetail(r.id)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ShapeChip shape={r.shape} />
                        <Pattern rule={r} />
                      </span>
                      <Meta className={off.length ? 'text-status-warn' : undefined}>
                        <span>{r.enabled ? (off.length ? 'all sources' : 'applies to all sources') : 'paused'}</span>
                        {off.length > 0 && <span>off on {off.map(([n]) => n).join(', ')}</span>}
                      </Meta>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="font-mono tabular-nums">{fmtN(h.n)}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">on {h.sources} sources</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-xs">
                      {r.created_by ?? '—'} · {fmtDay(r.created_at)}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      <OriginNote rule={r} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {owner ? (
                      <Switch
                        aria-label={`${r.enabled ? 'Pause' : 'Resume'} ${ruleText(r)}`}
                        checked={r.enabled}
                        disabled={update.isPending}
                        onCheckedChange={(v) => toggle(r, Boolean(v))}
                      />
                    ) : (
                      <span className="font-mono text-[11px] text-muted-foreground">{r.enabled ? 'on' : 'paused'}</span>
                    )}
                  </td>
                  <td className="pr-2">
                    {owner && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${ruleText(r)}`} />}
                        >
                          <MoreHorizontalIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setDetail(r.id)}>Hits by source</DropdownMenuItem>
                          {owner && <DropdownMenuItem onClick={() => setEditing(r)}>Edit</DropdownMenuItem>}
                          {owner && (
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(r)}>
                              Delete for all sources
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="px-3 py-2">
                <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                  <span>
                    {global.length} global {global.length === 1 ? 'rule' : 'rules'} · {fmtN(total)} lines hidden · 24h
                  </span>
                  <span className="flex items-center gap-3">
                    Per-source rules: {perSourceRules} on {perSource.length} sources
                    <Link
                      to="/sources"
                      className="inline-flex items-center gap-1 text-foreground text-xs hover:underline"
                    >
                      Sources <ArrowRightIcon className="size-3" />
                    </Link>
                  </span>
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      <IncludeDefault owner={owner} />

      <AddRuleDialog open={adding} onOpenChange={setAdding} source={null} scope="global" lockScope canGlobal={owner} />
      <AddRuleDialog
        open={editing != null}
        onOpenChange={(o) => !o && setEditing(null)}
        source={null}
        scope="global"
        lockScope
        canGlobal={owner}
        edit={editing ?? undefined}
      />
      <RuleDetail
        id={detail}
        owner={owner}
        onClose={() => setDetail(null)}
        onEdit={(r) => {
          setDetail(null)
          setEditing(r)
        }}
        onDelete={(r) => {
          setDetail(null)
          setDeleting(r)
        }}
      />
      <DeleteGlobal
        rule={deleting}
        onClose={() => setDeleting(null)}
        hidden={deleting ? hiddenBy(deleting) : undefined}
      />
    </div>
  )
}

/** 07.19: global deletes always confirm. */
function DeleteGlobal({
  rule,
  onClose,
  hidden,
}: {
  rule: MuteRule | null
  onClose: () => void
  hidden?: { n: number; sources: number }
}) {
  const del = useDeleteMuteRule()
  const add = useAddMuteRule()
  const data = useSettings().data
  const stats = useMuteStats().data
  const off = new Set(rule ? offOn(data, rule.id).map(([n]) => n) : [])
  const perSource = rule
    ? Object.entries(ruleHits(stats, rule.id))
        .filter(([n, c]) => c > 0 && !off.has(n))
        .sort((a, b) => b[1] - a[1])
    : []
  // Sources with their own rule on the same pattern keep hiding these lines.
  const same = rule
    ? Object.entries(data?.sources ?? {})
        .filter(([, src]) => src.muted.some((m) => m.shape === rule.shape && m.value === rule.value))
        .map(([n]) => n)
    : []
  const go = async () => {
    if (!rule) return
    try {
      const d = await del.mutateAsync(rule.id)
      onClose()
      toast.success(`Deleted global rule ${ruleText(rule)}`, {
        description: `${fmtN(hidden?.n ?? 0)} lines show again on ${hidden?.sources ?? 0} sources.`,
        duration: 8000,
        button: { title: 'Undo', onClick: () => add.mutate(restoreOf(d)) },
      })
    } catch (e) {
      toast.error('Could not delete the rule', { description: (e as Error).message })
    }
  }
  return (
    <Dialog open={rule != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete global rule?</DialogTitle>
          {rule && <span className="font-mono text-brand text-xs">{ruleText(rule)}</span>}
          <DialogDescription>
            About {fmtN(hidden?.n ?? 0)} lines a day come back on {hidden?.sources ?? 0}{' '}
            {hidden?.sources === 1 ? 'source' : 'sources'}
            {perSource.length > 0 && ` (${perSource.map(([n, c]) => `${n} ${fmtN(c)}`).join(' · ')})`}. Lines are not
            deleted, and each source keeps its own rules.
          </DialogDescription>
        </DialogHeader>
        {rule && same.length === 0 && (
          <div className="flex gap-2.5 border border-brand/40 bg-brand/5 px-3 py-2.5">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-sm">No source has its own {rule.value} rule</span>
              <span className="text-muted-foreground text-xs">Nothing else will hide these lines after this.</span>
            </span>
          </div>
        )}
        {rule && same.length > 0 && (
          <div className="flex gap-2.5 border px-3 py-2.5">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground text-xs">
              {same.join(', ')} {same.length === 1 ? 'keeps its' : 'keep their'} own {rule.value} rule.
            </span>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={go} disabled={del.isPending}>
            Delete for all sources
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 07.15: one global rule, its hits by source and where it is switched off. */
function RuleDetail({
  id,
  owner,
  onClose,
  onEdit,
  onDelete,
}: {
  id: string | null
  owner: boolean
  onClose: () => void
  onEdit: (r: MuteRule) => void
  onDelete: (r: MuteRule) => void
}) {
  const data = useSettings().data
  const stats = useMuteStats().data
  const sources = useSources().data
  const update = useUpdateMuteRule()
  const navigate = useNavigate()
  const rule = (data?.muted_global ?? []).find((r) => r.id === id)
  const off = rule ? offOn(data, rule.id) : []
  const offSet = new Map(off)
  const hits = rule ? ruleHits(stats, rule.id) : {}
  const names = Array.from(new Set([...(sources ?? []).map((s) => s.name), ...Object.keys(hits)]))
  const hidden = rule?.enabled ? sumHits(hits, (s) => !offSet.has(s)) : 0
  const hitOn = Object.keys(hits).filter((s) => !offSet.has(s)).length
  return (
    <Sheet open={rule != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width={520}>
        <SheetHeader title="Global rule" />
        {rule && (
          <>
            <SheetBody className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <GlobalTag />
                <ShapeChip shape={rule.shape} />
                <span className="font-mono text-[11px] text-muted-foreground">applies to all sources</span>
              </div>
              <div className="bg-muted/40 px-3 py-3">
                <Pattern rule={rule} className="text-base" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Hidden · 24h" value={fmtN(hidden)} sub={`on ${hitOn} of ${names.length} sources`} />
                <Stat
                  label="Off on"
                  value={`${off.length} ${off.length === 1 ? 'source' : 'sources'}`}
                  sub={off.map(([n]) => n).join(', ') || 'none'}
                />
                <Stat
                  label="Added"
                  value={fmtDay(rule.created_at)}
                  sub={`${rule.created_by ?? '—'} · ${rule.origin === 'hover' ? 'from hover' : 'manual'}`}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="flex flex-col">
                  <span className="text-sm">Rule on</span>
                  <span className="text-muted-foreground text-xs">Off pauses it on every source.</span>
                </span>
                <Switch
                  aria-label="Rule on"
                  checked={rule.enabled}
                  disabled={!owner || update.isPending}
                  onCheckedChange={(v) => update.mutate({ id: rule.id, patch: { enabled: Boolean(v) } })}
                />
              </div>
              <HitsBySource hits={hits} off={offSet} />
            </SheetBody>
            <SheetFooter>
              {owner && (
                <Button variant="destructive" onClick={() => onDelete(rule)}>
                  <Trash2Icon /> Delete rule
                </Button>
              )}
              <span className="flex-1" />
              <Button
                variant="ghost"
                onClick={() => navigate({ to: '/search', search: { q: searchQueryOf(rule), muted: 'include' } })}
              >
                Search muted lines <ExternalLinkIcon />
              </Button>
              {owner && (
                <Button variant="outline" onClick={() => onEdit(rule)}>
                  <PencilIcon /> Edit
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border px-3 py-2.5">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{label}</span>
      <span className="font-mono text-xl">{value}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground" title={sub}>
        {sub}
      </span>
    </div>
  )
}

/** 07.20: the instance default for Include muted lines in search, and which setting wins. */
function IncludeDefault({ owner }: { owner: boolean }) {
  const data = useSettings().data
  const sources = useSources().data
  const ms = data?.muted_search
  const save = useSaveMutedSearch()
  if (!ms) return null
  const set = (v: boolean | null) =>
    save.mutate(v, { onError: (e) => toast.error('Could not save', { description: e.message }) })
  const onOff = (b: boolean) => (b ? 'on' : 'off')
  const names = (sources ?? []).map((s) => s.name)
  const overrides = names
    .map((n) => [n, data?.sources[n]?.search_include_muted ?? null] as const)
    .filter((x): x is readonly [string, boolean] => x[1] != null)
  const inherit = names.length - overrides.length
  return (
    <div className="mt-6 flex flex-col gap-4">
      <SettingRow
        label="Include muted lines in search"
        hint="Instance default. Sources inherit it and can override (Inherit / On / Off). Show muted in Search includes them for one query. Moved here from General."
        under={
          ms.origin === 'setting' && owner ? (
            <button type="button" className="text-brand hover:underline" onClick={() => set(null)}>
              use server default ({onOff(ms.flag)})
            </button>
          ) : ms.origin === 'flag' ? (
            `QUIET_SEARCH_INCLUDE_MUTED · ${onOff(ms.flag)}`
          ) : (
            'default off'
          )
        }
      >
        <Switch
          aria-label="Include muted lines in search"
          checked={ms.include}
          disabled={!owner || save.isPending}
          onCheckedChange={(v) => set(Boolean(v))}
        />
      </SettingRow>
      <section aria-label="Which setting wins" className="flex flex-col gap-3 border bg-card p-4">
        <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          Which setting wins (first that is set)
        </span>
        <ol className="grid grid-cols-3 gap-2">
          {[
            ['Show muted', 'One search. URL muted=include.'],
            ['Source override', 'On or Off on the source’s Muted lines tab.'],
            ['This default', `${ms.include ? 'On' : 'Off'}. Every source on Inherit follows it.`],
          ].map(([title, body], i) => (
            <li key={title} className={cn('flex gap-2.5 border p-2.5', i === 2 && 'border-brand bg-brand/5')}>
              <span className="flex size-5 shrink-0 items-center justify-center border font-mono text-[11px]">
                {i + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-sm">{title}</span>
                <span className="text-muted-foreground text-xs">{body}</span>
              </span>
            </li>
          ))}
        </ol>
        <span className="font-mono text-[11px] text-muted-foreground">
          Now: {inherit} {inherit === 1 ? 'source inherits' : 'sources inherit'} ({onOff(ms.include)})
          {overrides.map(([n, v]) => ` · ${n}: ${onOff(v)}`).join('')}
        </span>
      </section>
    </div>
  )
}
