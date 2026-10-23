import {
  BoxIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  LayersIcon,
  PlugIcon,
  SearchIcon,
  TagIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { StatusDot } from '@/components/status-dot'
import type { GroupKind } from '@/gen'
import { groupSummary, KIND_TAG, type SourceGroup, sourceStatus } from '@/lib/source-groups'
import { cn } from '@/lib/utils'

export function GroupIcon({ kind, className }: { kind: GroupKind; className?: string }) {
  const Icon =
    kind === 'ingest'
      ? PlugIcon
      : kind === 'standalone'
        ? BoxIcon
        : kind === 'custom'
          ? TagIcon
          : kind === 'manual'
            ? FolderIcon
            : LayersIcon
  return (
    <Icon className={cn('size-3.5 shrink-0', kind === 'ingest' ? 'text-muted-foreground' : 'text-brand', className)} />
  )
}

/** One dot per member: shown on a collapsed header so status stays visible. */
export function GroupDots({ group, now }: { group: SourceGroup; now?: number }) {
  return (
    <span className="flex items-center gap-0.5" data-testid="group-dots">
      {group.rows.slice(0, 24).map((s) => (
        <StatusDot key={s.name} status={sourceStatus(s, now)} />
      ))}
    </span>
  )
}

const fmtRate = (r: number) => (r === 0 ? '0' : r < 1 ? r.toFixed(1) : String(Math.round(r)))

/**
 * A collapsible group row (boards v0.1-06.7 / 06.8 / 06.9 / 03.8): chevron,
 * stack (or folder, for a custom group) icon, name, kind tag, `N/M sending ·
 * K shown`, an optional note (“assigned by you”, “4 moved to Legivent
 * staging”), member dots when collapsed; the table variant adds the
 * aggregate rate and the row actions.
 */
export function SourceGroupHeader({
  group,
  collapsed,
  onToggle,
  compact = false,
  rate,
  actions,
  note,
}: {
  group: SourceGroup
  collapsed: boolean
  onToggle: () => void
  /** Sidebar / picker: one line, smaller type, `N/M` only. */
  compact?: boolean
  /** Sum of the members' lines/s (table variant). */
  rate?: number
  /** Search + ⋯ menu (table variant). */
  actions?: ReactNode
  /** After the summary (table variant). */
  note?: string | null
}) {
  const allStopped = group.sending === 0 && group.total > 0
  return (
    <div className={cn('flex w-full min-w-0 items-center gap-2', compact ? 'h-7' : 'h-10')}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${group.name} · ${groupSummary(group)}`}
        onClick={onToggle}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-left outline-none hover:text-foreground focus-visible:bg-muted',
          compact ? 'px-1 text-xs' : 'text-xs',
        )}
      >
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', !collapsed && 'rotate-90')}
        />
        <GroupIcon kind={group.kind} />
        <span className={cn('truncate text-foreground', compact ? '' : 'font-mono font-semibold text-[13px]')}>
          {group.name}
        </span>
        {!compact && (
          <span
            className={cn(
              'shrink-0 px-1 font-mono text-[10px]',
              group.kind === 'manual' ? 'bg-brand/15 text-brand' : 'border text-muted-foreground',
            )}
          >
            {KIND_TAG[group.kind]}
          </span>
        )}
        {!compact && allStopped && (
          <span className="shrink-0 bg-muted px-1 font-mono text-[10px] text-foreground">all stopped</span>
        )}
        {!compact && (
          <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">{groupSummary(group)}</span>
        )}
        {!compact && note && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" data-testid="group-note">
            · {note}
          </span>
        )}
        {collapsed && <GroupDots group={group} />}
        {compact && <span className="flex-1" />}
        {compact && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
            {group.sending}/{group.total}
          </span>
        )}
      </button>
      {rate !== undefined && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {allStopped ? 'no lines now' : `${fmtRate(rate)} lines/s`}
        </span>
      )}
      {actions}
    </div>
  )
}

export { EllipsisIcon as GroupMenuIcon, SearchIcon as GroupSearchIcon }
