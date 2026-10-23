import { Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { StatusDot } from '@/components/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SourceInfo } from '@/gen'
import { kindLabel } from '@/lib/connect'
import { isRecent } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATUS_LABEL = { ok: 'sending', warn: 'paused', idle: 'idle' } as const

export function SourceItem({
  source,
  active,
  rate,
  nested = false,
  group,
}: {
  source: SourceInfo
  active: boolean
  rate: number | null
  /** Under a group header in the sidebar: indented. */
  nested?: boolean
  /** The group it sits under, for the full-name tooltip. */
  group?: string
}) {
  const live = isRecent(source.last_ts)
  const status = source.paused ? 'warn' : live ? 'ok' : 'idle'
  const rateText = source.paused
    ? 'paused'
    : rate != null && rate > 0
      ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s`
      : '—'
  const label = source.display_name ?? source.name
  const nameRef = useRef<HTMLSpanElement>(null)
  // Narrow sidebar (03.12): a cut-off name gets the full name, group, rate and
  // status on hover; at wide widths it shows in full and needs none. A display
  // name always offers the source's real name.
  const [tip, setTip] = useState(false)
  const truncated = () => {
    const el = nameRef.current
    return !!el && el.scrollWidth > el.clientWidth + 1
  }
  return (
    <Tooltip open={tip} onOpenChange={(o) => setTip(o && (truncated() || !!source.display_name))}>
      <TooltipTrigger
        render={
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
          />
        }
      >
        <StatusDot status={status} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span ref={nameRef} className="truncate text-[13px]">
            {label}
          </span>
          {!nested && (
            <span className="truncate font-mono text-[11px] text-muted-foreground">{kindLabel(source.kind)}</span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{rateText}</span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        alignOffset={nested ? 22 : 10}
        sideOffset={4}
        arrow={false}
        className="flex-col items-start gap-0.5 border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
      >
        <span className="font-medium text-xs">{source.name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {[group, rateText, STATUS_LABEL[status]].filter(Boolean).join(' · ')}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
