import { Link } from '@tanstack/react-router'
import { StatusDot } from '@/components/status-dot'
import type { SourceInfo } from '@/gen'
import { isRecent } from '@/lib/format'
import { cn } from '@/lib/utils'

export function SourceItem({ source, active, rate }: { source: SourceInfo; active: boolean; rate: number | null }) {
  const live = isRecent(source.last_ts)
  return (
    <Link
      to="/"
      search={{ source: source.name }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-9 items-center gap-2.5 px-3 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent',
        active &&
          'bg-sidebar-accent text-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand',
      )}
    >
      <StatusDot status={live ? 'ok' : 'idle'} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px]">{source.name}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{source.kind}</span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {rate != null && rate > 0 ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s` : '—'}
      </span>
    </Link>
  )
}
