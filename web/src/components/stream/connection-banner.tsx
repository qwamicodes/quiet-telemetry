import { CableIcon, RefreshCwIcon, TriangleAlertIcon, UnplugIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useConnection } from '@/lib/connection'
import { fmtTime } from '@/lib/format'

export function useCountdown(at: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

/**
 * Across the top of the whole app when the live connection to the server
 * drops (design 08.7). Lines keep arriving on the server; the stream replays
 * them on reconnect.
 */
export function ServerUnreachableBanner() {
  const c = useConnection()
  const secs = useCountdown(c.retryAt)
  if (!c.down) return null
  return (
    <div
      role="alert"
      className="flex h-9 shrink-0 items-center gap-3 border-status-warn/30 border-b bg-status-warn/10 px-4 text-xs"
    >
      <UnplugIcon className="size-3.5 text-status-warn" />
      <span className="font-medium">Can't reach the quiet server</span>
      <span className="truncate font-mono text-muted-foreground">
        {c.since != null && `· live connection closed at ${fmtTime(c.since).slice(0, 8)} `}·{' '}
        {secs != null && secs > 0 ? `retrying in ${secs}s` : 'retrying'}
        {c.attempt > 1 && ` (attempt ${c.attempt})`} · lines keep arriving on the server, you'll get them on reconnect
      </span>
      <span className="flex-1" />
      <Button variant="outline" size="xs" onClick={c.retry}>
        <RefreshCwIcon />
        Retry now
      </Button>
    </div>
  )
}

/** A Docker source whose log stream dropped while the server is fine (design 03.7). */
export function SourceLostBanner({
  source,
  lastTs,
  onRetry,
}: {
  source: string
  lastTs: number | null
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      className="mx-6 mb-3 flex items-center gap-3 border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-xs"
    >
      <CableIcon className="size-3.5 text-status-warn" />
      <span>
        Lost the docker stream for <span className="font-medium">{source}</span>
        <span className="font-mono text-muted-foreground">
          {' '}
          · reconnecting{lastTs ? ` · last line ${fmtTime(lastTs).slice(0, 8)}` : ''} · on reconnect quiet backfills
          from Docker's log
        </span>
      </span>
      <span className="flex-1" />
      <Button variant="ghost" size="xs" onClick={onRetry}>
        <RefreshCwIcon />
        Retry now
      </Button>
    </div>
  )
}

/** Errors spiking against the window's usual share (design 03.4). */
export function ErrorRateBanner({
  share,
  usual,
  top,
  onErrorsOnly,
  onGroup,
}: {
  share: number
  usual: number
  top: { label: string; count: number } | null
  onErrorsOnly: () => void
  onGroup: () => void
}) {
  const pct = (n: number) => `${n < 1 && n > 0 ? n.toFixed(1) : Math.round(n)}%`
  return (
    <div
      role="status"
      className="mx-6 mb-3 flex items-center gap-3 border border-status-err/30 bg-status-err/10 px-3 py-2 text-xs"
    >
      <TriangleAlertIcon className="size-3.5 text-status-err" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-status-err">Errors are {pct(share)} of lines in the last 5 min</span>
        <span className="text-muted-foreground"> (usually {pct(usual)})</span>
        {top && (
          <span className="font-mono text-muted-foreground">
            {' '}
            · {top.count} × {top.label}
          </span>
        )}
      </span>
      <span className="flex-1" />
      <Button variant="outline" size="xs" onClick={onErrorsOnly}>
        Show errors only
      </Button>
      <Button variant="ghost" size="xs" onClick={onGroup}>
        Group by flow
      </Button>
    </div>
  )
}

export function GapBanner({ dropped }: { dropped: number }) {
  return (
    <div
      role="status"
      className="mx-6 mb-3 border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-status-warn text-xs"
    >
      {dropped.toLocaleString()} lines skipped while the view caught up.
    </div>
  )
}
