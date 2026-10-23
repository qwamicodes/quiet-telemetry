import type { Bucket } from '@/gen'
import { fmtClock } from '@/lib/format'
import type { Span } from '@/lib/histogram-jump'
import { isOn, type LevelChip } from '@/lib/levels'
import { cn } from '@/lib/utils'

const H = 48

/**
 * Volume over the last hour, one bar a minute, stacked info / warn / error
 * (debug sits with info). Only the levels that are on are drawn, so it shows
 * what the table shows. Empty minutes are gaps.
 *
 * With `onJump`, each bar is a button (click, or Enter / Space when focused)
 * that takes the table to that minute; `selected` marks the minute jumped to.
 */
export function StreamHistogram({
  buckets,
  since,
  width,
  levels,
  loading,
  dim,
  selected,
  onJump,
}: {
  buckets: Bucket[]
  since: number
  width: number
  levels: LevelChip[]
  loading?: boolean
  dim?: boolean
  /** Start (unix ms) of the minute the table was taken to. */
  selected?: number | null
  onJump?: (span: Span) => void
}) {
  const parts = buckets.map((b) => {
    const info = (isOn(levels, 'info') ? b.info : 0) + (isOn(levels, 'debug') ? b.debug : 0)
    const warn = isOn(levels, 'warn') ? b.warn : 0
    const error = isOn(levels, 'error') ? b.error : 0
    // Lines without a level only show when nothing is filtered.
    const other = levels.length === 0 ? Math.max(0, b.count - b.info - b.debug - b.warn - b.error) : 0
    return { start: b.start, info: info + other, warn, error, total: info + other + warn + error }
  })
  const max = Math.max(1, ...parts.map((p) => p.total))
  const end = since + width * buckets.length
  const ticks = [0, 1 / 3, 2 / 3].map((f) => since + (end - since) * f)
  return (
    <figure
      aria-label="Lines over the last hour"
      className={cn('flex shrink-0 flex-col gap-1 px-6 pb-3', dim && 'opacity-60')}
    >
      <div className="flex items-end gap-px border bg-card/40 px-2 pt-2" style={{ height: H + 10 }}>
        {loading
          ? Array.from({ length: 60 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars
              <span key={i} className="flex-1 animate-pulse bg-muted" style={{ height: `${20 + ((i * 37) % 60)}%` }} />
            ))
          : parts.map((p, i) => {
              const label = `${fmtClock(p.start)} · ${p.total.toLocaleString()} lines${p.error ? ` · ${p.error} errors` : ''}${p.warn ? ` · ${p.warn} warnings` : ''}`
              const bar = (
                <span
                  className="flex w-full flex-col-reverse"
                  style={{ height: p.total ? `${Math.max(6, (p.total / max) * 100)}%` : 0 }}
                >
                  <span className="bg-chart-1" style={{ flexGrow: p.info }} />
                  <span className="bg-chart-3" style={{ flexGrow: p.warn }} />
                  <span className="bg-chart-2" style={{ flexGrow: p.error }} />
                </span>
              )
              if (!onJump || !p.total)
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position buckets
                  <span key={i} title={label} className="flex h-full flex-1 items-end">
                    {bar}
                  </span>
                )
              const isSelected = selected != null && selected === p.start
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position buckets
                  key={i}
                  type="button"
                  title={`${label} · click to jump`}
                  aria-label={`${label}. Jump to ${fmtClock(p.start)}`}
                  aria-pressed={isSelected}
                  data-selected={isSelected || undefined}
                  onClick={() => onJump({ from: p.start, to: p.start + width })}
                  // The page's own Enter / Space shortcuts must not swallow the button's.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                  }}
                  className={cn(
                    'group/bar relative flex h-full flex-1 cursor-pointer items-end outline-none',
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
        {ticks.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: three fixed ticks
          <span key={i}>{fmtClock(t)}</span>
        ))}
        <span>now</span>
      </figcaption>
    </figure>
  )
}

/** Fold live lines that arrived after the snapshot into its buckets. */
export function withLive(
  buckets: Bucket[],
  since: number,
  width: number,
  after: number,
  lines: { ts: number; level: string | null }[],
): Bucket[] {
  const extra = lines.filter((l) => l.ts > after && l.ts >= since && l.ts < since + width * buckets.length)
  if (!extra.length) return buckets
  const out = buckets.map((b) => ({ ...b }))
  for (const l of extra) {
    const b = out[Math.floor((l.ts - since) / width)]
    if (!b) continue
    b.count++
    if (l.level === 'trace' || l.level === 'debug') b.debug++
    else if (l.level === 'info') b.info++
    else if (l.level === 'warn') b.warn++
    else if (l.level === 'error' || l.level === 'fatal') b.error++
  }
  return out
}
