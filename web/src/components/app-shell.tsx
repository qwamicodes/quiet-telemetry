import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { type CSSProperties, useState } from 'react'
import { CommandPalette } from '@/components/command-palette'
import { SessionExpired } from '@/components/session-expired'
import { ShortcutsSheet } from '@/components/shortcuts-sheet'
import { Sidebar } from '@/components/sidebar'
import { SidebarToggle } from '@/components/sidebar-resize'
import { ServerUnreachableBanner } from '@/components/stream/connection-banner'
import { SystemBanners } from '@/components/system-banners'
import { useAuth } from '@/lib/auth-api'
import { setDisplayTimeZone, setPublicUrl, setTimestampStyle } from '@/lib/format'
import { copyPrompt, stackNow } from '@/lib/guide'
import { useSettings } from '@/lib/settings-api'
import { SidebarProvider, useSidebarPrefs } from '@/lib/sidebar'
import { SIDEBAR_DESKTOP } from '@/lib/sidebar-width'
import { useTheme } from '@/lib/theme'
import { useHotkeys, useKeySequences } from '@/lib/use-hotkeys'
import { cn } from '@/lib/utils'

/** Instance-wide display settings: tab title and timezone. */
function useInstanceDisplay() {
  const name = useAuth().data?.instance_name
  const general = useSettings().data?.general
  // Set during render so the first rows already use the zone and style.
  if (general) {
    setDisplayTimeZone(general.timezone)
    setTimestampStyle(general.timestamps)
    setPublicUrl(general.public_url)
  }
  const title = name && name !== 'quiet' ? `${name} · quiet` : 'quiet'
  if (typeof document !== 'undefined' && document.title !== title) document.title = title
}

export function AppShell() {
  const [palette, setPalette] = useState(false)
  const [keys, setKeys] = useState(false)
  const navigate = useNavigate()
  const { toggle } = useTheme()
  const sidebar = useSidebarPrefs()
  const floatToggle = sidebar.hidden && sidebar.inlineToggles === 0
  const source = useRouterState({
    select: (s) => (s.location.search as { source?: string }).source ?? null,
  })
  useHotkeys({
    'mod+k': () => setPalette((o) => !o),
    '?': () => setKeys((o) => !o),
    'mod+/': () => navigate({ to: '/search' }),
    s: () => navigate({ to: '/sources' }),
    t: toggle,
    // ⌘B hides / shows the sidebar (desktop; on mobile it is a fixed column).
    'mod+b': () => {
      if (window.innerWidth >= SIDEBAR_DESKTOP) sidebar.toggle()
    },
    // ⌘⇧C copies the agent logging prompt anywhere (Guide boards 11.x).
    'mod+shift+c': () => void copyPrompt(stackNow()),
  })
  useKeySequences({
    'g h': () => navigate({ to: '/guide' }),
    'g l': () => navigate({ to: '/guide', search: { tab: 'check' } }),
  })
  useInstanceDisplay()

  return (
    <SidebarProvider value={sidebar}>
      <div className="flex h-full min-h-0 flex-col">
        <ServerUnreachableBanner />
        <div
          className="flex min-h-0 flex-1"
          data-sidebar-root
          style={{ '--sidebar-w': `${sidebar.width}px` } as CSSProperties}
        >
          <Sidebar activeSource={source} onOpenPalette={() => setPalette(true)} onOpenShortcuts={() => setKeys(true)} />
          <main
            className={cn(
              'relative flex min-w-0 flex-1 flex-col',
              // Screens without a top bar: the toggle floats top-left and the page moves over for it.
              floatToggle && 'md:pl-10',
            )}
          >
            {floatToggle && <SidebarToggle floating className="absolute top-3.5 left-3 z-30" />}
            <SystemBanners />
            <Outlet />
          </main>
        </div>
        <CommandPalette open={palette} onOpenChange={setPalette} onOpenShortcuts={() => setKeys(true)} />
        <ShortcutsSheet open={keys} onOpenChange={setKeys} />
        <SessionExpired />
      </div>
    </SidebarProvider>
  )
}
