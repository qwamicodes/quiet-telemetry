import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { flowSearch, searchSearch, streamSearch } from '@/lib/search-params'
import { FlowPage } from '@/routes/flow'
import { SettingsPage } from '@/routes/settings'
import { StreamPage } from '@/routes/stream'

const rootRoute = createRootRoute({ component: AppShell })

export const streamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: streamSearch,
  component: StreamPage,
})

export const flowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/flow/$id',
  validateSearch: flowSearch,
  component: FlowPage,
})

export const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: searchSearch,
  // Its own chunk: search + export aren't needed to watch the stream.
  component: lazyRouteComponent(() => import('@/routes/search'), 'SearchPage'),
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

export const routeTree = rootRoute.addChildren([streamRoute, searchRoute, flowRoute, settingsRoute])

/** `history` is for tests (memory history); the app uses the browser's. */
export function makeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history, defaultPreload: 'intent' })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
