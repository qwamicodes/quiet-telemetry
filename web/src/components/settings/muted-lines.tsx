import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRightIcon, ExternalLinkIcon, InfoIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { AddRuleDialog } from '@/components/mute/add-rule-dialog'
import {
  fmtDay,
  fmtN,
  GlobalTag,
  Meta,
  OWNERS_ONLY,
  Pattern,
  ShapeChip,
  OriginNote,
} from '@/components/mute/rule-bits'
import { PageHeader, ReadOnlyNote, SettingRow } from '@/components/settings/kit'
import { StatusDot } from '@/components/status-dot'
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
import type { MuteRule, SettingsResponse } from '@/gen'
import { useSources } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { kindLabel } from '@/lib/connect'
import { isRecent } from '@/lib/format'
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
import { globalOff, ruleText } from '@/lib/mute'
import { useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'

/** Sources that switched a global rule off ("Don't apply here"), with who and when. */
function offOn(data: SettingsResponse | undefined, id: string) {
  return Object.entries(data?.sources ?? {})
    .map(([name, s]) => [name, globalOff(s, id)] as const)
    .filter((x): x is readonly [string, NonNullable<ReturnType<typeof globalOff>>] => Boolean(x[1]))
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

  const hiddenBy = (r: MuteRule) => {
    const off = new Set(offOn(data, r.id).map(([n]) => n))
    const h = ruleHits(stats, r.id)
    return { n: r.enabled ? sumHits(h, (s) => !off.has(s)) : 0, sources: Object.keys(h).filter((s) => !off.has(s)).length }
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
    <div className="max-w-4xl">
      <PageHeader
        title="Muted lines"
        sub="Global rules hide matching lines on every source, including new ones."
        aside={
          owner ? (
            <span className="flex items-center gap-2">
              <span className="border px-1.5 py-px">owner</span>
              <Button size="sm" onClick={() => setAdding(true)}>
                <PlusIcon /> Add global rule
              </Button>
            </span>
          ) : undefined
        }
      />
      {!owner && <ReadOnlyNote />}
      <div className="mt-3 flex gap-2.5 border border-brand/40 bg-brand/5 px-4 py-3">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-sm">How rules combine</span>
          <span className="text-muted-foreground text-xs">
            A line is hidden when any rule matches: global rules plus that source's own rules. A source can switch a
            global rule off for itself (Sources → edit → Muted lines → Don't apply here). Muted lines are still stored;
            Show muted brings them back.
          </span>
        </div>
      </div>

      {global.length === 0 ? (
        <div className="mt-4 flex flex-col items-start gap-2 border border-dashed px-5 py-6" data-testid="muted-empty">
          <span className="font-medium">No global rules yet</span>
          <span className="text-muted-foreground text-xs">
            Mute a health check or a probe once for every source: add a rule here, or pick All sources in a stream row's
            Mute menu. {perSourceRules > 0 && `${perSourceRules} per-source rules hide lines on ${perSource.length} sources.`}
          </span>
          {owner && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon /> Add global rule
            </Button>
          )}
        </div>
      ) : (
        <table className="mt-4 w-full border text-sm" aria-label="Global rules">
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
                    <button type="button" className="flex min-w-0 flex-col gap-1 text-left" onClick={() => setDetail(r.id)}>
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
                    <Switch
                      aria-label={`${r.enabled ? 'Pause' : 'Resume'} ${ruleText(r)}`}
                      checked={r.enabled}
                      disabled={!owner || update.isPending}
                      title={owner ? undefined : OWNERS_ONLY}
                      onCheckedChange={(v) => toggle(r, Boolean(v))}
                    />
                  </td>
                  <td className="pr-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${ruleText(r)}`} />}>
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
                    <Link to="/sources" className="inline-flex items-center gap-1 text-foreground text-xs hover:underline">
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
      <DeleteGlobal rule={deleting} onClose={() => setDeleting(null)} hidden={deleting ? hiddenBy(deleting) : undefined} />
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
          <DialogTitle>Delete for all sources?</DialogTitle>
          <DialogDescription>
            {rule && <span className="font-mono">{ruleText(rule)}</span>} hides {fmtN(hidden?.n ?? 0)} lines a day on{' '}
            {hidden?.sources ?? 0} sources. Deleting it shows them again everywhere, and sources that switched it off
            lose that switch. Source rules stay.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={go} disabled={del.isPending}>
            <Trash2Icon /> Delete for all sources
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
  names.sort((a, b) => (hits[b] ?? 0) - (hits[a] ?? 0) || a.localeCompare(b))
  const hidden = rule?.enabled ? sumHits(hits, (s) => !offSet.has(s)) : 0
  const hitOn = Object.keys(hits).filter((s) => !offSet.has(s)).length
  const max = Math.max(1, ...Object.values(hits))
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
              <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                <span className="uppercase tracking-[0.06em]">Hits by source · 24h</span>
                <span>{names.length} sources</span>
              </div>
              <ul className="flex flex-col divide-y border-y" aria-label="Hits by source">
                {names.map((n) => {
                  const info = sources?.find((s) => s.name === n)
                  const o = offSet.get(n)
                  const c = hits[n] ?? 0
                  return (
                    <li key={n} className="flex flex-col gap-0.5 py-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_72px_64px_auto_72px] items-center gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <StatusDot status={info && isRecent(info.last_ts) ? 'ok' : 'idle'} />
                          <span className="truncate">{n}</span>
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {info ? kindLabel(info.kind) : ''}
                        </span>
                        <span className="h-1.5 bg-muted">
                          <span
                            className={o ? 'block h-full bg-muted-foreground' : 'block h-full bg-brand'}
                            style={{ width: `${Math.round((c / max) * 100)}%` }}
                          />
                        </span>
                        <span className="text-right font-mono tabular-nums">
                          {o ? `would hide ${fmtN(c)}` : fmtN(c)}
                        </span>
                        <span className={o ? 'text-right font-mono text-[11px] text-status-warn' : 'text-right font-mono text-[11px] text-muted-foreground'}>
                          {o ? 'off here' : 'applies'}
                        </span>
                      </div>
                      {o && (
                        <span className="pl-4 font-mono text-[11px] text-muted-foreground">
                          Don't apply here{o.by ? ` · ${o.by}` : ''}
                          {o.at ? ` · ${fmtDay(o.at)}` : ''}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="text-muted-foreground text-xs">
                Turning a rule off here is per source: owners do it from Sources → edit → Muted lines. New sources get
                every global rule.
              </p>
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

/** 07.20: the instance default for Include muted lines in search (moved here from General). */
function IncludeDefault({ owner }: { owner: boolean }) {
  const ms = useSettings().data?.muted_search
  const save = useSaveMutedSearch()
  if (!ms) return null
  const set = (v: boolean | null) =>
    save.mutate(v, { onError: (e) => toast.error('Could not save', { description: e.message }) })
  return (
    <div className="mt-6">
      <SettingRow
        label="Include muted lines in search"
        hint={
          <>
            Instance default. Sources inherit it and can override (Inherit / On / Off). Show muted in Search includes
            them for one query. Moved here from General.
            <br />
            <span className="font-mono text-[11px]">Precedence: Show muted (one search) → source setting → this default</span>
          </>
        }
        under={
          ms.origin === 'setting' && owner ? (
            <button type="button" className="text-brand hover:underline" onClick={() => set(null)}>
              use server default ({ms.flag ? 'on' : 'off'})
            </button>
          ) : ms.origin === 'flag' ? (
            `QUIET_SEARCH_INCLUDE_MUTED · ${ms.flag ? 'on' : 'off'}`
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
    </div>
  )
}
