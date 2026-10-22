import { Link } from '@tanstack/react-router'
import { PlusIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useHealth, useSources } from '@/lib/api'
import { kindLabel } from '@/lib/connect'
import { fmtAgo, fmtBytes, fmtCount, fmtWindow, isRecent } from '@/lib/format'
import { useRates } from '@/lib/use-rates'
import { cn } from '@/lib/utils'

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

type Filter = 'all' | 'live' | 'idle'

/** `/sources` — everything that sends lines: receiver kind, rate, last line. */
export function SourcesPage() {
  const sources = useSources().data
  const health = useHealth().data
  const rates = useRates(sources)
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const all = (sources ?? []).filter((s) => s.lines > 0 || s.last_ts != null)
  const live = all.filter((s) => isRecent(s.last_ts))
  const shown = all
    .filter((s) => (filter === 'live' ? isRecent(s.last_ts) : filter === 'idle' ? !isRecent(s.last_ts) : true))
    .filter((s) => !text.trim() || s.name.toLowerCase().includes(text.trim().toLowerCase()))
  const total = Object.values(rates).reduce((a, b) => a + b, 0)

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
          sub={`${all.length - live.length} idle (no line in a minute)`}
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
        <div className="relative w-60">
          <SearchIcon className="absolute top-2 left-2 size-3.5 text-muted-foreground" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter sources"
            aria-label="Filter sources"
            className="pl-7"
          />
        </div>
      </div>

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
              <th className="font-normal">Rate</th>
              <th className="font-normal">Last line</th>
              <th className="font-normal">Lines</th>
              <th className="font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.name} className="h-11 border-b last:border-b-0 hover:bg-row-hover">
                <td className="px-4">
                  <Link
                    to="/sources/$name"
                    params={{ name: s.name }}
                    className="flex items-center gap-2.5 font-medium text-[13px] outline-none hover:underline"
                  >
                    <StatusDot status={s.paused ? 'warn' : isRecent(s.last_ts) ? 'ok' : 'idle'} />
                    {s.display_name ?? s.name}
                    {s.paused && <span className="font-mono text-[11px] text-status-warn">paused</span>}
                    {s.hidden && <span className="font-mono text-[11px] text-muted-foreground">hidden</span>}
                  </Link>
                </td>
                <td>
                  <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {kindLabel(s.kind)}
                  </span>
                </td>
                <td className="font-mono text-xs tabular-nums">{fmtRate(rates[s.name])}</td>
                <td className="font-mono text-muted-foreground text-xs">{s.last_ts ? fmtAgo(s.last_ts) : 'never'}</td>
                <td className="font-mono text-xs tabular-nums">{fmtCount(s.lines)}</td>
                <td className="truncate font-mono text-[11px] text-muted-foreground">
                  {s.kind === 'docker'
                    ? `docker.sock · ${s.group ?? 'this host'}${s.containers.length ? ` · ${s.containers.length} containers` : ''}`
                    : s.kind === 'otlp'
                      ? 'otlp/http'
                      : `http ingest · /ingest/${s.kind === 'http' ? 'ndjson' : s.kind}`}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-muted-foreground text-xs">
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
