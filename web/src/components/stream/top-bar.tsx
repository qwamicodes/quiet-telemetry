import { DownloadIcon, PauseIcon, PlayIcon } from 'lucide-react'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SourceInfo } from '@/gen'
import type { ConnState } from '@/lib/use-stream'
import { cn } from '@/lib/utils'

export type LiveState = 'live' | 'paused' | 'offline'

export function liveState(conn: ConnState, paused: boolean): LiveState {
  if (conn !== 'live') return 'offline'
  return paused ? 'paused' : 'live'
}

function LiveIndicator({ state, rate }: { state: LiveState; rate: number | null }) {
  const label = state === 'live' ? 'Live' : state === 'paused' ? 'Paused' : 'Offline'
  return (
    <span
      role="status"
      className={cn(
        'inline-flex h-7 items-center gap-2 border px-2.5 font-mono text-xs',
        state === 'live' && 'border-status-ok/30 bg-status-ok/10 text-status-ok',
        state === 'paused' && 'border-status-warn/30 bg-status-warn/10 text-status-warn',
        state === 'offline' && 'border-status-err/30 bg-status-err/10 text-status-err',
      )}
    >
      <StatusDot status={state === 'live' ? 'ok' : state === 'paused' ? 'warn' : 'err'} pulse={state === 'offline'} />
      {label}
      {state === 'live' && rate != null && (
        <span className="text-muted-foreground">· {rate < 10 ? rate.toFixed(1) : Math.round(rate)} lines/s</span>
      )}
    </span>
  )
}

export function TopBar({
  source,
  name,
  state,
  rate,
  onTogglePause,
  onExport,
}: {
  source: SourceInfo | undefined
  name: string | null
  state: LiveState
  rate: number | null
  onTogglePause: () => void
  onExport?: () => void
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
      <StatusDot status={state === 'live' ? 'ok' : 'idle'} />
      <h1 className="truncate font-medium text-base">{name ?? 'No source'}</h1>
      {source && (
        <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{source.kind}</span>
      )}
      {source?.group && <span className="font-mono text-muted-foreground text-xs">· {source.group}</span>}
      <div className="flex-1" />
      {onExport && (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="outline" size="icon-sm" aria-label="Export these lines" onClick={onExport} />}
          >
            <DownloadIcon />
          </TooltipTrigger>
          <TooltipContent>Export these lines</TooltipContent>
        </Tooltip>
      )}
      <LiveIndicator state={state} rate={rate} />
      <Button variant="outline" size="sm" onClick={onTogglePause} disabled={state === 'offline'}>
        {state === 'paused' ? <PlayIcon /> : <PauseIcon />}
        {state === 'paused' ? 'Resume' : 'Pause'}
        <Kbd className="ml-1">space</Kbd>
      </Button>
    </header>
  )
}
