import type { Flow } from '@/gen'
import { fmtDuration, laneTag } from '@/lib/flow'
import { cn } from '@/lib/utils'

/** Rows up to this many steps; beyond it, one compact strip. */
export const TIMELINE_ROWS = 14

type Row = { key: string; tag: string; name: string; start: number; dur: number | null; tone: string; child: boolean }

function rows(f: Flow): Row[] {
  const out: Row[] = []
  for (const n of f.nodes) {
    const tone = n.error ? 'bg-status-err' : n.warn ? 'bg-status-warn' : 'bg-brand'
    out.push({
      key: `n${n.index}`,
      tag: laneTag(n.source),
      name: n.name,
      start: n.offset_ms,
      dur: n.duration_ms,
      tone,
      child: false,
    })
    for (const [i, c] of n.children.entries())
      out.push({
        key: `n${n.index}c${i}`,
        tag: laneTag(n.source),
        name: c.name,
        start: n.offset_ms + (c.at_ms ?? 0),
        dur: c.duration_ms,
        tone: c.error ? 'bg-status-err' : 'bg-brand/70',
        child: true,
      })
  }
  // The last step of the flow reads green when it all went well.
  const last = out.filter((r) => !r.child).pop()
  if (last && f.status === 'ok') last.tone = 'bg-status-ok'
  return out
}

/** When each step ran, against the whole flow's span. */
export function Timeline({ flow }: { flow: Flow }) {
  const total = Math.max(1, flow.duration_ms)
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`
  const all = rows(flow)

  if (all.length > TIMELINE_ROWS) {
    // Compact: one segment per line, gaps (backoff, queue wait) stay empty.
    return (
      <section aria-label="Timeline" className="border p-3">
        <div className="relative h-1.5 bg-muted">
          {flow.nodes.map((n) => (
            <span
              key={n.index}
              title={`${n.name} · ${fmtDuration(n.duration_ms)}`}
              className={cn(
                'absolute inset-y-0 min-w-0.5 border-background border-r',
                n.error ? 'bg-status-err' : n.warn ? 'bg-status-warn' : 'bg-status-ok',
              )}
              style={{ left: pct(n.offset_ms), width: pct(Math.max(n.duration_ms ?? 0, total / 400)) }}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>0</span>
          <span>{fmtDuration(total / 2)}</span>
          <span>{fmtDuration(total)}</span>
        </div>
      </section>
    )
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <section aria-label="Timeline" className="border px-3.5 py-3 font-mono text-xs">
      <div className="grid grid-cols-[180px_minmax(0,1fr)_56px] gap-3 pb-1 text-[11px] text-muted-foreground">
        <span className="uppercase tracking-[0.06em]">Timeline</span>
        <span className="relative h-4">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: `${t * 100}%` }}>
              {fmtDuration(total * t)}
            </span>
          ))}
        </span>
        <span />
      </div>
      {all.map((r) => (
        <div key={r.key} className="grid h-[22px] grid-cols-[180px_minmax(0,1fr)_56px] items-center gap-3">
          <span className={cn('truncate', r.child && 'pl-3')}>
            <span className="text-muted-foreground">{r.tag}</span> {r.name}
          </span>
          <span className="relative h-2">
            <span
              className={cn('absolute inset-y-0 min-w-0.5', r.tone)}
              style={{ left: pct(r.start), width: r.dur == null ? '2px' : pct(r.dur) }}
            />
          </span>
          <span className="text-right text-muted-foreground tabular-nums">{fmtDuration(r.dur)}</span>
        </div>
      ))}
    </section>
  )
}
