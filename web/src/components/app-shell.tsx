import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { CommandPalette } from '@/components/command-palette'
import { SessionExpired } from '@/components/session-expired'
import { ShortcutsSheet } from '@/components/shortcuts-sheet'
import { Sidebar } from '@/components/sidebar'
import { ServerUnreachableBanner } from '@/components/stream/connection-banner'
import { SystemBanners } from '@/components/system-banners'
import { useAuth } from '@/lib/auth-api'
import { setDisplayTimeZone, setPublicUrl, setTimestampStyle } from '@/lib/format'
import { copyPrompt, stackNow } from '@/lib/guide'
import { useSettings } from '@/lib/settings-api'
import { useTheme } from '@/lib/theme'
import { useHotkeys, useKeySequences } from '@/lib/use-hotkeys'

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
  const source = useRouterState({
    select: (s) => (s.location.search as { source?: string }).source ?? null,
  })
  useHotkeys({
    'mod+k': () => setPalette((o) => !o),
    '?': () => setKeys((o) => !o),
    'mod+/': () => navigate({ to: '/search' }),
    s: () => navigate({ to: '/sources' }),
    t: toggle,
    // ⌘⇧C copies the agent logging prompt anywhere (Guide boards 11.x).
    'mod+shift+c': () => void copyPrompt(stackNow()),
  })
  useKeySequences({
    'g h': () => navigate({ to: '/guide' }),
    'g l': () => navigate({ to: '/guide', search: { tab: 'check' } }),
  })
  useInstanceDisplay()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ServerUnreachableBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar activeSource={source} onOpenPalette={() => setPalette(true)} onOpenShortcuts={() => setKeys(true)} />
        <main className="flex min-w-0 flex-1 flex-col">
          <SystemBanners />
          <Outlet />
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} onOpenShortcuts={() => setKeys(true)} />
      <ShortcutsSheet open={keys} onOpenChange={setKeys} />
      <SessionExpired />
    </div>
  )
}
