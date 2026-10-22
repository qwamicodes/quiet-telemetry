import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bucket, Health, SettingsResponse, SourceActivity, SourceFields, SourceInfo, StreamStats } from '@/gen'
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
  lines: 1000,
  last_ts: NOW,
  display_name: null,
  hidden: false,
  paused: false,
  ...over,
})
const sources = [src('legivent-api'), src('order-worker'), src('traefik', { kind: 'vector' })]
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
      return json({ error: 'nope' }, 404)
    }),
  )
})
afterEach(() => {
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
  it('groups by host and shows a sparkline, the flow id and the error share per source', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    const table = await screen.findByRole('table', {}, { timeout: 5000 })
    expect(within(table).getByText('this host')).toBeInTheDocument()
    expect(within(table).getByText('2 sources · docker.sock')).toBeInTheDocument()
    expect(within(table).getByText('HTTP ingest')).toBeInTheDocument()
    await waitFor(() => expect(within(table).getAllByTestId('sparkline')).toHaveLength(3))
    expect(within(table).getByText('request_id')).toBeInTheDocument()
    expect(within(table).getByText('job_id')).toBeInTheDocument()
    expect(within(table).getByText('none found')).toBeInTheDocument()
    expect(within(table).getByText('10%')).toBeInTheDocument()
    expect(within(table).getAllByText('0.4%')).toHaveLength(2)

    // Erroring tab: only order-worker.
    await user.click(await screen.findByRole('tab', { name: 'Erroring 1' }))
    expect(within(table).queryByText('legivent-api')).not.toBeInTheDocument()
    expect(within(table).getByText('order-worker')).toBeInTheDocument()
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

  it('remove needs the name typed, then pauses, hides and purges the source', async () => {
    const user = userEvent.setup()
    const router = renderAt('/sources/legivent-api')
    await user.click(await screen.findByRole('button', { name: /Remove$/ }, { timeout: 5000 }))
    const dialog = await screen.findByRole('dialog')
    const go = within(dialog).getByRole('button', { name: /Remove source/ })
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox', { name: 'Confirm remove' }), 'legivent-api')
    await user.click(go)
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/storage/purge',
        method: 'POST',
        body: { source: 'legivent-api', confirm: 'legivent-api' },
      }),
    )
    const saved = calls.find((c) => c.url === '/api/settings/sources/legivent-api')
    expect(saved?.body).toMatchObject({ paused: true, hidden: true })
    await waitFor(() => expect(router.state.location.pathname).toBe('/sources'))
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
