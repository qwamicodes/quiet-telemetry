import { FileDownIcon, PauseIcon, PlayIcon } from 'lucide-react'
import { StatusDot } from '@/components/status-dot'
import { SourcePicker } from '@/components/stream/source-picker'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SourceInfo } from '@/gen'
import type { ConnState } from '@/lib/use-stream'
import { cn } from '@/lib/utils'

export type LiveState = 'connecting' | 'live' | 'paused' | 'offline'

export function liveState(conn: ConnState, paused: boolean, everConnected = true): LiveState {
  if (conn === 'connecting' || (conn !== 'live' && !everConnected)) return 'connecting'
  if (conn !== 'live') return 'offline'
  return paused ? 'paused' : 'live'
}

const fmtRate = (r: number) => (r < 10 ? r.toFixed(1).replace(/\.0$/, '') : String(Math.round(r)))

/** Live · 42 lines/s, Paused · buffering 38, Offline · reconnecting, Connecting (design 03.x, 08.4, 08.7). */
export function LiveIndicator({
  state,
  rate,
  matchRate,
  buffered,
  offlineReason = 'reconnecting',
}: {
  state: LiveState
  rate: number | null
  /** Set when filters are on: matches per second instead of lines. */
  matchRate?: number | null
  buffered?: number
  offlineReason?: string
}) {
  const label = { connecting: 'Connecting', live: 'Live', paused: 'Paused', offline: 'Offline' }[state]
  const detail =
    state === 'live'
      ? matchRate != null
        ? matchRate === 0
          ? '0 match'
          : `${fmtRate(matchRate)} match/s`
        : rate != null
          ? `${fmtRate(rate)} lines/s`
          : null
      : state === 'paused'
        ? buffered
          ? `buffering ${buffered.toLocaleString()}`
          : null
        : state === 'offline'
          ? offlineReason
          : null
  return (
    <span
      role="status"
      className={cn(
        'inline-flex h-7 items-center gap-2 border px-2.5 font-mono text-xs',
        state === 'live' && 'border-status-ok/30 bg-status-ok/10 text-status-ok',
        (state === 'paused' || state === 'connecting') && 'border-status-warn/30 bg-status-warn/10 text-status-warn',
        state === 'offline' && 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      <StatusDot
        status={state === 'live' ? 'ok' : state === 'offline' ? 'idle' : 'warn'}
        pulse={state === 'connecting'}
      />
      {label}
      {detail && <span className="text-muted-foreground">· {detail}</span>}
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
  stitchedBy,
  offlineReason,
  onTogglePause,
  onExport,
}: {
  source: SourceInfo | undefined
  name: string | null
  state: LiveState
  rate: number | null
  matchRate?: number | null
  buffered?: number
  /** The id key most rows show (`request_id`), `null` when lines carry none. */
  stitchedBy?: string | null
  offlineReason?: string
  onTogglePause: () => void
  onExport?: () => void
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
      <StatusDot status={state === 'live' ? 'ok' : state === 'offline' ? 'idle' : 'warn'} />
      <SourcePicker source={source} name={name} />
      {source && (
        <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{source.kind}</span>
      )}
      {stitchedBy !== undefined && (
        <span className="font-mono text-muted-foreground text-xs">
          · {stitchedBy ? `stitched by ${stitchedBy}` : 'no flow id found'}
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
        offlineReason={offlineReason}
      />
      <Button
        variant={state === 'paused' ? 'default' : 'outline'}
        size="sm"
        onClick={onTogglePause}
        disabled={state === 'offline' || state === 'connecting'}
      >
        {state === 'paused' ? <PlayIcon /> : <PauseIcon />}
        {state === 'paused' ? 'Resume' : 'Pause'}
        <Kbd className="ml-1">space</Kbd>
      </Button>
    </header>
  )
}
