import type { Bucket } from '@/gen'
import { cn } from '@/lib/utils'

/** A row-sized volume chart: the last hour in bars, errors red (design 06.1). */
export function Sparkline({ buckets, bars = 30, className }: { buckets: Bucket[]; bars?: number; className?: string }) {
  // Fold the minute buckets into `bars` bars.
  const per = Math.max(1, Math.ceil(buckets.length / bars))
  const folded: { count: number; error: number }[] = []
  for (let i = 0; i < buckets.length; i += per) {
    const part = buckets.slice(i, i + per)
    folded.push({ count: part.reduce((n, b) => n + b.count, 0), error: part.reduce((n, b) => n + b.error, 0) })
  }
  const max = Math.max(1, ...folded.map((b) => b.count))
  return (
    <span aria-hidden data-testid="sparkline" className={cn('flex h-4 w-24 items-end gap-px', className)}>
      {folded.map((b, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position bars
          key={i}
          className={cn(
            'flex-1',
            b.count === 0 ? 'h-px bg-muted-foreground/30' : b.error * 2 > b.count ? 'bg-status-err' : 'bg-chart-1',
          )}
          style={b.count ? { height: `${Math.max(12, (b.count / max) * 100)}%` } : undefined}
        />
      ))}
    </span>
  )
}
