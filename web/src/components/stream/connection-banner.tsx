import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

function useCountdown(at: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

export function ConnectionBanner({
  attempt,
  retryAt,
  onRetry,
}: {
  attempt: number
  retryAt: number | null
  onRetry: () => void
}) {
  const secs = useCountdown(retryAt)
  return (
    <div
      role="alert"
      className="mx-6 mb-3 flex items-center gap-3 border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-status-warn text-xs"
    >
      <TriangleAlertIcon className="size-3.5" />
      <span className="flex-1">
        Lost connection to the server. Reconnecting{secs != null && secs > 0 ? ` in ${secs}s` : '…'}
        {attempt > 1 && <span className="text-muted-foreground"> · attempt {attempt}</span>}
      </span>
      <Button variant="ghost" size="xs" onClick={onRetry}>
        <RefreshCwIcon />
        Retry now
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
