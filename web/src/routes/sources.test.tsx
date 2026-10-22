import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bucket, Health, SettingsResponse, SourceActivity, SourceFields, SourceInfo, StreamStats } from '@/gen'
import { DEFAULT_SOURCE_SETTINGS } from '@/lib/settings-api'
import { resetCollapsedGroups } from '@/lib/source-groups'
import { toast } from '@/lib/toast'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const H = 3_600_000
const NOW = Date.now()
const src = (name: string, over: Partial<SourceInfo> = {}): SourceInfo => ({
  name,
  kind: 'docker',
  containers: [],
  group: null,
  group_kind: null,
  lines: 1000,
  last_ts: NOW,
  display_name: null,
  hidden: false,
  paused: false,
  ...over,
})
const apps = { group: 'legivent-os-local-apps', group_kind: 'compose' } as const
const sources = [
  src('legivent-api', apps),
  src('order-worker', { ...apps, last_ts: NOW - 10 * 60_000 }),
  src('redis', { group: 'Standalone', group_kind: 'standalone' }),
  src('traefik', { kind: 'vector', group: 'Ingest', group_kind: 'ingest' }),
]
const health: Health = {
  ok: true,
  version: '0.1.0',
  started: 0,
  docker: { state: 'connected', containers: 2 },
  store: 'sqlite',
  retention_ms: 24 * H,
  disk_bytes: 0,
  stored_lines: 3000,
  oldest: NOW - 23 * H,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const settings: SettingsResponse = {
  general: {
    instance_name: 'quiet',
    stream_direction: 'bottom',
    timezone: 'local',
    public_url: null,
    timestamps: 'millis',
    max_line_bytes: 65536,
    keep_non_json: true,
    check_updates: false,
    search_include_muted: null,
  },
  storage: {
    retention_ms: 24 * H,
    retention_origin: 'default',
    max_disk: 5e9,
    max_disk_origin: 'default',
    flag_retention_ms: 24 * H,
    flag_max_disk: 5e9,
    at_cap: 'drop_oldest_hour',
  },
  grouping: { mode: 'auto', label: 'quiet.group', origin: 'default', locked: false },
  flow_ids: { order: ['request_id', 'job_id', 'trace_id', 'correlation_id'], match_by: 'value' },
  sources: {},
}
const bucket = (start: number, count: number, error = 0): Bucket => ({
  start,
  count,
  debug: 0,
  info: count - error,
  warn: 0,
  error,
})
// order-worker: 10% errors; the others 0.4%.
const stats = (name: string): StreamStats => ({
  total: 1000,
  levels: {
    debug: 0,
    info: name === 'order-worker' ? 900 : 996,
    warn: 0,
    error: name === 'order-worker' ? 100 : 4,
    none: 0,
  },
  histogram: Array.from({ length: 60 }, (_, i) => bucket(NOW - (60 - i) * 60_000, 5)),
  since: NOW - 24 * H,
  until: NOW,
  hist_since: NOW - H,
  hist_width: 60_000,
})
const fields = (name: string): SourceFields => ({
  sampled: 1000,
  json: 1000,
  fields: [
    { key: 'request_id', kind: 'str', coverage: 1, sample: 'req_8f2a8c' },
    { key: 'status', kind: 'num', coverage: 0.98, sample: '201' },
  ],
  ids:
    name === 'traefik'
      ? []
      : [
          { key: name === 'order-worker' ? 'job_id' : 'request_id', coverage: 1, shown: 1 },
          { key: 'job_id', coverage: name === 'order-worker' ? 1 : 0.03, shown: 0 },
        ],
  malformed_total: 6,
  malformed: [
    { id: 41, ts: NOW - 60_000, reason: 'not JSON', raw: 'Error: paystack transfer timed out after 2000ms' },
    { id: 42, ts: NOW - 120_000, reason: 'truncated', raw: '{"level":30,"msg":"provider payload"' },
  ],
})
const activity: SourceActivity = { source: 'legivent-api', rejections: [], rejected_15m: 3, paused_dropped: 0 }
let calls: { url: string; method: string; body: unknown }[] = []
const ingestTokens = [
  {
    id: 7,
    name: 'legivent-api otlp',
    preview: 'qi_••••77e0',
    source: 'legivent-api',
    created: NOW - 86_400_000,
    last_used: NOW - 1000,
    revoked: null,
  },
  { id: 8, name: 'shared', preview: 'qi_••••1a2b', source: null, created: NOW, last_used: null, revoked: null },
]

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (method !== 'GET') calls.push({ url, method, body })
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      const u = new URL(url, 'http://x')
      if (url.startsWith('/api/health')) return json(health)
      if (url === '/api/sources') return json({ sources })
      if (url === '/api/settings') return json(settings)
      if (url.startsWith('/api/stream/stats')) return json(stats(u.searchParams.get('source') ?? ''))
      if (url.includes('/fields')) return json(fields(decodeURIComponent(u.pathname.split('/')[3])))
      if (url.endsWith('/activity')) return json(activity)
      if (url.startsWith('/api/search')) {
        const n = Number(u.searchParams.get('buckets') ?? 0)
        const since = Number(u.searchParams.get('since'))
        const until = Number(u.searchParams.get('until'))
        return json({
          lines: [],
          next_cursor: null,
          total: 1000,
          bytes: 0,
          histogram: Array.from({ length: n }, (_, i) => bucket(since + (i * (until - since)) / n, 10, i % 7 ? 0 : 1)),
          searched: 1000,
          took_ms: 1,
          since,
          until,
        })
      }
      if (url.startsWith('/api/settings/sources/')) return json(body)
      if (url === '/api/storage/purge') return json({ lines: 1000, source: body.source })
      if (url === '/api/ingest-tokens') return json({ tokens: ingestTokens })
      if (url.startsWith('/api/ingest-tokens/') && url.endsWith('/restore'))
        return json({ ...ingestTokens[0], revoked: null })
      if (url === '/api/sources/legivent-api/remove')
        return json({
          lines: 1000,
          revoked: body.revoke_tokens ? [{ ...ingestTokens[0], revoked: NOW }] : [],
          previous: DEFAULT_SOURCE_SETTINGS,
        })
      return json({ error: 'nope' }, 404)
    }),
  )
})
afterEach(() => {
  localStorage.clear()
  resetCollapsedGroups()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderAt(path: string) {
  const client = makeQueryClient()
  seedAuth(client)
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }), client)
  render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return router
}

