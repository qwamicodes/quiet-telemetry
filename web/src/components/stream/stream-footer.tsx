import { EyeOffIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { LiveState } from './top-bar'

/** Lines hidden by mute rules on this source (03.17): shown in the footer. */
export interface FooterMuted {
  /** Enabled rules hiding lines here, source and global together. */
  rules: number
  count: number
  shown: boolean
  onToggle: () => void
  /** A mute was just made: `⌘Z undo mute` replaces the key hints. */
  undo: boolean
}

/** State on the left (one sentence that changes with the stream), keys on the right. */
export function StreamFooter({
  state,
  text,
  muted,
  hint,
}: {
  state: LiveState | 'filtered' | 'quiet' | 'errors'
  text: string
  muted?: FooterMuted
  /** Replaces the key hints, e.g. while a row is hovered (03.15) or the picker is open (03.8). */
  hint?: ReactNode
}) {
  const dot =
    state === 'live' || state === 'quiet'
      ? 'ok'
      : state === 'paused' || state === 'connecting' || state === 'filtered'
        ? 'warn'
        : 'idle'
  return (
    <footer className="flex h-8 shrink-0 items-center gap-2 border-t px-3 font-mono text-[11px] text-muted-foreground">
      <StatusDot status={state === 'errors' ? 'err' : state === 'filtered' ? 'ok' : dot} />
      <span data-testid="stream-footer" className="truncate">
        {text}
      </span>
      {muted && (
        <span data-testid="muted-note" className="flex shrink-0 items-center gap-1.5">
          <span className="text-border">·</span>
          <EyeOffIcon className="size-3.5" />
          <span>
            {muted.rules} mute {muted.rules === 1 ? 'rule' : 'rules'} ·{' '}
            <span className="text-foreground">{muted.count.toLocaleString()}</span>{' '}
            {muted.shown ? 'muted · shown' : 'hidden'}
          </span>
          <Button variant="ghost" size="xs" onClick={muted.onToggle} aria-pressed={muted.shown}>
            {muted.shown ? 'Hide muted' : 'Show muted'}
          </Button>
        </span>
      )}
      <span className="flex-1" />
      {muted?.undo ? (
        <span className="hidden shrink-0 items-center gap-1.5 md:flex">
          <Kbd>⌘</Kbd>
          <Kbd>Z</Kbd> undo mute
        </span>
      ) : (
        <span className="hidden shrink-0 items-center gap-1.5 md:flex">
          {hint ?? (
            <>
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> move <Kbd className="ml-2">↵</Kbd> open flow <Kbd className="ml-2">space</Kbd> pause{' '}
              <Kbd className="ml-2">?</Kbd> shortcuts
            </>
          )}
        </span>
      )}
    </footer>
  )
}
