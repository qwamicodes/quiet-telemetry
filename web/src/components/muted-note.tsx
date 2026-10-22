import { Link } from '@tanstack/react-router'
import { EyeOffIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** "N muted · show" (06.3): lines hidden by the source's muted-lines rules. */
export function MutedNote({
  count,
  shown,
  onToggle,
  source,
  className,
}: {
  count: number
  shown: boolean
  onToggle: () => void
  /** Links to the rules when one source is in view. */
  source?: string
  className?: string
}) {
  return (
    <div
      data-testid="muted-note"
      className={className ?? 'mx-6 mb-2 flex items-center gap-2 font-mono text-muted-foreground text-xs'}
    >
      <EyeOffIcon className="size-3.5" />
      <span>
        <span className="text-foreground">{count.toLocaleString()}</span> muted
        {shown ? ' · shown' : ' · hidden by this source’s muted-lines rules'}
      </span>
      <Button variant="ghost" size="xs" onClick={onToggle} aria-pressed={shown}>
        {shown ? 'Hide muted' : 'Show muted'}
      </Button>
      {source && (
        <Link
          to="/sources/$name"
          params={{ name: source }}
          search={{ tab: 'settings' }}
          className="text-brand hover:underline"
        >
          Edit rules
        </Link>
      )}
    </div>
  )
}
