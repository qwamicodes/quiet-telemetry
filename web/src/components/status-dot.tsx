import { cn } from '@/lib/utils'

export type DotTone = 'ok' | 'warn' | 'err' | 'idle' | 'brand'

const tone: Record<DotTone, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  err: 'bg-status-err',
  idle: 'bg-status-idle',
  brand: 'bg-brand',
}

/** The one round thing in Lyra. */
export function StatusDot({ status, pulse, className }: { status: DotTone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-1.5 shrink-0 rounded-full', tone[status], pulse && 'animate-pulse', className)}
    />
  )
}