describe('sources list (06.1)', () => {
  it('groups by stack and shows a sparkline, the flow id and the error share per source', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    const table = await screen.findByRole('table', {}, { timeout: 5000 })
    const apps = within(table).getByRole('button', { name: 'legivent-os-local-apps · 1/2 sending · 2 shown' })
    expect(apps).toHaveAttribute('aria-expanded', 'true')
    expect(within(table).getByRole('button', { name: 'Standalone · 1/1 sending · 1 shown' })).toBeInTheDocument()
    expect(within(table).getByRole('button', { name: 'Ingest · 1/1 sending · 1 shown' })).toBeInTheDocument()
    // Projects first, then Standalone, then Ingest.
    const headers = within(table)
      .getAllByRole('button', { expanded: true })
      .map((b) => b.textContent)
    expect(headers.map((h) => h?.split(/compose|docker|push/)[0])).toEqual([
      'legivent-os-local-apps',
      'Standalone',
      'Ingest',
    ])
    await waitFor(() => expect(within(table).getAllByTestId('sparkline')).toHaveLength(4))
    expect(within(table).getAllByText('request_id').length).toBeGreaterThan(0)
    expect(within(table).getByText('job_id')).toBeInTheDocument()
    expect(within(table).getByText('none found')).toBeInTheDocument()
    expect(within(table).getByText('10%')).toBeInTheDocument()

    // Collapse the project: its rows hide, the choice is kept in localStorage.
    await user.click(apps)
    expect(apps).toHaveAttribute('aria-expanded', 'false')
    expect(within(table).getByText('legivent-api')).not.toBeVisible()
    expect(JSON.parse(localStorage.getItem('quiet.source-groups.collapsed') ?? '[]')).toEqual([
      'compose:legivent-os-local-apps',
    ])
    await user.click(apps)
    expect(within(table).getByText('legivent-api')).toBeVisible()

    // Group kind filter: Standalone only, then Compose / Stack only.
    await user.click(screen.getByRole('tab', { name: 'Standalone' }))
    expect(within(table).queryByText('legivent-api')).not.toBeInTheDocument()
    expect(within(table).getByText('redis')).toBeInTheDocument()
    expect(within(table).queryByText('traefik')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Compose / Stack' }))
    expect(within(table).getByText('legivent-api')).toBeInTheDocument()
    expect(within(table).queryByText('redis')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'All' }))

    // Erroring tab: only order-worker.
    await user.click(await screen.findByRole('tab', { name: 'Erroring 1' }))
    expect(within(table).queryByText('legivent-api')).not.toBeInTheDocument()
    expect(within(table).getByText('order-worker')).toBeInTheDocument()
  })

  it('the sidebar nests sources under collapsible group headers', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    const group = await screen.findByRole('region', { name: 'legivent-os-local-apps' }, { timeout: 5000 })
    expect(within(group).getByRole('link', { name: /legivent-api/ })).toBeInTheDocument()
    expect(within(group).getByRole('link', { name: /order-worker/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Ingest' })).toHaveTextContent('traefik')
    await user.click(within(group).getByRole('button', { expanded: true }))
    expect(within(group).queryByRole('link', { name: /legivent-api/ })).not.toBeInTheDocument()
    // Collapse all from the SOURCES heading, then expand all again.
    await user.click(screen.getAllByRole('button', { name: 'Collapse all groups' })[0])
    expect(screen.getByRole('region', { name: 'Ingest' })).not.toHaveTextContent('traefik')
    await user.click(screen.getAllByRole('button', { name: 'Expand all groups' })[0])
    expect(screen.getByRole('region', { name: 'Ingest' })).toHaveTextContent('traefik')
  })

  it('a collapsed group header shows member dots; group actions search the group and ignore it', async () => {
    const user = userEvent.setup()
    const router = renderAt('/sources')
    const table = await screen.findByRole('table', {}, { timeout: 5000 })
    const apps = within(table).getByRole('button', { name: /^legivent-os-local-apps ·/ })
    await user.click(apps)
    expect(within(apps).getAllByTestId('group-dots')).toHaveLength(1)
    expect(within(table).getByText('compose')).toBeInTheDocument()
    expect(within(table).getByText('push')).toBeInTheDocument()

    await user.click(within(table).getByRole('button', { name: 'legivent-os-local-apps actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Ignore all 2 sources' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Ignore 2 sources' }))
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/settings/sources/'))).toHaveLength(2))
    expect(calls.find((c) => c.url === '/api/settings/sources/order-worker')?.body).toMatchObject({
      paused: true,
      hidden: true,
    })

    await user.click(within(table).getByRole('button', { name: 'Search legivent-os-local-apps · 24h' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'))
    expect(router.state.location.search).toMatchObject({ source: 'legivent-api,order-worker', range: '24h' })
  })

  it('?group= shows one group with a note and Show all', async () => {
    const user = userEvent.setup()
    renderAt('/sources?group=compose%3Alegivent-os-local-apps')
    const table = await screen.findByRole('table', {}, { timeout: 5000 })
    expect(within(table).getByText('legivent-api')).toBeInTheDocument()
    expect(within(table).queryByText('redis')).not.toBeInTheDocument()
    expect(screen.getByText(/2 of 4 sources · hiding/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Show all/ }))
    expect(await within(table).findByText('redis')).toBeInTheDocument()
  })
})

describe('stream source picker (03.8)', () => {
  it('lists sources by group, folds with the arrow keys and streams one source on enter', async () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen = null
        onmessage = null
        onclose = null
        close() {}
      },
    )
    const user = userEvent.setup()
    const router = renderAt('/?source=legivent-api')
    await user.click(await screen.findByRole('button', { name: 'Pick a source' }, { timeout: 5000 }))
    const list = await screen.findByRole('listbox', { name: 'Sources' })
    expect(within(list).getByRole('button', { name: /^legivent-os-local-apps ·/ })).toBeInTheDocument()
    expect(within(list).getByRole('option', { name: /legivent-api/ })).toHaveAttribute('aria-selected', 'true')
    const filter = screen.getByRole('textbox', { name: 'Filter sources' })
    await user.type(filter, 'order')
    expect(within(list).queryByRole('option', { name: /redis/ })).not.toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ source: 'order-worker' }))
  })
})

