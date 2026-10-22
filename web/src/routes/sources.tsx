import { Link } from '@tanstack/react-router'
import { BoxIcon, EllipsisIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { SourceGroupHeader } from '@/components/source-group-header'
import { Sparkline } from '@/components/sparkline'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SourceInfo } from '@/gen'
import { useHealth, useSources } from '@/lib/api'
import { kindLabel } from '@/lib/connect'
import { fmtAgo, fmtBytes, fmtCount, fmtWindow, isRecent } from '@/lib/format'
import {
  type GroupFilter,
  groupSources,
  inGroupFilter,
  type SourceGroup,
  useCollapsedGroups,
} from '@/lib/source-groups'
import { useSourceFields, useStreamStats } from '@/lib/stream-api'
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

/** The 24h error share and last-hour volume of one source, read once per row. */
function useSourceStats(name: string) {
  const stats = useStreamStats(name, undefined).data
  const fields = useSourceFields(name).data
  const errors = stats && stats.total > 0 ? stats.levels.error / stats.total : null
  const top = fields?.ids.slice().sort((a, b) => b.coverage - a.coverage)[0]
  const idKey = fields ? (top && top.coverage > 0 ? top.key : null) : undefined
  // "Stopped": it sent lines earlier in the hour but nothing in the last 2 minutes.
  const h = stats?.histogram ?? []
  const stopped = h.length > 5 && h.slice(0, -3).some((b) => b.count > 0) && h.slice(-3).every((b) => b.count === 0)
  return { stats, errors, idKey, stopped }
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
  onStats,
  nested = false,
  hidden = false,
}: {
  s: SourceInfo
  rate: number | undefined
  onStats: (name: string, v: { erroring: boolean; stopped: boolean }) => void
  /** Under a stack group header: indented. */
  nested?: boolean
  hidden?: boolean
}) {
  const { stats, errors, idKey, stopped } = useSourceStats(s.name)
  const erroring = errors != null && errors >= ERRORING
  // Tell the page (tabs, banner) only when a flag changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onStats is a stable setter wrapper
  useEffect(() => onStats(s.name, { erroring, stopped }), [s.name, erroring, stopped])
  const live = isRecent(s.last_ts)
  return (
    <tr className="h-11 border-b last:border-b-0 hover:bg-row-hover" hidden={hidden}>
      <td className={nested ? 'pr-4 pl-9' : 'px-4'}>
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
      <td className="pr-3 text-right">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Open ${s.name}`}
          nativeButton={false}
          render={<Link to="/sources/$name" params={{ name: s.name }} />}
        >
          <EllipsisIcon />
        </Button>
      </td>
    </tr>
  )
}

const fmtPct = (v: number) => (v === 0 ? '0%' : v < 0.1 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`)

/** `/sources` — everything that sends lines: receiver kind, rate, last line. */
export function SourcesPage() {
  const sources = useSources().data
  const health = useHealth().data
  const rates = useRates(sources)
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const [grouping, setGrouping] = useState<'stack' | 'host' | 'none'>('stack')
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const { isCollapsed, toggle } = useCollapsedGroups()
  const [flags, setFlags] = useState<Record<string, { erroring: boolean; stopped: boolean }>>({})
  const onStats = (name: string, v: { erroring: boolean; stopped: boolean }) =>
    setFlags((f) => (f[name]?.erroring === v.erroring && f[name]?.stopped === v.stopped ? f : { ...f, [name]: v }))
  const filterRef = useRef<HTMLInputElement>(null)
  useHotkeys({ '/': () => filterRef.current?.focus() })
  const all = (sources ?? []).filter((s) => s.lines > 0 || s.last_ts != null)
  const live = all.filter((s) => isRecent(s.last_ts))
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
    .filter((s) => !text.trim() || s.name.toLowerCase().includes(text.trim().toLowerCase()))
  const total = Object.values(rates).reduce((a, b) => a + b, 0)
  const erroring = all.filter((s) => flags[s.name]?.erroring).length
  const stoppedOne = all.find((s) => flags[s.name]?.stopped)
  type Group = { key: string; host?: ReturnType<typeof hostOf>; stack?: SourceGroup; rows: SourceInfo[] }
  const groups: Group[] =
    grouping === 'stack'
      ? groupSources(all, shown).map((g) => ({ key: g.key, stack: g, rows: g.rows }))
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
            Everything that sends lines to quiet. Pick one for its settings, rejected requests and stream.
          </p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link to="/connect" />}>
          <PlusIcon /> Connect a source
        </Button>
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
        <div className="flex border" role="tablist" aria-label="Group kind">
          {(
            [
              ['all', 'All'],
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
                {(v: string) => (v === 'stack' ? 'Group by stack' : v === 'host' ? 'Group by host' : 'No grouping')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stack">Group by stack</SelectItem>
              <SelectItem value="host">Group by host</SelectItem>
              <SelectItem value="none">No grouping</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

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

      {all.length === 0 ? (
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
                    <tr className="border-b bg-muted/20" data-group={g.key}>
                      <td colSpan={8} className="px-4">
                        <SourceGroupHeader group={g.stack} collapsed={collapsed} onToggle={() => toggle(g.key)} />
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
                      onStats={onStats}
                      nested={Boolean(g.stack)}
                      hidden={collapsed}
                    />
                  ))}
                </Fragment>
              )
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-muted-foreground text-xs">
                  No sources match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
