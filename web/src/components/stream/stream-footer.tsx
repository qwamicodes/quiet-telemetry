import { StatusDot } from '@/components/status-dot'
import { Kbd } from '@/components/ui/kbd'
import type { LiveState } from './top-bar'

/** State on the left (one sentence that changes with the stream), keys on the right. */
export function StreamFooter({ state, text }: { state: LiveState | 'filtered' | 'quiet'; text: string }) {
  const dot =
    state === 'live' || state === 'quiet'
      ? 'ok'
      : state === 'paused' || state === 'connecting' || state === 'filtered'
        ? 'warn'
        : 'idle'
  return (
    <footer className="flex h-9 shrink-0 items-center gap-2 border-t px-3 font-mono text-[11px] text-muted-foreground">
      <StatusDot status={state === 'filtered' ? 'ok' : dot} />
      <span data-testid="stream-footer" className="truncate">
        {text}
      </span>
      <span className="flex-1" />
      <span className="hidden shrink-0 items-center gap-1.5 md:flex">
        <Kbd>J</Kbd>
        <Kbd>K</Kbd> move <Kbd className="ml-2">↵</Kbd> open flow <Kbd className="ml-2">space</Kbd> pause{' '}
        <Kbd className="ml-2">?</Kbd> shortcuts
      </span>
    </footer>
  )
}
