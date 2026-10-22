import { Link } from '@tanstack/react-router'
import { StatusDot } from '@/components/status-dot'
import type { SourceInfo } from '@/gen'
import { kindLabel } from '@/lib/connect'
import { isRecent } from '@/lib/format'
import { cn } from '@/lib/utils'

export function SourceItem({
  source,
  active,
  rate,
  nested = false,
}: {
  source: SourceInfo
  active: boolean
  rate: number | null
  /** Under a group header in the sidebar: indented. */
  nested?: boolean
}) {
  const live = isRecent(source.last_ts)
  return (
    <Link
      to="/"
      search={{ source: source.name }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        // Nested under a group: single-line 28px (the group already says the kind).
        nested ? 'h-7 pr-3 pl-7' : 'h-9 px-3',
        'group relative flex items-center gap-2.5 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent',
        active &&
          'bg-sidebar-accent text-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand',
      )}
    >
      <StatusDot status={source.paused ? 'warn' : live ? 'ok' : 'idle'} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px]" title={source.display_name ? source.name : undefined}>
          {source.display_name ?? source.name}
        </span>
        {!nested && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">{kindLabel(source.kind)}</span>
        )}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {source.paused
          ? 'paused'
          : rate != null && rate > 0
            ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s`
            : '—'}
      </span>
    </Link>
  )
}
