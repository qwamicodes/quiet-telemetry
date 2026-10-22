import type { Level } from '@/gen'
import { cn } from '@/lib/utils'

const styles: Record<Level, string> = {
  trace: 'bg-level-debug-muted text-level-debug',
  debug: 'bg-level-debug-muted text-level-debug',
  info: 'bg-level-info-muted text-level-info',
  warn: 'bg-level-warn-muted text-level-warn',
  error: 'bg-level-error-muted text-level-error',
  fatal: 'bg-level-error-muted text-level-error',
}

export function LevelBadge({ level, className }: { level: Level | null; className?: string }) {
  if (!level) return null
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center px-1.5 font-mono text-[11px] leading-none',
        styles[level],
        className,
      )}
    >
      {level}
    </span>
  )
}
