import { Link, useRouterState } from '@tanstack/react-router'
import {
  BookOpenIcon,
  ChevronsDownUpIcon,
  KeyboardIcon,
  PlugIcon,
  PlusIcon,
  RowsIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Logo } from '@/components/logo'
import { SourceGroupHeader } from '@/components/source-group-header'
import { SourceItem } from '@/components/source-item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { UserMenu } from '@/components/user-menu'
import { useHealth, useSources } from '@/lib/api'
import { useConnection } from '@/lib/connection'
import { fmtWindow } from '@/lib/format'
import { groupSources, useCollapsedGroups } from '@/lib/source-groups'
import { useCustomGroups } from '@/lib/source-groups-api'
import { useRates } from '@/lib/use-rates'

function NavItem({
  to,
  icon,
  badge,
  children,
}: {
  to: '/' | '/search' | '/sources' | '/settings' | '/guide'
  icon: ReactNode
  badge?: string
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to !== '/settings' && to !== '/guide', includeSearch: false }}
      className="flex h-7 items-center gap-2.5 px-3 text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent data-[status=active]:bg-sidebar-accent data-[status=active]:text-foreground [&_svg]:size-3.5"
    >
      {icon}
      <span className="flex-1">{children}</span>
      {badge && <span className="font-mono text-[11px] text-muted-foreground">{badge}</span>}
    </Link>
  )
}

export function Sidebar({
  activeSource,
  onOpenPalette,
  onOpenShortcuts,
}: {
  activeSource: string | null
  onOpenPalette: () => void
  onOpenShortcuts?: () => void
}) {
  const health = useHealth().data
  // Server unreachable: rates would be stale, so they read "—" (design 08.7).
  const down = useConnection().down
  const sources = useSources().data
  const rates = useRates(sources)
  // Hidden sources stay under Sources and in search, not here (unless open now).
  const listed = sources?.filter((s) => !s.hidden || s.name === activeSource)
  // Custom groups first, in their order (06.9).
  const custom = useCustomGroups()
  const groups = groupSources(listed ?? [], listed ?? [], undefined, custom)
  // Grouping off, or a single group (say, only Ingest): no headers, just the list.
  const flat = groups.length <= 1
  const { isCollapsed, toggle, toggleAll, allCollapsed } = useCollapsedGroups()
  const keys = groups.map((g) => g.key)
  const onStream = useRouterState({ select: (s) => s.location.pathname === '/' })

  return (
    <aside className="flex min-h-0 w-62 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between px-4">
        <Logo />
        <span className="border border-sidebar-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          v{health ? health.version.split('.').slice(0, 2).join('.') : '…'}
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
        <NavItem to="/sources" icon={<PlugIcon />} badge={sources ? String(sources.length) : undefined}>
          Sources
        </NavItem>
        <NavItem to="/settings" icon={<SettingsIcon />}>
          Settings
        </NavItem>
        <NavItem to="/guide" icon={<BookOpenIcon />}>
          Guide
        </NavItem>
      </nav>

      <div className="mt-6 flex items-center justify-between px-4 pb-1.5 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
        <span>Sources</span>
        <span className="flex items-center gap-1">
          {listed?.length ?? ''}
          {!flat && (
            <button
              type="button"
              aria-label={allCollapsed(keys) ? 'Expand all groups' : 'Collapse all groups'}
              title={allCollapsed(keys) ? 'Expand all groups' : 'Collapse all groups'}
              onClick={() => toggleAll(keys)}
              className="flex size-4 items-center justify-center hover:text-foreground [&_svg]:size-3"
            >
              <ChevronsDownUpIcon />
            </button>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {sources?.length === 0 && (
          <div className="flex flex-col gap-1 border border-sidebar-border border-dashed px-3 py-2.5">
            <span className="text-[13px] text-foreground">Nothing connected yet</span>
            <span className="text-muted-foreground text-xs">Sources appear here as soon as they send a line.</span>
          </div>
        )}
        {(groups.length ? groups : [{ key: 'all', name: 'Sources', rows: listed ?? [] }]).map((g) => {
          // The open source stays visible even in a collapsed group.
          const collapsed = !flat && isCollapsed(g.key)
          const rows = collapsed ? g.rows.filter((s) => onStream && s.name === activeSource) : g.rows
          return (
            <section key={g.key} aria-label={g.name}>
              {!flat && 'kind' in g && (
                <SourceGroupHeader group={g} collapsed={collapsed} onToggle={() => toggle(g.key)} compact />
              )}
              {rows.map((s) => (
                <SourceItem
                  key={s.name}
                  source={s}
                  active={onStream && s.name === activeSource}
                  rate={down ? null : (rates[s.name] ?? null)}
                  nested={!flat}
                />
              ))}
            </section>
          )
        })}
        <Link
          to="/connect"
          className="mt-3 flex h-8 items-center justify-center gap-1.5 border border-sidebar-border border-dashed text-muted-foreground text-xs outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:bg-sidebar-accent [&_svg]:size-3.5"
        >
          <PlusIcon /> Connect a source
        </Link>
      </div>

      <div className="relative">
        <UserMenu />
        {onOpenShortcuts && (
          <button
            type="button"
            aria-label="Keyboard shortcuts (?)"
            title="Keyboard shortcuts (?)"
            onClick={onOpenShortcuts}
            className="absolute top-1/2 right-3 flex size-7 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground [&_svg]:size-4"
          >
            <KeyboardIcon />
          </button>
        )}
      </div>
    </aside>
  )
}
