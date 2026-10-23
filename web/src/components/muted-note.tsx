import { Link } from '@tanstack/react-router'
import { EyeOffIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * "N muted · show" (06.3): lines hidden by the source's muted-lines rules.
 * In search, `included` means they are in the results (setting or override):
 * "N muted lines included · Hide".
 */
export function MutedNote({
  count,
  shown,
  onToggle,
  source,
  className,
  included = false,
  rules,
  undo = false,
}: {
  count: number
  shown: boolean
  onToggle: () => void
  /** Search: the muted lines are included in the results, dimmed and tagged. */
  included?: boolean
  /** The stream: rules hiding lines here (`5 source rules + 3 global`). */
  rules?: { source: number; global: number }
  /** A mute was just made: `⌘Z undo mute`. */
  undo?: boolean
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
      {included ? (
        <span>
          <span className="text-foreground">{count.toLocaleString()}</span> muted {count === 1 ? 'line' : 'lines'}{' '}
          included
        </span>
      ) : rules ? (
        <span>
          {rules.source} source {rules.source === 1 ? 'rule' : 'rules'} + {rules.global} global ·{' '}
          <span className="text-foreground">{count.toLocaleString()}</span> {shown ? 'muted · shown' : 'hidden'}
        </span>
      ) : (
        <span>
          <span className="text-foreground">{count.toLocaleString()}</span> muted
          {shown ? ' · shown' : ' · hidden by muted-lines rules'}
        </span>
      )}
      <Button variant="ghost" size="xs" onClick={onToggle} aria-pressed={shown || included}>
        {included ? 'Hide' : shown ? 'Hide muted' : 'Show muted'}
      </Button>
      {source && (
        <Link
          to="/sources/$name"
          params={{ name: source }}
          search={{ edit: 'muted' }}
          className="text-brand hover:underline"
        >
          Edit rules
        </Link>
      )}
      {undo && (
        <span className="ml-auto flex items-center gap-1">
          <kbd className="border px-1 text-[10px]">⌘</kbd>
          <kbd className="border px-1 text-[10px]">Z</kbd> undo mute
        </span>
      )}
    </div>
  )
}
