import { Outlet, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { CommandPalette } from '@/components/command-palette'
import { SessionExpired } from '@/components/session-expired'
import { Sidebar } from '@/components/sidebar'
import { SystemBanners } from '@/components/system-banners'
import { useAuth } from '@/lib/auth-api'
import { setDisplayTimeZone } from '@/lib/format'
import { useSettings } from '@/lib/settings-api'
import { useHotkeys } from '@/lib/use-hotkeys'

/** Instance-wide display settings: tab title and timezone. */
function useInstanceDisplay() {
  const name = useAuth().data?.instance_name
  const tz = useSettings().data?.general.timezone
  // Set during render so the first rows already use the zone.
  if (tz) setDisplayTimeZone(tz)
  const title = name && name !== 'quiet' ? `${name} · quiet` : 'quiet'
  if (typeof document !== 'undefined' && document.title !== title) document.title = title
}

export function AppShell() {
  const [palette, setPalette] = useState(false)
  const source = useRouterState({
    select: (s) => (s.location.search as { source?: string }).source ?? null,
  })
  useHotkeys({ 'mod+k': () => setPalette((o) => !o) })
  useInstanceDisplay()

  return (
    <div className="flex h-full min-h-0">
      <Sidebar activeSource={source} onOpenPalette={() => setPalette(true)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <SystemBanners />
        <Outlet />
      </main>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <SessionExpired />
    </div>
  )
}
