import { useQueries } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  ArrowRightIcon,
  BoxIcon,
  ChevronsDownUpIcon,
  EllipsisIcon,
  FilterIcon,
  FolderIcon,
  FolderPlusIcon,
  InfoIcon,
  LoaderCircleIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { Fragment, type ReactNode, useRef, useState } from 'react'
import { SourceGroupHeader } from '@/components/source-group-header'
import {
  CustomGroupMenu,
  GroupRulesHint,
  NewGroupDialog,
  RenameGroupDialog,
  SourceMenu,
} from '@/components/sources/custom-groups'
import { Sparkline } from '@/components/sparkline'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import type { CustomGroup, SourceInfo, StreamStats } from '@/gen'
import { useHealth, useSources } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { kindLabel } from '@/lib/connect'
import { fmtAgo, fmtBytes, fmtCount, fmtWindow, isRecent } from '@/lib/format'
import { DEFAULT_SOURCE_SETTINGS, useIgnoreSources, useSettings } from '@/lib/settings-api'
import {
  type GroupFilter,
  groupKey,
  groupOf,
  groupRate,
  groupSources,
  inGroupFilter,
  KIND_TAG,
  movedNote,
  type SourceGroup,
  useCollapsedGroups,
} from '@/lib/source-groups'
import { useCustomGroups } from '@/lib/source-groups-api'
import { streamStatsQuery, useSourceFields, useStreamStats } from '@/lib/stream-api'
import { toast } from '@/lib/toast'
import { useHotkeys } from '@/lib/use-hotkeys'
import { useRates } from '@/lib/use-rates'
import { cn } from '@/lib/utils'

/** Errors at or above this share of a source's lines count as erroring. */
const ERRORING = 0.05

/** Where a source's lines come in: the group header of the "host" grouping. */
export function hostOf(s: SourceInfo): { key: string; title: string; via: string } {
  if (s.kind === 'docker') return { key: 'docker', title: 'this host', via: 'docker.sock' }
  if (s.kind === 'otlp') return { key: 'otlp', title: 'OTLP senders', via: 'otlp/http' }
  return { key: 'http', title: 'HTTP ingest', via: '/ingest' }
}

/** Error share (null until counted), erroring and "stopped" from one source's 24h stats. */
export function statsFlags(stats: StreamStats | undefined) {
  const errors = stats && stats.total > 0 ? stats.levels.error / stats.total : null
  // "Stopped": it sent lines earlier in the hour but nothing in the last 2 minutes.
  const h = stats?.histogram ?? []
  const stopped = h.length > 5 && h.slice(0, -3).some((b) => b.count > 0) && h.slice(-3).every((b) => b.count === 0)
  return { errors, erroring: errors != null && errors >= ERRORING, stopped }
}

/** The 24h error share and last-hour volume of one source, read once per row. */
function useSourceStats(name: string) {
  const stats = useStreamStats(name, undefined).data
  const fields = useSourceFields(name).data
  const top = fields?.ids.slice().sort((a, b) => b.coverage - a.coverage)[0]
  const idKey = fields ? (top && top.coverage > 0 ? top.key : null) : undefined
  return { stats, idKey, ...statsFlags(stats) }
}

const fmtRate = (r: number | undefined) =>
  r == null ? '—' : r === 0 ? '0/s' : `${r < 10 ? r.toFixed(1) : Math.round(r)}/s`

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-1 flex-col gap-1 border bg-card px-4 py-3.5">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{label}</span>
      <span className="font-mono text-2xl">{value}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>
    </div>
  )
}

type Filter = 'all' | 'live' | 'idle' | 'erroring'