describe('source detail (06.2 / 06.4 / 06.5)', () => {
  it('shows the window histogram, fields detected and flow id coverage', async () => {
    renderAt('/sources/legivent-api')
    expect(await screen.findByText('Fields detected', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByTestId('day-bar')).toHaveLength(96))
    expect(await screen.findByText(/^2 fields · from the last/)).toBeInTheDocument()
    expect(screen.getByText('req_8f2a8c')).toBeInTheDocument()
    expect(screen.getByText('Flow id detected')).toBeInTheDocument()
    expect(screen.getByText('on 100% of lines')).toBeInTheDocument()
    expect(screen.getByText('0.4% errors · 0% warn')).toBeInTheDocument()
  })

  it('remove needs the name typed, then removes the source and revokes its token in one step; Undo restores (06.4)', async () => {
    const success = vi.spyOn(toast, 'success')
    const user = userEvent.setup()
    const router = renderAt('/sources/legivent-api')
    await user.click(await screen.findByRole('button', { name: /Remove$/ }, { timeout: 5000 }))
    const dialog = await screen.findByRole('dialog')
    const go = within(dialog).getByRole('button', { name: /Remove source/ })
    expect(go).toBeDisabled()
    // Only the token bound to this source is offered (on by default), not the any-source one.
    const sw = await within(dialog).findByRole('switch', { name: 'Also revoke its token' })
    expect(sw).toBeChecked()
    expect(dialog).toHaveTextContent('qi_••••77e0')
    expect(dialog).not.toHaveTextContent('qi_••••1a2b')
    await user.type(within(dialog).getByRole('textbox', { name: 'Confirm remove' }), 'legivent-api')
    await user.click(go)
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/sources/legivent-api/remove',
        method: 'POST',
        body: { confirm: 'legivent-api', revoke_tokens: true },
      }),
    )
    expect(calls.some((c) => c.url === '/api/storage/purge')).toBe(false)
    await waitFor(() => expect(router.state.location.pathname).toBe('/sources'))
    const removed = success.mock.calls.find((c) => c[0] === 'Removed legivent-api')?.[1]
    expect(removed?.description).toBe('1.0k stored lines deleted · token qi_••••77e0 revoked; new lines are dropped.')

    // Undo: the token is restored and the settings put back.
    removed?.button?.onClick()
    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ url: '/api/ingest-tokens/7/restore', method: 'POST' })),
    )
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: '/api/settings/sources/legivent-api',
          method: 'PUT',
          body: expect.objectContaining({ paused: false, hidden: false }),
        }),
      ),
    )
  })

  it('turning the switch off keeps the token', async () => {
    const user = userEvent.setup()
    renderAt('/sources/legivent-api')
    await user.click(await screen.findByRole('button', { name: /Remove$/ }, { timeout: 5000 }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('switch', { name: 'Also revoke its token' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Confirm remove' }), 'legivent-api')
    await user.click(within(dialog).getByRole('button', { name: /Remove source/ }))
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: '/api/sources/legivent-api/remove',
          body: { confirm: 'legivent-api', revoke_tokens: false },
        }),
      ),
    )
  })

  it('the rejected tab shows the stats and the newest malformed lines; the malformed tab lists them', async () => {
    const user = userEvent.setup()
    renderAt('/sources/legivent-api?tab=rejected')
    expect(await screen.findByText('Rejected 15 min', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(await screen.findByText('Error: paystack transfer timed out after 2000ms')).toBeInTheDocument()
    expect(screen.getByText('not JSON')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /View all 6/ }))
    expect(await screen.findByRole('tab', { name: 'Malformed 6', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /paystack transfer/ })).toHaveAttribute('href', '/line/41')
  })
})

describe('⌘K with groups (03.9)', () => {
  it('shows sources under their group and a Groups section that opens Sources filtered', async () => {
    const user = userEvent.setup()
    const router = renderAt('/sources')
    await screen.findByRole('table', {}, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: /Jump to/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('combobox'), 'worker')
    expect(await within(dialog).findByText('Groups')).toBeInTheDocument()
    await user.click(within(dialog).getByText('show on Sources'))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ group: 'compose:legivent-os-local-apps' }))
  })
})
