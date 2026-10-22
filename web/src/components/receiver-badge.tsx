import { StatusDot } from '@/components/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Health } from '@/gen'

export function ReceiverBadge({ health }: { health: Health | undefined }) {
  if (!health) return <span className="text-muted-foreground">…</span>
  const d = health.docker
  const label =
    d.state === 'connected'
      ? `docker · ${d.containers}`
      : d.state === 'unavailable'
        ? 'docker unavailable'
        : d.state === 'disabled'
          ? 'docker off'
          : 'docker…'
  const tone = d.state === 'connected' ? 'ok' : d.state === 'unavailable' ? 'err' : 'idle'
  const badge = (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot status={tone} />
      {label}
    </span>
  )
  if (d.state !== 'unavailable') return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default" />}>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 font-mono">
        {d.error}
      </TooltipContent>
    </Tooltip>
  )
}