function SourceRow({
  s,
  rate,
  nested = false,
  hidden = false,
  menu,
}: {
  s: SourceInfo
  rate: number | undefined
  /** Under a stack group header: indented. */
  nested?: boolean
  hidden?: boolean
  /** The row's ⋯ menu (06.11). */
  menu: ReactNode
}) {
  const { stats, errors, erroring, idKey, stopped } = useSourceStats(s.name)
  const live = isRecent(s.last_ts)
  return (
    <tr
      className={cn(
        'border-b last:border-b-0 hover:bg-row-hover',
        nested ? 'h-9' : 'h-11',
        nested && !live && !stopped && 'text-muted-foreground [&_a]:text-muted-foreground',
      )}
      hidden={hidden}
    >
      <td className={nested ? 'relative pr-4 pl-10' : 'px-4'}>
        {nested && <span aria-hidden className="absolute inset-y-0 left-6 w-px bg-border" />}
        <Link
          to="/sources/$name"
          params={{ name: s.name }}
          className="flex items-center gap-2.5 font-medium text-[13px] outline-none hover:underline"
        >
          <StatusDot status={s.paused ? 'warn' : erroring ? 'err' : live ? 'ok' : 'idle'} />
          {s.display_name ?? s.name}
          {s.paused && <span className="font-mono text-[11px] text-status-warn">paused</span>}
          {s.hidden && <span className="font-mono text-[11px] text-muted-foreground">hidden</span>}
        </Link>
      </td>
      <td>
        <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{kindLabel(s.kind)}</span>
      </td>
      <td>
        <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
          {stats ? <Sparkline buckets={stats.histogram} /> : <span className="h-4 w-24 animate-pulse bg-muted/40" />}
          <span className={cn(stopped && 'text-status-err', !live && !stopped && 'text-muted-foreground')}>
            {live || stopped ? fmtRate(rate) : 'off'}
          </span>
        </span>
      </td>
      <td className={cn('font-mono text-xs', stopped ? 'text-status-warn' : 'text-muted-foreground')}>
        {s.last_ts ? fmtAgo(s.last_ts) : 'never'}
      </td>
      <td className="font-mono text-xs tabular-nums">{fmtCount(stats?.total ?? s.lines)}</td>
      <td>
        {idKey === undefined ? (
          <span className="font-mono text-[11px] text-muted-foreground">…</span>
        ) : idKey ? (
          <span className="bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{idKey}</span>
        ) : (
          <span className="font-mono text-muted-foreground text-xs">none found</span>
        )}
      </td>
      <td className={cn('font-mono text-xs tabular-nums', erroring ? 'text-status-err' : 'text-muted-foreground')}>
        {errors == null ? '—' : fmtPct(errors)}
      </td>
      <td className="pr-3 text-right">{menu}</td>
    </tr>
  )
}

