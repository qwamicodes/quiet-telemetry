import type { Bucket } from '@/gen'
import { fmtClock } from '@/lib/format'
import { barWidth, type Span } from '@/lib/histogram-jump'
import { fmtDay } from '@/lib/history-search'
import { cn } from '@/lib/utils'

/**
 * Matches over time; a bar is red when it holds errors, amber for warnings.
 * With `onJump`, a bar is a button (click, or Enter / Space when focused) that
 * takes the results to its time; `selected` marks that bar.
 */
export function Histogram({
  buckets,
  since,
  until,
  selected = -1,
  onJump,
  unsearched = [],
}: {
  /**
   * Ranges retained history did not search (expired, gaps, not yet asked):
   * hatched, with what happened written over wide ones (v1.1-19, 21).
   */
  unsearched?: { from: number; to: number; label?: string }[]
  buckets: Bucket[]
  since: number
  until: number
  /** Index of the bar the results were taken to. */
  selected?: number
  onJump?: (span: Span, index: number) => void
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => since + (until - since) * f)
  // Over two days the axis reads in dates (`23 Oct`), else in clock times.
  const tick = until - since > 2 * 86_400_000 ? fmtDay : fmtClock
  const width = barWidth(buckets, since, until)
  const span = Math.max(1, until - since)
  const pct = (t: number) => `${(Math.min(1, Math.max(0, (t - since) / span)) * 100).toFixed(3)}%`
  return (
    <figure aria-label="Matches over time" className="flex flex-col gap-1.5">
      <div className="relative flex h-10 items-end gap-px overflow-clip border bg-card px-1 pt-1">
        {unsearched
          .filter((u) => u.to > since && u.from < until)
          .map((u) => (
            <span
              key={`${u.from}-${u.to}`}
              aria-hidden={!u.label}
              data-testid="histogram-unsearched"
              style={{ left: pct(u.from), width: `calc(${pct(Math.min(u.to, until))} - ${pct(u.from)})` }}
              className="pointer-events-none absolute inset-y-0 flex items-center justify-center overflow-hidden bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--foreground)_5%,transparent)_0_1px,transparent_1px_7px)]"
            >
              {u.label && (u.to - u.from) / span > 0.12 && (
                <span className="truncate px-2 font-mono text-[11px] text-muted-foreground leading-[18px]">
                  {u.label}
                </span>
              )}
            </span>
          ))}
        {buckets.map((b, i) => {
          const end = i === buckets.length - 1 ? until : b.start + width
          const grey = unsearched.some((u) => b.start < u.to && end > u.from)
          const label = `${fmtClock(b.start)} · ${b.count} lines${grey ? ' · not searched' : ''}`
          const bar = (
            <span
              style={{ height: b.count ? `${Math.max(12, (b.count / max) * 100)}%` : 0 }}
              className={cn(
                'w-full',
                b.error ? 'bg-status-err/80' : b.warn ? 'bg-status-warn/80' : 'bg-brand/50',
                !b.count && 'bg-transparent',
              )}
            />
          )
          if (!onJump || !b.count)
            return (
              <span
                key={b.start}
                title={label}
                data-unsearched={grey || undefined}
                className="flex h-full flex-1 items-end"
              >
                {bar}
              </span>
            )
          // The server folds the remainder of the range into the last bar.
          const to = i === buckets.length - 1 ? Math.max(b.start + width, until + 1) : b.start + width
          const isSelected = i === selected
          return (
            <button
              key={b.start}
              type="button"
              title={`${label} · click to jump`}
              aria-label={`${label}. Jump to ${fmtClock(b.start)}`}
              aria-pressed={isSelected}
              data-selected={isSelected || undefined}
              onClick={() => onJump({ from: b.start, to }, i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
              }}
              className={cn(
                'flex h-full flex-1 cursor-pointer items-end outline-none',
                'hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring',
                '[&>span]:transition-opacity hover:[&>span]:opacity-80',
                isSelected && 'bg-brand/10 shadow-[inset_0_-2px_0_var(--brand)]',
              )}
            >
              {bar}
            </button>
          )
        })}
      </div>
      <figcaption className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        {ticks.map((t) => (
          <span key={t}>{tick(t)}</span>
        ))}
      </figcaption>
    </figure>
  )
}
