import { FileDownIcon, PlayIcon } from 'lucide-react'
import { SidebarToggle } from '@/components/sidebar-resize'
import { StatusDot } from '@/components/status-dot'
import { SourcePicker } from '@/components/stream/source-picker'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SourceInfo } from '@/gen'
import { fmtTime } from '@/lib/format'
import type { ConnState } from '@/lib/use-stream'
import { cn } from '@/lib/utils'

export type LiveState = 'connecting' | 'live' | 'paused' | 'offline'

export function liveState(conn: ConnState, paused: boolean, everConnected = true): LiveState {
  if (conn === 'connecting' || (conn !== 'live' && !everConnected)) return 'connecting'
  if (conn !== 'live') return 'offline'
  return paused ? 'paused' : 'live'
}

/** Pause as two plain bars (03.2), not lucide's rounded ones. */
function PauseBars() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 fill-current">
      <rect x="4" y="3" width="2.5" height="10" />
      <rect x="9.5" y="3" width="2.5" height="10" />
    </svg>
  )
}

const fmtRate = (r: number) => (r < 10 ? r.toFixed(1).replace(/\.0$/, '') : String(Math.round(r)))

/** Live · 42 events/s, Paused · buffering 38, Offline · reconnecting, Connecting (design 03.x, 08.4, 08.7). */
export function LiveIndicator({
  state,
  rate,
  matchRate,
  buffered,
  heldAt,
  offlineReason = 'reconnecting',
}: {
  state: LiveState
  rate: number | null
  /** Set when filters are on: matches per second, after the event rate (03.3). */
  matchRate?: number | null
  buffered?: number
  /** Session expired (01.5): "held at 14:07:35". */
  heldAt?: number | null
  offlineReason?: string
}) {
  const label = { connecting: 'Connecting', live: 'Live', paused: 'Paused', offline: 'Offline' }[state]
  const detail =
    state === 'live'
      ? [
          rate != null && `${fmtRate(rate)} events/s`,
          matchRate != null && (matchRate === 0 ? '0 match' : `${fmtRate(matchRate)} match/s`),
        ]
          .filter(Boolean)
          .join(' · ') || null
      : state === 'paused'
        ? heldAt
          ? `held at ${fmtTime(heldAt).slice(0, 8)}`
          : buffered
            ? `buffering ${buffered.toLocaleString()}`
            : null
        : state === 'offline'
          ? offlineReason
          : null
  return (
    <span
      role="status"
      className={cn(
        'relative inline-flex h-7 items-center gap-2 overflow-hidden border px-2.5 font-mono text-xs',
        state === 'live' && 'border-status-ok/30 bg-status-ok/10 text-status-ok',
        (state === 'paused' || state === 'connecting') && 'border-status-warn/30 bg-status-warn/10 text-status-warn',
        state === 'offline' && 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      <StatusDot
        status={state === 'live' ? 'ok' : state === 'offline' ? 'idle' : 'warn'}
        pulse={state === 'connecting'}
      />
      <span className="font-sans font-semibold">{label}</span>
      {detail && <span className="text-muted-foreground">· {detail}</span>}
      {state === 'connecting' && (
        // 08.4: an indeterminate bar along the pill's bottom edge while the backlog loads.
        <span aria-hidden data-testid="connecting-progress" className="absolute inset-x-0 bottom-0 h-0.5">
          <span className="block h-full w-2/5 animate-[quiet-indeterminate_1.2s_ease-in-out_infinite] bg-status-warn" />
        </span>
      )}
    </span>
  )
}

export function TopBar({
  source,
  name,
  state,
  rate,
  matchRate,
  buffered,
  heldAt,
  stitchedBy,
  offlineReason,
  onTogglePause,
  onExport,
  onPickerOpen,
}: {
  onPickerOpen?: (open: boolean) => void
  source: SourceInfo | undefined
  name: string | null
  state: LiveState
  rate: number | null
  matchRate?: number | null
  buffered?: number
  heldAt?: number | null
  /** The id key most rows show (`request_id`), `null` when lines carry none. */
  stitchedBy?: string | null
  offlineReason?: string
  onTogglePause: () => void
  onExport?: () => void
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
      <SidebarToggle />
      <SourcePicker
        source={source}
        name={name}
        status={state === 'live' ? 'ok' : state === 'offline' ? 'idle' : 'warn'}
        onOpenChange={onPickerOpen}
      />
      {source && (
        <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{source.kind}</span>
      )}
      {stitchedBy !== undefined && (
        <span className="font-mono text-muted-foreground text-xs">
          · {stitchedBy ? `correlated by ${stitchedBy}` : 'no flow id found'}
        </span>
      )}
      <div className="flex-1" />
      {onExport && (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="outline" size="icon-sm" aria-label="Export these lines" onClick={onExport} />}
          >
            <FileDownIcon />
          </TooltipTrigger>
          <TooltipContent>Export these lines</TooltipContent>
        </Tooltip>
      )}
      <LiveIndicator
        state={state}
        rate={rate}
        matchRate={matchRate}
        buffered={buffered}
        heldAt={heldAt}
        offlineReason={offlineReason}
      />
      <Button
        variant={state === 'paused' ? 'default' : 'outline'}
        size="sm"
        onClick={onTogglePause}
        disabled={state === 'offline' || state === 'connecting'}
      >
        {state === 'paused' ? <PlayIcon /> : <PauseBars />}
        {state === 'paused' ? 'Resume' : 'Pause'}
        <Kbd className="ml-1">space</Kbd>
      </Button>
    </header>
  )
}
