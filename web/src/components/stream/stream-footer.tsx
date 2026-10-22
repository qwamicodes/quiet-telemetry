import { StatusDot } from '@/components/status-dot'
import { Kbd } from '@/components/ui/kbd'
import type { LiveState } from './top-bar'

export function StreamFooter({ state, count }: { state: LiveState; count: number }) {
  const label = state === 'live' ? 'streaming' : state === 'paused' ? 'paused' : 'offline'
  return (
    <footer className="flex h-9 shrink-0 items-center gap-2 border-t px-3 font-mono text-[11px] text-muted-foreground">
      <StatusDot status={state === 'live' ? 'ok' : state === 'paused' ? 'warn' : 'err'} />
      <span>
        {label} · newest at bottom · {count.toLocaleString()} lines in view
      </span>
      <span className="flex-1" />
      <span className="hidden items-center gap-1.5 md:flex">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd> move <Kbd className="ml-2">esc</Kbd> close <Kbd className="ml-2">space</Kbd> pause{' '}
        <Kbd className="ml-2">/</Kbd> filter <Kbd className="ml-2">⌘K</Kbd> jump
      </span>
    </footer>
  )
}
