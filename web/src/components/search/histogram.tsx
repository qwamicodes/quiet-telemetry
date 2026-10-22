import type { Bucket } from '@/gen'
import { fmtClock } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Matches over time; a bar is red when it holds errors, amber for warnings. */
export function Histogram({ buckets, since, until }: { buckets: Bucket[]; since: number; until: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => since + (until - since) * f)
  return (
    <figure aria-label="Matches over time" className="flex flex-col gap-1.5">
      <div className="flex h-10 items-end gap-px border px-1 pt-1">
        {buckets.map((b) => (
          <span
            key={b.start}
            title={`${fmtClock(b.start)} · ${b.count} lines`}
            style={{ height: b.count ? `${Math.max(12, (b.count / max) * 100)}%` : 0 }}
            className={cn(
              'flex-1',
              b.error ? 'bg-status-err/80' : b.warn ? 'bg-status-warn/80' : 'bg-brand/50',
              !b.count && 'bg-transparent',
            )}
          />
        ))}
      </div>
      <figcaption className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        {ticks.map((t) => (
          <span key={t}>{fmtClock(t)}</span>
        ))}
      </figcaption>
    </figure>
  )
}