const fmtPct = (v: number) => (v === 0 ? '0%' : v < 0.1 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`)

/** `/sources` — everything that sends lines: receiver kind, rate, last line. */
export function SourcesPage() {
  const sourcesQ = useSources()
  const sources = sourcesQ.data
  const health = useHealth().data
  const rates = useRates(sources)
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const [grouping, setGrouping] = useState<'stack' | 'host' | 'none'>('stack')
  const search = useSearch({ from: '/sources' })
  const navigate = useNavigate({ from: '/sources' })
  const groupFilter: GroupFilter = search.kind ?? 'all'
  const setGroupFilter = (k: GroupFilter) =>
    navigate({ search: (p) => ({ ...p, kind: k === 'all' ? undefined : k }), replace: true })
  const onlyGroup = search.group
  const { isCollapsed, toggle, set: setCollapsed, toggleAll, allCollapsed } = useCollapsedGroups()
  const [ignoring, setIgnoring] = useState<Ignoring | null>(null)
  const custom = useCustomGroups()
  const owner = isOwner(useMe())
  const mode = useSettings().data?.grouping.mode ?? 'auto'
  // New group: open, with these sources ticked (⋯ → Move to group → New group…).
  const [creating, setCreating] = useState<string[] | null>(null)
  const [renaming, setRenaming] = useState<CustomGroup | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  useHotkeys({ '/': () => filterRef.current?.focus() })
  const all = (sources ?? []).filter((s) => s.lines > 0 || s.last_ts != null)
  const live = all.filter((s) => isRecent(s.last_ts))
  // Erroring / stopped for every source, read here (same cache as the rows)
  // rather than reported by mounted rows: a filtered-out or collapsed row
  // cannot report, and an unreported source must not read as "not erroring".
  const statsList = useQueries({
    queries: all.map((s) => streamStatsQuery(s.name, undefined)),
    combine: (rs) => rs.map((r) => r.data),
  })
  const flags: Record<string, ReturnType<typeof statsFlags>> = {}
  all.forEach((s, i) => {
    if (statsList[i]) flags[s.name] = statsFlags(statsList[i])
  })
  // The Erroring tab is a filter on counts still loading: until every source
  // is counted, an empty result is "checking", not "no sources match".
  const flagsSettled = all.every((s) => flags[s.name])
  const shown = all
    .filter((s) =>
      filter === 'live'
        ? isRecent(s.last_ts)
        : filter === 'idle'
          ? !isRecent(s.last_ts)
          : filter === 'erroring'
            ? flags[s.name]?.erroring
            : true,
    )
    .filter((s) => inGroupFilter(s, groupFilter))
    .filter((s) => {
      if (!onlyGroup) return true
      const g = groupOf(s)
      return g != null && groupKey(g) === onlyGroup
    })
    .filter((s) => !text.trim() || s.name.toLowerCase().includes(text.trim().toLowerCase()))
  const total = Object.values(rates).reduce((a, b) => a + b, 0)
  const erroring = all.filter((s) => flags[s.name]?.erroring).length
  const stoppedOne = all.find((s) => flags[s.name]?.stopped)
  const grouped = all.some((s) => groupOf(s))
  // A new custom group with nothing in it yet still shows, unless a filter narrows the list.
  const keepEmpty =
    filter === 'all' && (groupFilter === 'all' || groupFilter === 'custom') && !onlyGroup && !text.trim()
  const stackGroups = grouping === 'stack' && grouped ? groupSources(all, shown, undefined, custom, keepEmpty) : []
  const canEdit = owner && grouped
  const modeLabel = mode === 'label' ? 'Label' : mode === 'off' ? 'Off' : 'Auto'
  const hidden = all.filter((s) => !shown.includes(s))
  type Group = { key: string; host?: ReturnType<typeof hostOf>; stack?: SourceGroup; rows: SourceInfo[] }
  const groups: Group[] =
    grouping === 'stack' && grouped
      ? stackGroups.map((g) => ({ key: g.key, stack: g, rows: g.rows }))
      : grouping === 'host'
        ? [...new Set(shown.map((s) => hostOf(s).key))].map((k) => ({
            key: k,
            host: hostOf(shown.find((s) => hostOf(s).key === k) as SourceInfo),
            rows: shown.filter((s) => hostOf(s).key === k),
          }))
        : [{ key: 'all', rows: shown }]

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-8 py-6">
      <header className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-xl">Sources</h1>
          <p className="text-muted-foreground text-sm">
            {grouped && grouping === 'stack'
              ? custom.length > 0
                ? 'Your groups first, then Compose projects and Swarm stacks. Dokploy apps and Swarm services without a project sit in Standalone.'
                : 'Grouped by Compose project or Swarm stack; HTTP, OTLP, Vector and Fluent Bit pushes sit under Ingest. Pick one to stream it.'
              : 'Everything that sends lines to quiet. Pick one for its settings, rejected requests and stream.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button variant="outline" onClick={() => setCreating([])}>
              <PlusIcon /> New group
            </Button>
          )}
          <Button variant="outline" nativeButton={false} render={<Link to="/connect" />}>
            <PlusIcon /> Connect a source
          </Button>
        </div>
      </header>

      <div className="flex gap-3">
        <Stat
          label="Live sources"
          value={`${live.length} / ${all.length}`}
          sub={`${erroring} erroring · ${all.length - live.length} idle`}
        />
        <Stat label="Ingest" value={`${fmtRate(total)}`.replace('/s', ' lines/s')} sub="across every source, now" />
        <Stat
          label="Stored"
          value={health ? `${fmtCount(health.stored_lines)} lines` : '…'}
          sub={health ? `${fmtWindow(health.retention_ms)} window · ${fmtBytes(health.disk_bytes)}` : ''}
        />
        <Stat
          label="Oldest line"
          value={health?.oldest ? fmtAgo(health.oldest).replace(' ago', '') : '—'}
          sub={health ? `expires on a rolling ${fmtWindow(health.retention_ms)}` : ''}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex border" role="tablist" aria-label="Filter sources">
          {(
            [
              ['all', `All ${all.length}`],
              ['live', `Live ${live.length}`],
              ['idle', `Idle ${all.length - live.length}`],
              ['erroring', `Erroring ${erroring}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={filter === k}
              onClick={() => setFilter(k)}
              className={cn(
                'h-7 px-3 text-muted-foreground text-xs outline-none focus-visible:bg-muted',
                filter === k && 'bg-muted text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {grouped && (
          <div className="flex border" role="tablist" aria-label="Group kind">
            {(
              [
                ['all', 'All'],
                ...(custom.length > 0 ? ([['custom', 'Custom']] as const) : []),
                ['standalone', 'Standalone'],
                ['stack', 'Compose / Stack'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={groupFilter === k}
                onClick={() => setGroupFilter(k)}
                className={cn(
                  'h-7 px-3 text-muted-foreground text-xs outline-none focus-visible:bg-muted',
                  groupFilter === k && 'bg-muted text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-2">
          <div className="relative w-60">
            <SearchIcon className="absolute top-2 left-2 size-3.5 text-muted-foreground" />
            <Input
              ref={filterRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Filter sources"
              aria-label="Filter sources"
              className="pr-7 pl-7"
            />
            <kbd className="absolute top-1.5 right-1.5 border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
          </div>
          <Select value={grouping} onValueChange={(v) => v && setGrouping(v as typeof grouping)}>
            <SelectTrigger aria-label="Grouping" className="w-40">
              <SelectValue>
                {(v: string) =>
                  v === 'stack' ? `Grouping · ${modeLabel}` : v === 'host' ? 'Group by host' : 'No grouping'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stack">Grouping · {modeLabel}</SelectItem>
              <SelectItem value="host">Group by host</SelectItem>
              <SelectItem value="none">No grouping</SelectItem>
            </SelectContent>
          </Select>
          {stackGroups.length > 0 && (
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={allCollapsed(stackGroups.map((g) => g.key)) ? 'Expand all groups' : 'Collapse all groups'}
              title={allCollapsed(stackGroups.map((g) => g.key)) ? 'Expand all groups' : 'Collapse all groups'}
              onClick={() => toggleAll(stackGroups.map((g) => g.key))}
            >
              <ChevronsDownUpIcon />
            </Button>
          )}
        </div>
      </div>

      {(groupFilter !== 'all' || onlyGroup) && hidden.length > 0 && (
        <div className="flex items-center gap-2 border border-dashed px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <FilterIcon className="size-3.5" />
          <span className="text-foreground">
            {onlyGroup
              ? (stackGroups[0]?.name ?? onlyGroup.split(':').slice(1).join(':'))
              : groupFilter === 'stack'
                ? 'Compose / Stack'
                : groupFilter === 'custom'
                  ? 'Custom'
                  : 'Standalone'}
          </span>
          <span className="truncate">
            · {shown.length} of {all.length} sources · hiding {describeHidden(hidden)}. Groups with nothing left to show
            drop out.
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="flex items-center gap-1 text-foreground hover:underline"
            onClick={() => navigate({ search: {}, replace: true })}
          >
            <XIcon className="size-3.5" /> Show all
          </button>
        </div>
      )}

      {mode === 'off' && !grouped && custom.length > 0 && (
        <div className="flex items-center gap-2 border border-dashed px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <FolderIcon className="size-3.5 text-brand" />
          <span className="truncate">
            Grouping is off, so sources show as one list. Your {custom.length} custom{' '}
            {custom.length === 1 ? 'group is' : 'groups are'} kept and come back when grouping is on.
          </span>
          <span className="flex-1" />
          <Link to="/settings" className="flex items-center gap-1 text-foreground hover:underline">
            Source grouping <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      )}

      {stoppedOne && (
        <div
          role="alert"
          className="flex items-center gap-3 border border-status-err/40 bg-status-err/10 px-4 py-2.5 text-[13px]"
        >
          <TriangleAlertIcon className="size-4 text-status-err" />
          <span className="font-medium">
            {stoppedOne.display_name ?? stoppedOne.name} stopped sending
            {stoppedOne.last_ts ? ` ${fmtAgo(stoppedOne.last_ts)}` : ''}
          </span>
          <span className="font-mono text-muted-foreground text-xs">
            · it sent lines earlier this hour; check the sender or its token
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<Link to="/sources/$name" params={{ name: stoppedOne.name }} search={{ tab: 'rejected' }} />}
          >
            Check rejected
          </Button>
        </div>
      )}

      {sourcesQ.isPending ? (
        <div className="flex flex-col gap-2" data-testid="sources-loading">
          <Skeleton className="h-9" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      ) : all.length === 0 ? (
        <div className="flex flex-col items-start gap-3 border border-dashed p-6">
          <p className="font-medium">Nothing connected yet</p>
          <p className="text-muted-foreground text-xs">Sources appear here as soon as they send a line.</p>
          <Button size="sm" nativeButton={false} render={<Link to="/connect" />}>
            <PlusIcon /> Connect a source
          </Button>
        </div>
      ) : (
        <table className="w-full border text-left">
          <thead className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            <tr className="h-9 border-b">
              <th className="px-4 font-normal">Source</th>
              <th className="font-normal">Type</th>
              <th className="font-normal">Rate · 1h</th>
              <th className="font-normal">Last line</th>
              <th className="font-normal">Lines {fmtWindow(health?.retention_ms ?? 86_400_000)}</th>
              <th className="font-normal">Flow id</th>
              <th className="font-normal">Errors</th>
              <th className="w-10 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const collapsed = g.stack ? isCollapsed(g.key) : false
              return (
                <Fragment key={g.key}>
                  {g.stack && (
                    <tr className="border-b bg-muted/30" data-group={g.key}>
                      <td colSpan={8} className="pr-3 pl-4">
                        <SourceGroupHeader
                          group={g.stack}
                          collapsed={collapsed}
                          onToggle={() => toggle(g.key)}
                          rate={groupRate(g.stack.rows, rates)}
                          note={
                            g.stack.kind === 'manual'
                              ? owner
                                ? 'assigned by you'
                                : 'assigned by an owner'
                              : movedNote(g.stack)
                          }
                          actions={
                            g.stack.kind === 'manual' && owner ? (
                              <GroupSearch group={g.stack}>
                                <CustomGroupMenu
                                  group={g.stack}
                                  custom={custom}
                                  members={all.filter((s) => s.group_kind === 'manual' && s.group_id === g.stack?.id)}
                                  onRename={() => setRenaming(custom.find((c) => c.id === g.stack?.id) ?? null)}
                                />
                              </GroupSearch>
                            ) : (
                              <GroupActions
                                group={g.stack}
                                collapsed={collapsed}
                                onCollapse={() => setCollapsed(g.key, !collapsed)}
                                onCollapseAll={() => toggleAll(stackGroups.map((x) => x.key))}
                                onIgnore={() => setIgnoring(g.stack ?? null)}
                              />
                            )
                          }
                        />
                      </td>
                    </tr>
                  )}
                  {g.host && (
                    <tr className="h-8 border-b bg-muted/20">
                      <td colSpan={8} className="px-4">
                        <span className="flex items-center gap-2 text-xs">
                          <BoxIcon className="size-3.5 text-muted-foreground" />
                          <span className="font-medium">{g.host.title}</span>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {g.rows.length} {g.rows.length === 1 ? 'source' : 'sources'} · {g.host.via}
                          </span>
                        </span>
                      </td>
                    </tr>
                  )}
                  {/* Collapsed rows stay mounted (hidden) so their error / stopped flags still count. */}
                  {g.rows.map((s) => (
                    <SourceRow
                      key={s.name}
                      s={s}
                      rate={rates[s.name]}
                      nested={Boolean(g.stack)}
                      hidden={collapsed}
                      menu={
                        <SourceMenu
                          s={s}
                          custom={custom}
                          canMove={canEdit}
                          onNewGroup={() => setCreating([s.name])}
                          onIgnore={() => setIgnoring({ name: s.display_name ?? s.name, rows: [s] })}
                        />
                      }
                    />
                  ))}
                  {g.stack && !collapsed && g.stack.kind === 'manual' && g.stack.total === 0 && (
                    <tr className="border-b">
                      <td colSpan={8} className="py-2.5 pr-4 pl-10 text-muted-foreground text-xs">
                        <span className="flex items-center gap-2">
                          <FolderPlusIcon className="size-3.5" />
                          Nothing in this group yet
                          <span className="font-mono text-[11px]">· ⋯ on a source → Move to group</span>
                        </span>
                      </td>
                    </tr>
                  )}
                  {g.stack && !collapsed && g.stack.sending === 0 && g.stack.kind !== 'ingest' && (
                    <tr className="border-b">
                      <td colSpan={8} className="py-2.5 pr-4 pl-9">
                        <span className="flex items-start gap-2.5">
                          <InfoIcon className="mt-0.5 size-3.5 text-muted-foreground" />
                          <span className="flex flex-col gap-0.5">
                            <span className="text-[13px]">
                              {g.stack.total === 1 ? 'Its container is' : `All ${g.stack.total} containers are`} quiet ·
                              nothing sending
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              lines stay searchable until they leave the {fmtWindow(health?.retention_ms ?? 86_400_000)}{' '}
                              window · the group comes back to life when they log again
                            </span>
                          </span>
                        </span>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-muted-foreground text-xs">
                  {filter === 'erroring' && !flagsSettled ? (
                    <span role="status" className="flex items-center gap-2">
                      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                      Checking error rates…
                    </span>
                  ) : (
                    'No sources match.'
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {grouping === 'stack' && grouped && all.length > 0 && <GroupRulesHint />}
      <IgnoreGroupDialog group={ignoring} onClose={() => setIgnoring(null)} />
      <NewGroupDialog
        open={creating != null}
        preselect={creating ?? []}
        onClose={() => setCreating(null)}
        sources={all}
        custom={custom}
      />
      <RenameGroupDialog group={renaming} custom={custom} onClose={() => setRenaming(null)} />
    </div>
  )
}

/** `Ingest (cron)`, `Standalone (redis, minio)`, `3 sources`. */
function describeHidden(hidden: SourceInfo[]): string {
  const byGroup = new Map<string, string[]>()
  for (const s of hidden) {
    const g = groupOf(s)?.name ?? 'other'
    byGroup.set(g, [...(byGroup.get(g) ?? []), s.display_name ?? s.name])
  }
  const parts = [...byGroup].map(
    ([g, names]) => `${g} (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`,
  )
  return parts.length <= 2 ? parts.join(', ') : `${hidden.length} sources`
}

/** What the Ignore dialog acts on: a group's shown sources, or one source. */
type Ignoring = { name: string; rows: SourceInfo[] }

/** A custom group's header actions: Search this group · 24h, then its own ⋯ menu (06.12). */
function GroupSearch({ group, children }: { group: SourceGroup; children: ReactNode }) {
  const navigate = useNavigate()
  const names = group.rows.map((s) => s.name)
  return (
    <span className="flex shrink-0 items-center gap-1 border-l pl-2">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Search ${group.name} · 24h`}
        title={`Search ${group.name} · 24h`}
        disabled={names.length === 0}
        onClick={() => navigate({ to: '/search', search: { source: names.join(','), range: '24h' } })}
      >
        <SearchIcon />
      </Button>
      {children}
    </span>
  )
}

/** Search this group · 24h, and the ⋯ menu (board v0.1-06.8). */
function GroupActions({
  group,
  collapsed,
  onCollapse,
  onCollapseAll,
  onIgnore,
}: {
  group: SourceGroup
  collapsed: boolean
  onCollapse: () => void
  onCollapseAll: () => void
  onIgnore: () => void
}) {
  const navigate = useNavigate()
  const names = group.rows.map((s) => s.name)
  const searchGroup = () => navigate({ to: '/search', search: { source: names.join(','), range: '24h' } })
  const n = names.length
  return (
    <span className="flex shrink-0 items-center gap-1 border-l pl-2">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Search ${group.name} · 24h`}
        title={`Search ${group.name} · 24h`}
        onClick={searchGroup}
      >
        <SearchIcon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${group.name} actions`} />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuItem onClick={searchGroup}>
            Search {n === 1 ? 'this source' : `these ${n} sources`} · 24h
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCollapse}>{collapsed ? 'Expand group' : 'Collapse group'}</DropdownMenuItem>
          <DropdownMenuItem onClick={onCollapseAll}>Collapse all groups</DropdownMenuItem>
          {group.kind !== 'ingest' && group.kind !== 'standalone' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(group.name)
                    toast.success('Name copied', { description: group.name })
                  } catch {
                    toast.error('Could not copy')
                  }
                }}
              >
                Copy {group.kind === 'stack' ? 'stack' : group.kind === 'compose' ? 'project' : 'group'} name
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{KIND_TAG[group.kind]}</span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem variant="destructive" onClick={onIgnore}>
            Ignore {n === 1 ? 'this source' : `all ${n} sources`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** Ignore = pause ingest + hide, for every source in the group (each reversible in its settings). */
function IgnoreGroupDialog({ group, onClose }: { group: Ignoring | null; onClose: () => void }) {
  const settings = useSettings().data
  const ignore = useIgnoreSources()
  const n = group?.rows.length ?? 0
  const go = async () => {
    if (!group) return
    try {
      await ignore.mutateAsync(
        group.rows.map((s) => ({ name: s.name, settings: settings?.sources[s.name] ?? DEFAULT_SOURCE_SETTINGS })),
      )
      toast.success(`Ignoring ${group.name}`, {
        description: `${n} ${n === 1 ? 'source' : 'sources'} paused and hidden. Undo from each source's settings.`,
      })
      onClose()
    } catch (err) {
      toast.error('Could not ignore', { description: (err as Error).message })
    }
  }
  return (
    <Dialog open={group != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ignore {group?.name}?</DialogTitle>
          <DialogDescription>
            New lines from {n === 1 ? 'its source' : `its ${n} sources`} are dropped and the sources leave the sidebar.
            Lines already stored stay searchable until they expire. Each source can be turned back on from its settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={go} disabled={ignore.isPending}>
            Ignore {n === 1 ? 'source' : `${n} sources`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
