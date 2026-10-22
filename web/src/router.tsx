import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
  redirect,
  useRouterState,
} from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { BrokenLink } from '@/components/broken-link'
import { ServerUnreachable } from '@/components/server-unreachable'
import { authQuery, inviteParams, resetParams, signInSearch } from '@/lib/auth-api'
import { connectSearch } from '@/lib/connect'
import {
  flowParams,
  flowSearch,
  lineParams,
  searchSearch,
  sourceParams,
  sourceSearch,
  streamSearch,
} from '@/lib/search-params'
import { makeQueryClient } from '@/providers'
import { BrokenAuthLink, InvitePage, ResetPage, SetupPage, SignInPage } from '@/routes/auth'
import { ConnectPage } from '@/routes/connect'
import { FlowPage, LineFlowPage } from '@/routes/flow'
import {
  SettingsAbout,
  SettingsAccount,
  SettingsAppearance,
  SettingsFlowIds,
  SettingsGeneral,
  SettingsLayout,
  SettingsMembers,
  SettingsStorage,
  SettingsTokens,
} from '@/routes/settings'
import { SourceDetailPage } from '@/routes/source-detail'
import { SourcesPage } from '@/routes/sources'
import { StreamPage } from '@/routes/stream'

/** Pages that work signed out: they render without the app shell. */
const PUBLIC = /^\/(setup|signin|invite\/[^/]*|reset\/[^/]*)\/?$/
export const isPublicPath = (path: string) => PUBLIC.test(path)

function RootLayout() {
  const bare = useRouterState({ select: (s) => isPublicPath(s.location.pathname) })
  return bare ? <Outlet /> : <AppShell />
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Every app page needs a session: no owner yet → setup, signed out → sign in
  // (coming back here afterwards).
  beforeLoad: async ({ context, location }) => {
    const st = await context.queryClient.ensureQueryData(authQuery)
    if (isPublicPath(location.pathname)) return
    if (st.setup_required) throw redirect({ to: '/setup' })
    if (!st.user) throw redirect({ to: '/signin', search: { redirect: location.href } })
  },
  component: RootLayout,
  errorComponent: ServerUnreachable,
})

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: async ({ context }) => {
    const st = await context.queryClient.ensureQueryData(authQuery)
    if (!st.setup_required) throw redirect({ to: st.user ? '/' : '/signin' })
  },
  component: SetupPage,
})

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  validateSearch: signInSearch,
  beforeLoad: async ({ context, search }) => {
    const st = await context.queryClient.ensureQueryData(authQuery)
    if (st.setup_required) throw redirect({ to: '/setup' })
    if (st.user) throw redirect({ href: search.redirect ?? '/' })
  },
  component: SignInPage,
})

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  params: { parse: (p) => inviteParams.parse(p), stringify: ({ token }) => ({ token }) },
  component: InvitePage,
  errorComponent: BrokenAuthLink,
})

const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset/$token',
  params: { parse: (p) => resetParams.parse(p), stringify: ({ token }) => ({ token }) },
  component: ResetPage,
  errorComponent: BrokenAuthLink,
})

export const streamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: streamSearch,
  component: StreamPage,
})

export const flowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/flow/$id',
  params: { parse: (p) => flowParams.parse(p), stringify: ({ id }) => ({ id }) },
  validateSearch: flowSearch,
  component: FlowPage,
  errorComponent: BrokenLink,
})

export const lineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/line/$lineId',
  params: { parse: (p) => lineParams.parse(p), stringify: ({ lineId }) => ({ lineId: String(lineId) }) },
  validateSearch: flowSearch,
  component: LineFlowPage,
  errorComponent: BrokenLink,
})

export const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: searchSearch,
  // Its own chunk: search + export aren't needed to watch the stream.
  component: lazyRouteComponent(() => import('@/routes/search'), 'SearchPage'),
})

export const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connect',
  validateSearch: connectSearch,
  component: ConnectPage,
})

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sources',
  component: SourcesPage,
})

export const sourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sources/$name',
  params: { parse: (p) => sourceParams.parse(p), stringify: ({ name }) => ({ name }) },
  validateSearch: sourceSearch,
  component: SourceDetailPage,
  errorComponent: BrokenLink,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsLayout,
})
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: SettingsGeneral,
})
const settingsTokensRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/ingest-tokens',
  component: SettingsTokens,
})
const settingsAccountRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/account',
  component: SettingsAccount,
})
const settingsMembersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/members',
  component: SettingsMembers,
})
const settingsStorageRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/storage',
  component: SettingsStorage,
})
const settingsFlowIdsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/flow-id-order',
  component: SettingsFlowIds,
})
const settingsAboutRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/about',
  component: SettingsAbout,
})
const settingsAppearanceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/appearance',
  component: SettingsAppearance,
})

export const routeTree = rootRoute.addChildren([
  setupRoute,
  signInRoute,
  inviteRoute,
  resetRoute,
  streamRoute,
  searchRoute,
  flowRoute,
  lineRoute,
  connectRoute,
  sourcesRoute,
  sourceDetailRoute,
  settingsRoute.addChildren([
    settingsIndexRoute,
    settingsAccountRoute,
    settingsMembersRoute,
    settingsTokensRoute,
    settingsFlowIdsRoute,
    settingsStorageRoute,
    settingsAppearanceRoute,
    settingsAboutRoute,
  ]),
])

/**
 * `history` is for tests (memory history); the app uses the browser's. Pass
 * the same `queryClient` as `<Providers>` so the route guards and the pages
 * share the signed-in state.
 */
export function makeRouter(history?: RouterHistory, queryClient: QueryClient = makeQueryClient()) {
  return createRouter({ routeTree, history, defaultPreload: 'intent', context: { queryClient } })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
