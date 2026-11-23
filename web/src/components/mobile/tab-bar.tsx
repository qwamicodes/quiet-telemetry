import { Link, useRouterState } from '@tanstack/react-router'
import { PlugIcon, SearchIcon, SettingsIcon, TextIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

const TABS: {
  to: '/' | '/search' | '/sources' | '/settings'
  label: string
  Icon: ComponentType<{ className?: string }>
}[] = [
  { to: '/', label: 'Stream', Icon: TextIcon },
  { to: '/search', label: 'Search', Icon: SearchIcon },
  { to: '/sources', label: 'Sources', Icon: PlugIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

/** Phone navigation (10.1): four tabs on the sidebar colour, in place of the sidebar. */
export function MobileTabBar() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  // A flow belongs to the stream it was opened from.
  const active = (to: string) =>
    to === '/' ? path === '/' || path.startsWith('/flow') || path.startsWith('/line') : path.startsWith(to)
  return (
    <nav
      aria-label="Main"
      className="flex h-16 shrink-0 items-center justify-around border-t bg-sidebar pb-[max(12px,env(safe-area-inset-bottom))]"
    >
      {TABS.map(({ to, label, Icon }) => (
        <Link
          key={to}
          to={to}
          aria-current={active(to) ? 'page' : undefined}
          className={cn(
            'flex min-w-16 flex-col items-center gap-1 font-medium text-[11px] leading-[14px] outline-none focus-visible:text-foreground',
            active(to) ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-[18px]" />
          {label}
        </Link>
      ))}
    </nav>
  )
}
