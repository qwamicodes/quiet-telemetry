import { cn } from '@/lib/utils'
import { type ChangeKind, RELEASE } from '@/lib/whats-new'

/**
 * `new` / `updated` next to a nav item, tab or row (v0.1.1-00.4): new is a
 * filled tint, updated is outline only so it stays quieter. The text is the
 * label; screen readers hear "updated in v0.1.1". One marker per item.
 */
export function Marker({ kind, className }: { kind: ChangeKind; className?: string }) {
  return (
    <span
      data-slot="whats-new-marker"
      className={cn(
        'inline-flex h-4 shrink-0 items-center px-1.25 font-medium font-mono text-[11px] text-level-info leading-3',
        kind === 'new' ? 'bg-level-info-muted' : 'border border-brand/45',
        className,
      )}
    >
      {kind}
      <span className="sr-only"> in v{RELEASE}</span>
    </span>
  )
}

/** The unseen dot on the version chip. */
export function UnseenDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
}
