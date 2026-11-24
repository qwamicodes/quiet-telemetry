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
import { SIDEBAR_ID, SidebarResizeHandle } from '@/components/sidebar-resize'
import { SourceGroupHeader } from '@/components/source-group-header'
import { SourceItem } from '@/components/source-item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { UserMenu } from '@/components/user-menu'
import { Marker, UnseenDot } from '@/components/whats-new/marker'
import { useHealth, useSources } from '@/lib/api'
import { useConnection } from '@/lib/connection'
import { fmtWindow } from '@/lib/format'
import { useNoSourcePasses } from '@/lib/lint-api'
import { useSystem } from '@/lib/settings-api'
import { useSidebar } from '@/lib/sidebar'
import { groupSources, sidebarFlag, useCollapsedGroups } from '@/lib/source-groups'
import { useCustomGroups } from '@/lib/source-groups-api'
import { useRates } from '@/lib/use-rates'
import { type ChangeKind, setWhatsNewOpen, useWhatsNew } from '@/lib/whats-new'

function NavItem({
  to,
  icon,
  badge,
  dot,
  marker,
  children,
}: {
  to: '/' | '/search' | '/sources' | '/settings' | '/guide'
  icon: ReactNode
  badge?: string
  /** A small brand dot after the label (Guide, 11.6 A). */
  dot?: string
  /** `new` / `updated` from What's new, rolled up (00.4). */
  marker?: ChangeKind | null
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to !== '/settings' && to !== '/guide', includeSearch: false }}
      className="flex h-7 items-center gap-2.5 px-3 text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent data-[status=active]:bg-sidebar-accent data-[status=active]:text-foreground [&_svg]:size-3.5"
    >
      {icon}
      <span className="flex flex-1 items-center gap-2">
        {children}
        {dot && <span role="img" aria-label={dot} className="size-1.5 bg-brand" />}
      </span>
      {marker && <Marker kind={marker} />}
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
  const noPass = useNoSourcePasses((sources ?? []).filter((s) => !s.hidden).map((s) => s.name))
  const rates = useRates(sources)
  const system = useSystem().data
  const flagInput = {
    dockerDown: system?.docker.state === 'unavailable',
    rejected: system?.ingest.recent ?? [],
  }
  // Hidden sources stay under Sources and in search, not here (unless open now).
  const listed = sources?.filter((s) => !s.hidden || s.name === activeSource)
  // Custom groups first, in their order (06.9).
  const custom = useCustomGroups()
  const groups = groupSources(listed ?? [], listed ?? [], undefined, custom)
  // Grouping off: no headers, just the list. A single group (say, only
  // Ingest) keeps its header, like any other (06.7).
  const flat = groups.length === 0
  const { isCollapsed, toggle, toggleAll, allCollapsed } = useCollapsedGroups()
  const keys = groups.map((g) => g.key)
  const onStream = useRouterState({ select: (s) => s.location.pathname === '/' })
  const { hidden } = useSidebar()
  const whatsNew = useWhatsNew()

  return (
    <aside
      id={SIDEBAR_ID}
      data-slot="app-sidebar"
      data-hidden={hidden ? '' : undefined}
      aria-label="Sidebar"
      className="relative flex min-h-0 w-62 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-14 items-center justify-between px-4">
        <Logo />
        <button
          type="button"
          onClick={() => setWhatsNewOpen(true)}
          aria-label={
            whatsNew.unseen.length
              ? `v${health?.version ?? ''}, ${whatsNew.unseen.length} unseen changes · What's new`
              : `v${health?.version ?? ''} · What's new`
          }
          title="What's new"
          className="flex h-4.5 items-center gap-1.25 border border-border px-1.5 font-medium font-mono text-[11px] text-muted-foreground leading-3 outline-none hover:text-foreground focus-visible:border-ring"
        >
          v{health ? health.version : '…'}
          {whatsNew.unseen.length > 0 && <UnseenDot />}
        </button>
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
        <NavItem to="/" icon={<RowsIcon />} marker={whatsNew.marker('stream')}>
          Stream
        </NavItem>
        <NavItem to="/search" icon={<SearchIcon />} badge={health ? fmtWindow(health.retention_ms) : undefined}>
          Search
        </NavItem>
        <NavItem
          to="/sources"
          icon={<PlugIcon />}
          marker={whatsNew.marker('sources')}
          badge={sources ? String(sources.length) : undefined}
        >
          Sources
        </NavItem>
        <NavItem to="/settings" icon={<SettingsIcon />} marker={whatsNew.marker('settings')}>
          Settings
        </NavItem>
        <NavItem
          to="/guide"
          icon={<BookOpenIcon />}
          marker={whatsNew.marker('guide')}
          dot={noPass ? 'No source passes Check my logs yet' : undefined}
        >
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
                  group={flat ? undefined : g.name}
                  flag={sidebarFlag(s, flagInput)}
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
      <SidebarResizeHandle />
    </aside>
  )
}
