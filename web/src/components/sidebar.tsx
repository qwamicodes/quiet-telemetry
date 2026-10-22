import { Link, useRouterState } from '@tanstack/react-router'
import { RowsIcon, SearchIcon, SettingsIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Logo } from '@/components/logo'
import { ReceiverBadge } from '@/components/receiver-badge'
import { SourceItem } from '@/components/source-item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useHealth, useSources } from '@/lib/api'
import { fmtWindow } from '@/lib/format'
import { useRates } from '@/lib/use-rates'
import { cn } from '@/lib/utils'

function NavItem({
  to,
  icon,
  badge,
  children,
}: {
  to: '/' | '/search' | '/settings'
  icon: ReactNode
  badge?: string
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true, includeSearch: false }}
      className="flex h-7 items-center gap-2.5 px-3 text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent data-[status=active]:bg-sidebar-accent data-[status=active]:text-foreground [&_svg]:size-3.5"
    >
      {icon}
      <span className="flex-1">{children}</span>
      {badge && <span className="font-mono text-[11px] text-muted-foreground">{badge}</span>}
    </Link>
  )
}

export function Sidebar({ activeSource, onOpenPalette }: { activeSource: string | null; onOpenPalette: () => void }) {
  const health = useHealth().data
  const sources = useSources().data
  const rates = useRates(sources)
  const onStream = useRouterState({ select: (s) => s.location.pathname === '/' })

  return (
    <aside className="flex min-h-0 w-62 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between px-4">
        <Logo />
        <span className="border border-sidebar-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          v{health?.version ?? '…'}
        </span>
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex h-7 w-full items-center gap-2 border border-input px-2 text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:border-ring"
        >
          <SearchIcon className="size-3.5" />
          <span className="flex-1 text-left">Jump to…</span>
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </button>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5 px-3">
        <NavItem to="/" icon={<RowsIcon />}>
          Stream
        </NavItem>
        <NavItem to="/search" icon={<SearchIcon />} badge={health ? fmtWindow(health.retention_ms) : undefined}>
          Search
        </NavItem>
        <NavItem to="/settings" icon={<SettingsIcon />}>
          Settings
        </NavItem>
      </nav>

      <div className="mt-6 flex items-center justify-between px-4 pb-1.5 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
        <span>Sources</span>
        <span>{sources?.length ?? ''}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {sources?.length === 0 && (
          <p className="px-3 py-2 text-muted-foreground text-xs">
            Waiting for logs… Start a container or POST to <code className="font-mono">/ingest/ndjson</code>.
          </p>
        )}
        {sources?.map((s) => (
          <SourceItem
            key={s.name}
            source={s}
            active={onStream && s.name === activeSource}
            rate={rates[s.name] ?? null}
          />
        ))}
      </div>

      <div
        className={cn(
          'flex h-11 items-center justify-between border-sidebar-border border-t px-4 font-mono text-[11px] text-muted-foreground',
        )}
      >
        <ReceiverBadge health={health} />
        <span>{health ? `${health.store} store` : ''}</span>
      </div>
    </aside>
  )
}
