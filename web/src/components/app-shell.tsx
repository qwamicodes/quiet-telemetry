import { Outlet, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { CommandPalette } from '@/components/command-palette'
import { Sidebar } from '@/components/sidebar'
import { useHotkeys } from '@/lib/use-hotkeys'

export function AppShell() {
  const [palette, setPalette] = useState(false)
  const source = useRouterState({
    select: (s) => (s.location.search as { source?: string }).source ?? null,
  })
  useHotkeys({ 'mod+k': () => setPalette((o) => !o) })

  return (
    <div className="flex h-full min-h-0">
      <Sidebar activeSource={source} onOpenPalette={() => setPalette(true)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  )
}
