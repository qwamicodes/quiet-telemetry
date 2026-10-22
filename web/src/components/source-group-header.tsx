import { BoxIcon, ChevronRightIcon, LayersIcon, PlugIcon } from 'lucide-react'
import { groupSummary, type SourceGroup } from '@/lib/source-groups'
import { cn } from '@/lib/utils'

const KIND_LABEL = { compose: 'compose', stack: 'stack', standalone: 'docker', ingest: 'push' } as const

/** A collapsible group row: chevron, stack icon, name, `N/M sending · K shown`. */
export function SourceGroupHeader({
  group,
  collapsed,
  onToggle,
  compact = false,
}: {
  group: SourceGroup
  collapsed: boolean
  onToggle: () => void
  /** Sidebar: one line, smaller type. */
  compact?: boolean
}) {
  const Icon = group.kind === 'ingest' ? PlugIcon : group.kind === 'standalone' ? BoxIcon : LayersIcon
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={`${group.name} · ${groupSummary(group)}`}
      onClick={onToggle}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 text-left outline-none hover:text-foreground focus-visible:bg-muted',
        compact ? 'h-7 px-1 text-xs' : 'h-8 text-xs',
      )}
    >
      <ChevronRightIcon
        className={cn('size-3 shrink-0 text-muted-foreground transition-transform', !collapsed && 'rotate-90')}
      />
      <Icon className={cn('size-3.5 shrink-0', group.kind === 'ingest' ? 'text-muted-foreground' : 'text-brand')} />
      <span className="truncate font-medium text-foreground">{group.name}</span>
      {!compact && (
        <span className="border px-1 font-mono text-[10px] text-muted-foreground">{KIND_LABEL[group.kind]}</span>
      )}
      <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">
        {compact ? `${group.sending}/${group.total}` : groupSummary(group)}
      </span>
    </button>
  )
}
