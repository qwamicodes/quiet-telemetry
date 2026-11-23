import { cn } from '@/lib/utils'
import type { ChangeKind } from '@/lib/whats-new'

/**
 * `new` / `updated` next to a nav item, tab or row (v0.1.1-00.4). The text is
 * the label, so screen readers hear it too; one marker per item.
 */
export function Marker({ kind, className }: { kind: ChangeKind; className?: string }) {
  return (
    <span
      data-slot="whats-new-marker"
      className={cn(
        'shrink-0 border px-1 font-mono text-[10px] leading-4 lowercase',
        kind === 'new' ? 'border-brand/40 bg-brand/10 text-brand' : 'border-border text-muted-foreground',
        className,
      )}
    >
      {kind}
    </span>
  )
}

/** The unseen dot on the version chip. */
export function UnseenDot({ label }: { label: string }) {
  return <span role="img" aria-label={label} className="size-1.5 shrink-0 bg-brand" />
}
