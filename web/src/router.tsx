import { createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { LEVEL_FILTERS, type LevelFilter } from '@/lib/format'
import { FlowPage } from '@/routes/flow'
import { SettingsPage } from '@/routes/settings'
import { StreamPage } from '@/routes/stream'

export interface StreamSearch {
  source?: string
  level?: LevelFilter
  q?: string
}

const rootRoute = createRootRoute({ component: AppShell })

export const streamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (s: Record<string, unknown>): StreamSearch => ({
    source: typeof s.source === 'string' && s.source ? s.source : undefined,
    level: LEVEL_FILTERS.includes(s.level as never) ? (s.level as LevelFilter) : undefined,
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
  }),
  component: StreamPage,
})

export const flowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/flow/$id',
  component: FlowPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

export const routeTree = rootRoute.addChildren([streamRoute, flowRoute, settingsRoute])

/** `history` is for tests (memory history); the app uses the browser's. */
export function makeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history, defaultPreload: 'intent' })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
