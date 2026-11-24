import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  About,
  Destination,
  Health,
  HistoryStatus,
  LogLine,
  MuteRule,
  MuteStats,
  SettingsResponse,
  SourceActivity,
  SourceInfo,
  SourceSettings,
  StorageReport,
  SystemStatus,
  User,
  VerifyResult,
} from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { member, owner, seedAuth } from '@/test/auth'

const H = 3_600_000
const NOW = Date.now()

const source = (name: string, over: Partial<SourceInfo> = {}): SourceInfo => ({
  name,
  kind: 'docker',
  containers: [],
  group: null,
  group_kind: null,
  lines: 10,
  last_ts: NOW,
  display_name: null,
  hidden: false,
  paused: false,
  ...over,
})

const health: Health = {
  ok: true,
  version: '0.1.0',
  started: 0,
  docker: { state: 'connected', containers: 3, endpoint: '/var/run/docker.sock', engine: null },
  store: 'sqlite',
  retention_ms: 24 * H,
  disk_bytes: 0,
  stored_lines: 0,
  oldest: null,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}

let sources: SourceInfo[]
let settings: SettingsResponse
let storage: StorageReport
let system: SystemStatus
let activity: SourceActivity
// biome-ignore lint/suspicious/noExplicitAny: a test double for the request bodies
let calls: { url: string; method: string; body: any }[]
let muteStats: MuteStats

const blankSource = (): SourceSettings => ({
  display_name: null,
  hidden: false,
  paused: false,
  retention_ms: null,
  id_keys: null,
  default_level: null,
  mask_fields: [],
  unmasked: [],
  redact_fields: [],
  redact_pii: [],
  muted: [],
  search_include_muted: null,
  muted_global_off: [],
})

const rule = (over: Partial<MuteRule>): MuteRule => ({
  id: 'mr_1',
  scope: 'source',
  enabled: true,
  shape: 'route',
  field: 'path',
  value: '/api/v1/health',
  method: null,
  created_by: 'Kwaame',
  created_at: NOW - 2 * H,
  origin: 'hover',
  ...over,
})

const dest = (over: Partial<Destination>): Destination => ({
  id: 1,
  name: 'garage-local',
  kind: 'garage',
  endpoint: 'http://garage:3900',
  region: 'garage',
  bucket: 'quiet-history',
  prefix: 'quiet/',
  path_style: true,
  access_key_preview: 'GK12••••3456',
  active: true,
  state: 'ok',
  verified_at: NOW - 60_000,
  last_verify: null,
  hours: 300,
  lines: 1_000_000,
  bytes_stored: 23_800_000_000,
  first: NOW - 13 * 24 * H,
  last: NOW - 2 * H,
  last_upload: NOW - 4_000,
  error: null,
  next_retry: null,
  created_at: 0,
  capacity_bytes: 100_000_000_000,
  capacity_source: 'policy',
  at_capacity: false,
  removing: false,
  cleanup_error: null,
  cleanup_retry_at: null,
  cleanup_blocked_hours: 0,
  ...over,
})

let history: HistoryStatus
let testResult: VerifyResult
const freshHistory = () => {
  history = {
    enabled: true,
    enabled_at: 0,
    instance_id: 'abc',
    active: 1,
    destinations: [
      dest({}),
      dest({
        id: 2,
        name: 'production-r2',
        kind: 'r2',
        endpoint: 'https://acc.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'quiet-production',
        active: false,
        hours: 0,
        bytes_stored: 0,
        first: null,
        last: null,
        last_upload: null,
        verified_at: NOW - 120_000,
        last_verify: { ok: true, cleanup: true, steps: [], at: NOW - 120_000 },
      }),
    ],
    gaps: [],
    gap_hours: 0,
    waiting_hours: 0,
    policy: {
      retention_days: 30,
      at_capacity: 'evict',
      size_limit_bytes: 100_000_000_000,
      saved_by: 'kwaame',
      saved_at: NOW - 3_600_000,
    },
    retained_from: NOW - 13 * 24 * H,
    expired_hours: 0,
    expired_bytes: 0,
    backfill_hours: 0,
    jobs: [],
  }
  testResult = {
    ok: false,
    cleanup: false,
    at: NOW,
    steps: [
      { step: 'list', ok: true, skipped: false },
      { step: 'write', ok: false, skipped: false, error: 'AccessDenied · Access Denied' },
      { step: 'read', ok: false, skipped: true, error: 'write failed' },
      { step: 'delete', ok: false, skipped: true, error: 'no test object created' },
    ],
  }
}

function fresh() {
  sources = [source('legivent-api'), source('traefik', { kind: 'vector' }), source('noisy', { hidden: true })]
  settings = {
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
    muted_search: { include: false, origin: 'default', flag: false },
    grouping: { mode: 'auto', label: 'quiet.group', origin: 'default', locked: false },
    flow_ids: { order: ['request_id', 'job_id', 'trace_id', 'correlation_id'], match_by: 'value' },
    sources: {},
    muted_global: [],
  }
  const hour = Math.floor(NOW / H) * H
  storage = {
    settings: settings.storage,
    store: 'sqlite',
    path: '/var/lib/quiet/quiet.db',
    used: 1.9e9,
    ratio: 0.38,
    lines: 4_380_000,
    oldest: NOW - 23 * H,
    fs_free: 41.2e9,
    hours: [0, 1, 2].map((i) => ({ start: hour - i * H, lines: 1000, bytes: 80e6 })).reverse(),
    sources: [
      { source: 'traefik', lines: 2_310_000, bytes: 1e9, disk: 0.71e9, share: 0.37 },
      { source: 'legivent-api', lines: 1_210_000, bytes: 0.9e9, disk: 0.62e9, share: 0.33 },
    ],
    bytes_per_hour: 80e6,
    steady_bytes: 1.92e9,
    cap_in_ms: null,
    now: NOW,
  }
  system = {
    ok: true,
    issues: [],
    docker: { state: 'connected', containers: 3, endpoint: '/var/run/docker.sock', engine: null },
    disk: {
      state: 'ok',
      used: 1.9e9,
      cap: 5e9,
      ratio: 0.38,
      fs_free: null,
      fs_total: null,
      fs_low: false,
      window_ms: 24 * H,
      reaches_ms: 23 * H,
      capped_lines: 0,
      capped_at: null,
    },
    ingest: { rejected_15m: 0, rejected_24h: 0, recent: [], paused: [] },
    store: { kind: 'sqlite', write_errors: 0, last_error: null, last_error_at: null, disk_full: false },
    now: NOW,
  }
  activity = { source: 'legivent-api', rejections: [], rejected_15m: 0, paused_dropped: 0, dropped: [], dropped_24h: 0 }
  calls = []
  muteStats = { since: NOW - 24 * H, until: NOW, sources: {}, rules: {} }
}

const line = (id: number): LogLine => ({
  id,
  ts: NOW - 1000 * (10 - id),
  received: NOW,
  source: 'legivent-api',
  level: 'warn',
  display_id: null,
  ids: [],
  msg: `line ${id}`,
  raw: `line ${id}`,
})

let backlog: LogLine[] = []

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.all.push(this)
    queueMicrotask(() => {
      this.onopen?.()
      this.onmessage?.({
        data: JSON.stringify({ type: 'backlog', lines: backlog.length ? backlog : [line(1), line(2), line(3)] }),
      })
    })
  }
  close() {}
}

beforeEach(() => {
  fresh()
  freshHistory()
  backlog = []
  FakeSocket.all = []
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (method !== 'GET') calls.push({ url, method, body })
      if (url.startsWith('/api/health')) return json(health)
      if (url === '/api/sources') return json({ sources })
      if (url.endsWith('/activity')) return json(activity)
      if (url === '/api/settings') return json(settings)
      if (url === '/api/storage') return json(storage)
      if (url === '/api/system') return json(system)
      if (url === '/api/settings/general') {
        settings.general = body
        return json(body)
      }
      if (url === '/api/settings/storage') {
        settings.storage = { ...settings.storage, retention_ms: body.retention_ms ?? settings.storage.retention_ms }
        return json(settings.storage)
      }
      if (url.startsWith('/api/settings/sources/')) {
        const name = decodeURIComponent(url.split('/').pop() ?? '')
        settings.sources[name] = body
        return json(body)
      }
      if (url.startsWith('/api/id-coverage')) {
        const keys = (new URL(url, 'http://x').searchParams.get('keys') ?? '').split(',')
        const known: Record<string, { coverage: number; sources: string[] }> = {
          request_id: { coverage: 0.61, sources: ['legivent-api', 'traefik'] },
          job_id: { coverage: 0.22, sources: ['order-worker'] },
          trace_id: { coverage: 0.09, sources: ['payments-svc', 'traefik'] },
          correlation_id: { coverage: 0.001, sources: ['cron-runner'] },
          'x-request-id': { coverage: 0.3, sources: ['traefik'] },
        }
        return json({
          sampled: 2000,
          keys: keys.map((key) => ({ key, ...(known[key] ?? { coverage: 0, sources: [] }) })),
        })
      }
      if (url === '/api/mute/stats') return json(muteStats)
      if (url === '/api/mute/preview')
        return json(
          (body.rules as unknown[]).map(() => ({
            total: 312,
            per_source: { 'legivent-api': 312 },
            lines: 1000,
            by_method: [{ method: 'GET', count: 309 }],
            query_ignored: 4,
            already_hidden: 0,
            samples: [],
            estimated: false,
          })),
        )
      if (url === '/api/mute/rules' && method === 'POST') {
        const rule = {
          ...body.rule,
          id: body.rule.id || `mr_new${calls.length}`,
          created_by: 'Kwaame',
          created_at: NOW,
        }
        if (rule.scope === 'global') settings.muted_global.push(rule)
        else {
          const name = body.source as string
          settings.sources[name] = {
            ...(settings.sources[name] ?? blankSource()),
            muted: [...(settings.sources[name]?.muted ?? []), rule],
          }
        }
        return json({ rule, removed: [] }, 201)
      }
      if (url.startsWith('/api/mute/rules/')) {
        const id = decodeURIComponent(url.split('/').pop() ?? '')
        const all = [...settings.muted_global, ...Object.values(settings.sources).flatMap((x) => x.muted)]
        const r = all.find((x) => x.id === id)
        if (!r) return json({ error: 'not found' }, 404)
        if (method === 'PATCH') {
          Object.assign(r, body)
          return json(r)
        }
        settings.muted_global = settings.muted_global.filter((x) => x.id !== id)
        let src: string | null = null
        for (const [k, v] of Object.entries(settings.sources))
          if (v.muted.some((x) => x.id === id)) {
            src = k
            v.muted = v.muted.filter((x) => x.id !== id)
          }
        return json({ rule: r, source: src, off_on: [] })
      }
      if (url.startsWith('/api/mute/sources/')) {
        const parts = url.split('/')
        const name = decodeURIComponent(parts[4])
        const id = decodeURIComponent(parts[6])
        const cur = settings.sources[name] ?? blankSource()
        const off = cur.muted_global_off.filter((o) => o.id !== id)
        if (!body.apply) off.push({ id, by: 'Kwaame', at: NOW })
        settings.sources[name] = { ...cur, muted_global_off: off }
        return json(settings.sources[name])
      }
      if (url === '/api/mute/search') {
        settings.muted_search = {
          include: body.include ?? false,
          origin: body.include == null ? 'default' : 'setting',
          flag: false,
        }
        settings.general.search_include_muted = body.include
        return json(settings.muted_search)
      }
      if (url === '/api/settings/flow-ids') {
        settings.flow_ids = body
        return json(body)
      }
      if (url === '/api/storage/history') return json(history)
      if (url.startsWith('/api/storage/destinations/test')) return json(testResult)
      if (url === '/api/storage/destinations' && method === 'POST') {
        const d = dest({ ...body, id: 3, active: false, hours: 0, bytes_stored: 0, first: null, last: null })
        history.destinations.push(d)
        return json({ destination: d, verify: { ...testResult, ok: true, cleanup: true } }, 201)
      }
      if (url.endsWith('/activate')) {
        const id = Number(url.split('/')[4])
        for (const d of history.destinations) d.active = d.id === id
        return json(history.destinations.find((d) => d.id === id))
      }
      if (url.endsWith('/verify')) return json({ ...testResult, ok: true, cleanup: true })
      if (url.startsWith('/api/storage/destinations/') && method === 'DELETE') {
        const id = Number(url.split('/')[4])
        history.destinations = history.destinations.filter((d) => d.id !== id)
        return new Response(null, { status: 204 })
      }
      if (url === '/api/settings/history' && method === 'PUT') {
        if ((body.retention_days ?? 1e9) < (history.policy.retention_days ?? 1e9) && !body.confirm)
          return json(
            {
              error: 'confirm',
              code: 'confirm_required',
              preview: {
                retention_days: body.retention_days,
                before: NOW - 7 * 24 * H,
                hours: 144,
                lines: 9,
                bytes: 10_900_000_000,
                destinations: [{ id: 1, name: 'garage-local', hours: 144, bytes: 10_900_000_000 }],
              },
            },
            409,
          )
        history.policy = { ...history.policy, ...body, saved_by: 'kwaame', saved_at: NOW }
        return json(history.policy)
      }
      if (url === '/api/storage/purge') return json({ lines: 42, source: body.source ?? null })
      if (url === '/api/about') return json(aboutInfo)
      if (url.startsWith('/api/sources/grouping-preview')) {
        const label = new URL(url, 'http://x').searchParams.get('label')
        return json({
          groups: [
            { name: label === 'team' ? 'growth' : 'apps', kind: 'custom', sources: ['api', 'web'] },
            { name: 'Standalone', kind: 'standalone', sources: ['redis'] },
          ],
          found: 2,
          docker: 3,
          total: 3,
        })
      }
      if (url === '/api/settings/grouping') {
        settings.grouping = { ...body, origin: 'setting', locked: false }
        return json(settings.grouping)
      }
      if (url.startsWith('https://api.github.com/')) {
        githubCalls += 1
        return json({
          tag_name: 'v0.1.1',
          name: 'v0.1.1',
          html_url: 'https://github.com/qwamicodes/quiet-telemetry/releases/tag/v0.1.1',
          published_at: '2026-10-22T10:00:00Z',
          body: '## Fixes\n- Parser tolerates duplicate keys\n- Fixes reconnect loop after laptop sleep\n',
        })
      }
      return json({ error: 'nope' }, 404)
    }),
  )
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let githubCalls = 0
const aboutInfo: About = {
  version: '0.1.0',
  commit: 'a1c9e04',
  built: '2026-10-21',
  started: NOW - 27 * H,
  now: NOW,
  store: 'sqlite',
  sqlite_version: '3.46.0',
  db_bytes: 1.9e9,
  data_dir: '/var/lib/quiet',
  live_clients: 3,
  members: 2,
  docker: { state: 'connected', containers: 6, endpoint: '/var/run/docker.sock', engine: '27.3.1' },
}

function renderAt(path: string, user: User = owner) {
  const client = makeQueryClient()
  seedAuth(client, user)
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }), client)
  render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return { router, client }
}

describe('Settings → Storage tabs (v1.1-01…29)', () => {
  it('Overview: stored history in the active connector, its policy, Garage on this host and the local window', async () => {
    renderAt('/settings/storage')
    const stored = await screen.findByRole('region', { name: 'Stored history' })
    expect(within(stored).getByText('23.8 GB')).toBeInTheDocument()
    expect(within(stored).getByText('of 100 GB history limit')).toBeInTheDocument()
    expect(within(stored).getByText('Garage · local')).toBeInTheDocument()
    expect(within(stored).getByText('Up to date')).toBeInTheDocument()
    expect(within(stored).getByText('30 days · remove oldest history')).toBeInTheDocument()
    expect(screen.getByText('Local history')).toBeInTheDocument()
    expect(screen.getByText('Recent local data')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  })

  it('Overview: an unreachable destination says uploads are delayed and retries on demand', async () => {
    history.destinations[0] = dest({ state: 'unavailable', error: 'connection refused', next_retry: NOW + 28_000 })
    history.waiting_hours = 3
    const user = userEvent.setup()
    renderAt('/settings/storage')
    expect(await screen.findByText('History uploads are delayed')).toBeInTheDocument()
    expect(screen.getByText('Waiting to upload')).toBeInTheDocument()
    expect(screen.getByText('3 hours')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/storage/destinations/1/verify')).toBe(true))
  })

  it('Overview: at the size limit with stop adding, new history is not being stored', async () => {
    history.destinations[0] = dest({ at_capacity: true, bytes_stored: 100_000_000_000 })
    history.policy.at_capacity = 'stop'
    renderAt('/settings/storage')
    expect(await screen.findByText('New history is not being stored')).toBeInTheDocument()
    expect(screen.getByText('History writes stopped')).toBeInTheDocument()
    expect(screen.getByText('History gap')).toBeInTheDocument()
  })

  it('Connectors: the shared policy, each connector, and activating one copies the local window', async () => {
    const user = userEvent.setup()
    renderAt('/settings/storage?tab=connectors')
    expect(await screen.findByText('30 days · 100 GB per connector · remove oldest')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Connectors' })
    expect(within(list).getByText('Garage')).toBeInTheDocument()
    expect(within(list).getByText('production-r2')).toBeInTheDocument()
    expect(within(list).getByText('Ready')).toBeInTheDocument()
    await user.click(within(list).getByRole('button', { name: 'Activate' }))
    expect(await screen.findByText('Activate production-r2?')).toBeInTheDocument()
    expect(screen.getByText(/Quiet will copy the 24 hours still available locally/)).toBeInTheDocument()
    expect(screen.getByText(/stays searchable while connected. It is not migrated/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Activate R2' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/storage/destinations/2/activate')).toBe(true))
  })

  it('Connect R2: test first, a failed write leaves read and delete not run, then save once it passes', async () => {
    const user = userEvent.setup()
    renderAt('/settings/storage?tab=connectors&screen=connect&kind=r2')
    await user.type(await screen.findByRole('textbox', { name: 'Connection name' }), 'production-r2b')
    await user.type(screen.getByRole('textbox', { name: 'Bucket' }), 'quiet-production')
    await user.type(screen.getByRole('textbox', { name: 'S3 endpoint' }), 'https://acc.r2.cloudflarestorage.com')
    await user.type(screen.getByRole('textbox', { name: 'Access Key ID' }), 'AKIA1')
    await user.type(screen.getByLabelText('Secret Access Key'), 's3cr3t')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Write permission is missing')).toBeInTheDocument()
    expect(screen.getByText('1 passed · 1 failed · 2 not run')).toBeInTheDocument()
    expect(screen.getByText('Not run · write failed')).toBeInTheDocument()
    expect(screen.getByText('Provider response · AccessDenied')).toBeInTheDocument()
    // Nothing is saved by a test.
    expect(calls.some((c) => c.url === '/api/storage/destinations' && c.method === 'POST')).toBe(false)
    testResult = {
      ok: true,
      cleanup: true,
      at: NOW,
      steps: (['list', 'write', 'read', 'delete'] as const).map((step) => ({ step, ok: true, skipped: false })),
    }
    await user.click(screen.getByRole('button', { name: 'Retry test' }))
    expect(await screen.findByText('4 of 4 checks passed')).toBeInTheDocument()
    expect(screen.getByText('Ready to save')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save connector' }))
    await waitFor(() => {
      const saved = calls.find((c) => c.url === '/api/storage/destinations' && c.method === 'POST')
      expect(saved?.body).toMatchObject({ name: 'production-r2b', kind: 'r2', activate: false, access_key_id: 'AKIA1' })
    })
  })

  it('Remove: objects are left untouched in the bucket', async () => {
    history.destinations[0] = dest({ active: false, hours: 300 })
    history.destinations[1].active = true
    const user = userEvent.setup()
    renderAt('/settings/storage?tab=connectors')
    const list = await screen.findByRole('list', { name: 'Connectors' })
    await user.click(within(list).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Remove Garage from Quiet?')).toBeInTheDocument()
    expect(screen.getByText(/Objects in Garage will be left untouched/)).toBeInTheDocument()
    expect(screen.getByText('production-r2 will remain the active destination.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove connector' }))
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE')
      expect(del?.url).toBe('/api/storage/destinations/1')
      expect(del?.body).toEqual({ delete_history: false })
    })
  })

  it('Policy: one policy for every connector; shortening it asks first', async () => {
    const user = userEvent.setup()
    renderAt('/settings/storage?tab=policy')
    expect(await screen.findByText('Applies to every connector')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Size limit per connector' })).toHaveValue('100'))
    expect(screen.getByText(/Last saved · kwaame/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(screen.getByRole('textbox', { name: 'Custom duration' })).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: '7 days' }))
    await user.click(screen.getByRole('button', { name: 'Save policy' }))
    expect(await screen.findByText('Shorten retention to 7 days?')).toBeInTheDocument()
    expect(screen.getByText(/about 10.9 GB across 1 connector/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply shorter retention' }))
    await waitFor(() => {
      const put = calls.filter((c) => c.url === '/api/settings/history').pop()
      expect(put?.body).toMatchObject({ retention_days: 7, size_limit_bytes: 100_000_000_000, confirm: true })
    })
  })
})

describe('Settings → Storage', () => {
  it('shows usage, partitions and volume; the window toggle saves', async () => {
    const user = userEvent.setup()
    renderAt('/settings/storage?screen=local')
    expect(await screen.findByText('1.90 GB')).toBeInTheDocument()
    expect(screen.getByText(/SQLite on this host · \/var\/lib\/quiet\/quiet\.db/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '3 hourly partitions stored' })).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getByText('traefik')).toBeInTheDocument()
    expect(within(table).getByText('37%')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '3d' }))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/settings/storage', method: 'PUT', body: { retention_ms: 72 * H } }),
    )
  })

  it('warns near the cap; purge needs the word typed', async () => {
    storage = { ...storage, used: 4.82e9, ratio: 0.964 }
    system = { ...system, disk: { ...system.disk, state: 'full', capped_at: NOW } }
    const user = userEvent.setup()
    renderAt('/settings/storage?screen=local')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Disk is at 96% of the 5 GB cap')
    expect(alert).toHaveTextContent('traefik is 37% of the volume')

    await user.click(screen.getByRole('button', { name: /Purge now/ }))
    const dialog = await screen.findByRole('dialog')
    const go = within(dialog).getByRole('button', { name: /Purge/ })
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox', { name: 'Confirm purge' }), 'purge')
    await user.click(go)
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/storage/purge', method: 'POST', body: { confirm: 'purge' } }),
    )
  })

  it('members read but cannot change or purge', async () => {
    renderAt('/settings/storage?screen=local', member)
    expect(await screen.findByText(/Only an owner can change/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Purge now/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '24h' })).toBeDisabled()
  })
})

describe('Settings → General', () => {
  it('saves instance name, timezone, timestamps and the include-muted default (07.10)', async () => {
    const user = userEvent.setup()
    renderAt('/settings')
    const name = await screen.findByLabelText('Instance name')
    await user.clear(name)
    await user.type(name, 'legivent')
    await user.click(screen.getByRole('combobox', { name: 'Timezone' }))
    await user.click(await screen.findByRole('option', { name: /^Africa\/Accra/ }))
    const url = screen.getByLabelText('Public URL')
    await user.type(url, 'quiet.legivent.com')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.clear(url)
    await user.type(url, 'https://quiet.legivent.com/')
    await user.click(screen.getByRole('button', { name: 'relative' }))
    await user.click(screen.getByLabelText('Keep non-JSON lines'))
    await user.click(screen.getByRole('switch', { name: 'Include muted lines in search' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/mute/search', method: 'PUT', body: { include: true } }),
    )
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/settings/general',
        method: 'PUT',
        // The mock keeps the PUT body as its state, so the later muted-search save shows through it.
        body: expect.objectContaining({
          instance_name: 'legivent',
          stream_direction: 'bottom',
          timezone: 'Africa/Accra',
          public_url: 'https://quiet.legivent.com/',
          timestamps: 'relative',
          max_line_bytes: 65536,
          keep_non_json: false,
          check_updates: false,
        }),
      }),
    )
  }, 15_000)

  it('source grouping: a compact select here, full options one click away (07.10 → 07.11)', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/settings')
    expect(await screen.findByRole('combobox', { name: 'Source grouping' })).toHaveTextContent('Auto')
    await user.click(screen.getByRole('link', { name: 'Source grouping' }))
    await waitFor(() => expect(router.state.location.hash).toBe('grouping'))
    expect(await screen.findByRole('region', { name: 'Source grouping' })).toBeInTheDocument()
    expect(screen.getByText(/· Source grouping$/)).toBeInTheDocument()
  })

  it('is read-only for members', async () => {
    renderAt('/settings', member)
    expect(await screen.findByLabelText('Instance name')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })
})

describe('source settings', () => {
  it('reorders ids, masks a field, ignores the source and saves from the header (v0.1.1-06.3)', async () => {
    const user = userEvent.setup()
    renderAt('/sources/legivent-api?tab=settings')
    const form = await screen.findByRole('form', { name: 'Settings for legivent-api' })
    await user.type(within(form).getByLabelText('Display name'), 'API')
    expect(within(form).getByLabelText('Matched by')).toHaveValue('container name = legivent-api')
    await user.click(within(form).getByRole('button', { name: 'Move job_id up' }))
    await user.type(within(form).getByRole('textbox', { name: 'Mask another field' }), 'customer.address')
    await user.click(within(form).getByRole('button', { name: 'Add' }))
    await user.click(within(form).getByRole('switch', { name: 'Mask user_agent' }))
    await user.click(within(form).getByRole('switch', { name: 'Ignore this source' }))
    // Discard / Save changes sit in the page header on this tab.
    await user.click(screen.getByRole('button', { name: /^Save changes/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      url: '/api/settings/sources/legivent-api',
      method: 'PUT',
      body: {
        display_name: 'API',
        hidden: true,
        paused: true,
        retention_ms: null,
        id_keys: ['job_id', 'request_id', 'trace_id', 'correlation_id'],
        default_level: null,
        mask_fields: ['customer.address'],
        unmasked: ['user_agent'],
        redact_fields: [],
        redact_pii: [],
        muted: [],
        search_include_muted: null,
        muted_global_off: [],
      },
    })
  })

  it('a source can include its muted lines in search, or inherit the instance choice (edit sheet)', async () => {
    settings.muted_search = { include: true, origin: 'setting', flag: false }
    const user = userEvent.setup()
    renderAt('/sources/legivent-api?edit=muted')
    const group = await screen.findByRole('radiogroup', { name: 'Include muted lines in search' })
    expect(await within(group).findByRole('radio', { name: 'Inherit (on)' })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(group).getByRole('radio', { name: 'Off' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/settings/sources/legivent-api',
      body: { search_include_muted: false },
    })
  })

  it('the Rejected tab lists refused requests for the source', async () => {
    activity = {
      ...activity,
      rejected_15m: 38,
      rejections: [
        {
          minute: NOW,
          endpoint: 'otlp-logs',
          status: 401,
          reason: 'ingest token revoked',
          source: 'legivent-api',
          token: 'qi_••••77e0',
          count: 38,
        },
      ],
    }
    renderAt('/sources/legivent-api?tab=rejected')
    expect(await screen.findByText('ingest token revoked')).toBeInTheDocument()
    expect(screen.getByText('qi_••••77e0')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Rejected 38/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('the sidebar hides hidden sources and shows display names', async () => {
    sources = [source('legivent-api', { display_name: 'API' }), source('noisy', { hidden: true })]
    renderAt('/sources')
    const sidebar = await screen.findByRole('complementary')
    expect(await within(sidebar).findByText('API')).toBeInTheDocument()
    expect(within(sidebar).queryByText('noisy')).not.toBeInTheDocument()
    // The Sources page still lists it, marked hidden.
    expect(await screen.findByRole('link', { name: /noisy\s*hidden/ })).toBeInTheDocument()
  })
})

describe('stream defaults from settings', () => {
  it('opens with the source default level; `all` clears it; direction flips per browser', async () => {
    settings.sources['legivent-api'] = {
      display_name: null,
      hidden: false,
      paused: false,
      retention_ms: null,
      id_keys: null,
      default_level: 'warn',
      mask_fields: [],
      unmasked: [],
      redact_fields: [],
      redact_pii: [],
      muted: [],
      search_include_muted: null,
      muted_global_off: [],
    }
    settings.general.stream_direction = 'top'
    const user = userEvent.setup()
    const { router } = renderAt('/?source=legivent-api')
    // A source default of warn turns on the warn and error chips.
    await waitFor(() => expect(FakeSocket.all.some((s) => s.url.includes('levels=warn%2Cerror'))).toBe(true))
    expect(screen.getByRole('button', { name: 'warn lines' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'info lines' })).toHaveAttribute('aria-pressed', 'false')
    // Rows newest first.
    const rows = await screen.findAllByText(/^line \d$/, {}, { timeout: 5000 })
    expect(rows.map((r) => r.textContent)).toEqual(['line 3', 'line 2', 'line 1'])

    // Turning both chips off shows every level, which overrides the default: level=all.
    await user.click(screen.getByRole('button', { name: 'warn lines' }))
    await user.click(screen.getByRole('button', { name: 'error lines' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ level: 'all' }))
    expect(await screen.findByText(/newest at top/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Newest at top' }))
    expect(await screen.findByText(/newest at bottom/)).toBeInTheDocument()
    expect(localStorage.getItem('quiet.stream-direction')).toBe('bottom')
  })
})

describe('system banners', () => {
  it('Docker down shows troubleshooting; a dismissed banner stays dismissed', async () => {
    system = {
      ...system,
      ok: false,
      issues: [
        {
          kind: 'docker_unavailable',
          severity: 'error',
          title: 'Docker is unavailable',
          detail: 'quiet can’t read /var/run/docker.sock (permission denied).',
        },
        {
          kind: 'disk_at_cap',
          severity: 'warn',
          title: 'Disk is at 96% of the 5.0 GB cap',
          detail: 'search now reaches back 2d 13h, not 3d',
        },
      ],
    }
    const user = userEvent.setup()
    renderAt('/sources')
    const docker = await screen.findByRole('alert')
    expect(docker).toHaveTextContent('Docker is unavailable')
    await user.click(within(docker).getByRole('button', { name: /Troubleshoot/ }))
    expect(within(docker).getByText(/group_add/)).toBeInTheDocument()

    const disk = screen.getByText('Disk is at 96% of the 5.0 GB cap').closest('[data-issue]') as HTMLElement
    expect(within(disk).getByRole('link', { name: 'Storage settings' })).toBeInTheDocument()
    await user.click(within(disk).getByRole('button', { name: /Dismiss/ }))
    expect(screen.queryByText('Disk is at 96% of the 5.0 GB cap')).not.toBeInTheDocument()
    expect(JSON.parse(sessionStorage.getItem('quiet.dismissed-issues') ?? '[]')).toEqual(['disk_at_cap'])
  })
})

describe('Settings → About (07.6)', () => {
  beforeEach(() => {
    githubCalls = 0
  })

  it('shows version, uptime, database and live clients; no update check while it is off', async () => {
    renderAt('/settings/about')
    expect(await screen.findByText('1d 3h')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByText('v0.1.0')).toBeInTheDocument()
    expect(screen.getByText('1.9 GB')).toBeInTheDocument()
    expect(screen.getByText('sqlite 3.46.0 · wal')).toBeInTheDocument()
    expect(screen.getByText('websocket · 2 members')).toBeInTheDocument()
    expect(screen.getByText('/var/lib/quiet')).toBeInTheDocument()
    expect(screen.getByText('/var/run/docker.sock · engine 27.3')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Check for updates daily' })).not.toBeChecked()
    await new Promise((r) => setTimeout(r, 50))
    expect(githubCalls).toBe(0)
  })

  it('switching the check on saves it and shows the newer release with the host command', async () => {
    const user = userEvent.setup()
    renderAt('/settings/about')
    await user.click(await screen.findByRole('switch', { name: 'Check for updates daily' }))
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: '/api/settings/general',
          body: expect.objectContaining({ check_updates: true }),
        }),
      ),
    )
    const callout = await screen.findByRole('region', { name: 'Update available' })
    expect(callout).toHaveTextContent('v0.1.1 is available')
    expect(callout).toHaveTextContent('patch')
    expect(callout).toHaveTextContent('Parser tolerates duplicate keys')
    expect(callout).toHaveTextContent('docker compose pull quiet && docker compose up -d quiet')
    expect(githubCalls).toBe(1)
  })
})

describe('Settings → General → Source grouping (07.11)', () => {
  it('custom label shows the found hint and a live preview, and saves', async () => {
    const user = userEvent.setup()
    renderAt('/settings#grouping')
    const section = await screen.findByRole('region', { name: 'Source grouping' })
    await user.click(within(section).getByRole('radio', { name: 'Custom label' }))
    const input = within(section).getByLabelText('Docker label key')
    expect(input).toHaveValue('quiet.group')
    expect(await within(section).findByText('found on 2 of 3')).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, 'team')
    expect(await within(section).findByText('growth')).toBeInTheDocument()
    expect(within(section).getByText('no label')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/settings/grouping',
        method: 'PUT',
        body: { mode: 'label', label: 'team' },
      }),
    )
  })

  it('is locked when the server environment sets it', async () => {
    settings.grouping = { mode: 'off', label: 'quiet.group', origin: 'flag', locked: true }
    renderAt('/settings#grouping')
    const section = await screen.findByRole('region', { name: 'Source grouping' })
    expect(within(section).getByText('set by env')).toBeInTheDocument()
    expect(within(section).getByRole('radio', { name: 'Off' })).toBeChecked()
    expect(within(section).getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('Settings → Flow id order (07.8)', () => {
  it('shows coverage per key, adds a custom field, reorders and saves', async () => {
    const user = userEvent.setup()
    renderAt('/settings/flow-id-order')
    const form = await screen.findByRole('form', { name: 'Flow id order' })
    expect(await within(form).findByText('61% of lines · legivent-api, traefik')).toBeInTheDocument()
    expect(within(form).getByText('22% · order-worker')).toBeInTheDocument()
    expect(within(form).getByText('0.1% · cron-runner')).toBeInTheDocument()

    const field = within(form).getByRole('textbox', { name: 'Add an id field' })
    await user.type(field, 'x-request-id{Enter}')
    const list = within(form).getByRole('list', { name: 'Correlation id order' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    expect(await within(form).findByText('30% · traefik')).toBeInTheDocument()

    // Move the custom field up to second place with the keyboard on its handle.
    const handle = within(form).getByRole('button', { name: 'Drag x-request-id to reorder' })
    handle.focus()
    for (let i = 0; i < 3; i++) await user.keyboard('{ArrowUp}')
    await user.click(within(form).getByRole('button', { name: 'Stop counting correlation_id' }))
    await user.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/settings/flow-ids',
        method: 'PUT',
        body: { order: ['request_id', 'x-request-id', 'job_id', 'trace_id'], match_by: 'value' },
      }),
    )
  })

  it('refuses bad, duplicate and too many custom fields', async () => {
    settings.flow_ids = {
      order: ['request_id', 'f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
      match_by: 'value',
    }
    const user = userEvent.setup()
    renderAt('/settings/flow-id-order')
    const form = await screen.findByRole('form', { name: 'Flow id order' })
    const field = within(form).getByRole('textbox', { name: 'Add an id field' })
    const add = within(form).getByRole('button', { name: 'Add id field' })
    await user.type(field, 'has space')
    expect(within(form).getByText(/Use letters, digits/)).toBeInTheDocument()
    expect(add).toBeDisabled()
    await user.clear(field)
    await user.type(field, 'f3')
    expect(within(form).getByText('f3 is already in the order')).toBeInTheDocument()
    await user.clear(field)
    await user.type(field, 'f7{Enter}')
    expect(within(form).getByRole('button', { name: 'Remove f7' })).toBeInTheDocument()
    await user.type(field, 'f8')
    expect(within(form).getByText('At most 8 custom id fields')).toBeInTheDocument()
    expect(add).toBeDisabled()
    // A built-in name brings the built-in back rather than adding a field.
    await user.clear(field)
    await user.type(field, 'job_id{Enter}')
    expect(within(form).getByText('job_id', { selector: 'span' })).toBeInTheDocument()
  })
})

const httpLine = (id: number, path: string, method = 'GET', source = 'legivent-api'): LogLine => ({
  id,
  ts: NOW - 1000 * (10 - id),
  received: NOW,
  source,
  level: 'info',
  display_id: null,
  ids: [],
  msg: 'request completed',
  fields: { msg: 'request completed', method, path, status: 200 },
  raw: JSON.stringify({ msg: 'request completed', method, path, status: 200 }),
})

describe('Settings → Muted lines (07.12–07.20)', () => {
  it('lists global rules with hits, where they are off, and pauses one with Undo', async () => {
    settings.muted_global = [rule({ id: 'mr_g', scope: 'global', value: '/metrics', origin: 'manual' })]
    settings.sources.traefik = { ...blankSource(), muted_global_off: [{ id: 'mr_g', by: 'esi', at: NOW }] }
    muteStats.rules.mr_g = { per_source: { 'legivent-api': 1020, traefik: 310, dokploy: 960 } }
    const user = userEvent.setup()
    renderAt('/settings/muted-lines')
    const table = await screen.findByRole('table', { name: 'Global rules' })
    expect(within(table).getByText('/metrics')).toBeInTheDocument()
    expect(within(table).getByText('off on traefik')).toBeInTheDocument()
    // Hidden counts leave out sources that switched the rule off.
    expect(await within(table).findByText('1,980')).toBeInTheDocument()
    expect(within(table).getByText('on 2 sources')).toBeInTheDocument()
    await user.click(within(table).getByRole('switch', { name: 'Pause path:/metrics' }))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/mute/rules/mr_g', method: 'PATCH', body: { enabled: false } }),
    )
  })

  it('empty state, then Add global rule with a live preview', async () => {
    const user = userEvent.setup()
    renderAt('/settings/muted-lines')
    expect(await screen.findByTestId('muted-empty')).toHaveTextContent('No global rules yet')
    await user.click(screen.getAllByRole('button', { name: /Add global rule/ })[0])
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Route'), '/api/v1/health?probe=1')
    expect(await within(dialog).findByText('312 lines')).toBeInTheDocument()
    expect(within(dialog).getByText('stored as path:/api/v1/health · scope global')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /Add global rule/ }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mute/rules')).toBe(true))
    const post = calls.find((c) => c.url === '/api/mute/rules')
    expect(post?.body).toMatchObject({ rule: { scope: 'global', shape: 'route', value: '/api/v1/health' } })
    expect(post?.body.source).toBeUndefined()
  })

  it("rule detail shows hits by source and Don't apply here; delete always confirms", async () => {
    settings.muted_global = [
      rule({ id: 'mr_g', scope: 'global', shape: 'field', field: 'user_agent', value: 'kube-probe/*' }),
    ]
    settings.sources.traefik = { ...blankSource(), muted_global_off: [{ id: 'mr_g', by: 'esi', at: NOW }] }
    muteStats.rules.mr_g = { per_source: { 'legivent-api': 640, traefik: 310 } }
    const user = userEvent.setup()
    renderAt('/settings/muted-lines')
    await user.click(await screen.findByText('kube-probe/*'))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('Global rule')).toBeInTheDocument()
    const hits = within(sheet).getByRole('list', { name: 'Hits by source' })
    expect(within(hits).getByText('would hide 310')).toBeInTheDocument()
    expect(within(hits).getByText('off here')).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: /Delete rule/ }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete global rule?' })
    expect(confirm).toHaveTextContent('About 640 lines a day come back on 1 source (legivent-api 640)')
    expect(confirm).toHaveTextContent('No source has its own kube-probe/* rule')
    await user.click(within(confirm).getByRole('button', { name: /Delete for all sources/ }))
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/mute/rules/mr_g', method: 'DELETE', body: null }))
  })

  it('edit global rule opens a side panel with the change and hits by source (07.16)', async () => {
    settings.muted_global = [rule({ id: 'mr_g', scope: 'global', value: '/metrics' })]
    muteStats.rules.mr_g = { per_source: { 'legivent-api': 400 } }
    const user = userEvent.setup()
    renderAt('/settings/muted-lines')
    await user.click(await screen.findByRole('button', { name: 'More for path:/metrics' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('Edit global rule')).toBeInTheDocument()
    const route = within(sheet).getByLabelText('Route')
    await user.clear(route)
    await user.type(route, '/metrics*')
    // The preview mock hides 312 on legivent-api: 88 fewer than now.
    expect(await within(sheet).findByText(/400 → 312 hidden · 24h/)).toBeInTheDocument()
    expect(within(sheet).getByText(/−88 · 88 on legivent-api show again/)).toBeInTheDocument()
    expect(within(sheet).getByRole('list', { name: 'Hits by source' })).toHaveTextContent('312')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ url: '/api/mute/rules/mr_g', method: 'PATCH' })),
    )
  })

  it('the include-in-search default lives here; members see it all read-only', async () => {
    const user = userEvent.setup()
    renderAt('/settings/muted-lines')
    await user.click(await screen.findByRole('switch', { name: 'Include muted lines in search' }))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/mute/search', method: 'PUT', body: { include: true } }),
    )
  })

  it('members: read-only callout, a locked Add rule, plain on/paused text (07.18)', async () => {
    settings.muted_global = [rule({ id: 'mr_g', scope: 'global', value: '/metrics' })]
    renderAt('/settings/muted-lines', member)
    expect(await screen.findByText('Only owners can edit muted lines')).toBeInTheDocument()
    expect(screen.queryByText('How rules combine')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Pause path:/metrics' })).not.toBeInTheDocument()
    expect(within(await screen.findByRole('table', { name: 'Global rules' })).getByText('on')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add rule/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Add global rule/ })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Include muted lines in search' })).toHaveAttribute('data-disabled')
  })
})

describe('Sources → edit → Muted lines (06.13–06.25)', () => {
  it("shows this source and the global rules; Don't apply here asks first; a small rule deletes with Undo", async () => {
    settings.muted_global = [rule({ id: 'mr_g', scope: 'global', value: '/metrics' })]
    settings.sources['legivent-api'] = {
      ...blankSource(),
      muted: [
        rule({ id: 'mr_a', value: '/api/v1/health' }),
        rule({ id: 'mr_b', shape: 'message', field: null, value: 'cache warm', enabled: false, origin: 'manual' }),
      ],
    }
    muteStats.rules = {
      mr_a: { per_source: { 'legivent-api': 312 } },
      mr_b: { per_source: { 'legivent-api': 41 } },
      mr_g: { per_source: { 'legivent-api': 1020, dokploy: 900 } },
    }
    const user = userEvent.setup()
    renderAt('/sources/legivent-api?edit=muted')
    const sheet = await screen.findByRole('dialog', { name: /Edit source/ })
    expect(await within(sheet).findByRole('tab', { name: 'Muted lines · 2' })).toHaveAttribute('aria-selected', 'true')
    const mine = within(sheet).getByRole('region', { name: 'This source' })
    expect(await within(mine).findByText('312 hidden')).toBeInTheDocument()
    expect(within(mine).getByText('would hide 41')).toBeInTheDocument()
    const global = within(sheet).getByRole('region', { name: 'Global from Settings' })
    expect(within(global).getByText('1,020 hidden here')).toBeInTheDocument()
    // Don't apply here: a popover first.
    await user.click(within(global).getByRole('switch', { name: 'Apply path:/metrics on legivent-api' }))
    await user.click(await screen.findByRole('button', { name: "Don't apply here" }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/mute/sources/legivent-api/global/mr_g',
        method: 'PUT',
        body: { apply: false },
      }),
    )
    // Under 1,000 lines a day: deleted straight away.
    await user.click(within(mine).getByRole('button', { name: 'Delete path:/api/v1/health' }))
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/mute/rules/mr_a', method: 'DELETE', body: null }))
  })

  it('a rule hiding 1,000+ lines a day asks before it goes', async () => {
    settings.sources['legivent-api'] = {
      ...blankSource(),
      muted: [rule({ id: 'mr_big', shape: 'field', field: 'user_agent', value: 'ELB-HealthChecker/*' })],
    }
    muteStats.rules = { mr_big: { per_source: { 'legivent-api': 1052 } } }
    const user = userEvent.setup()
    renderAt('/sources/legivent-api?edit=muted')
    const del = await screen.findByRole('button', { name: 'Delete user_agent=ELB-HealthChecker/*' })
    await screen.findByText('1,052 hidden')
    await user.click(del)
    const confirm = await screen.findByRole('dialog', { name: 'Delete this rule?' })
    expect(calls).toHaveLength(0)
    await user.click(within(confirm).getByRole('button', { name: /Delete rule/ }))
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/mute/rules/mr_big', method: 'DELETE', body: null }))
  })

  it('a source rule edits in place with the live change (06.18)', async () => {
    settings.sources['legivent-api'] = {
      ...blankSource(),
      muted: [rule({ id: 'mr_h', value: '/api/v1/health' })],
    }
    muteStats.rules = { mr_h: { per_source: { 'legivent-api': 300 } } }
    const user = userEvent.setup()
    renderAt('/sources/legivent-api?edit=muted')
    await user.click(await screen.findByTitle('Edit rule'))
    const panel = await screen.findByRole('form', { name: 'Edit rule' })
    const route = within(panel).getByLabelText('Route')
    await user.clear(route)
    await user.type(route, '/api/v1/health*')
    expect(await within(panel).findByText(/300 → 312 hidden · 24h/)).toBeInTheDocument()
    expect(within(panel).getByText('+12')).toBeInTheDocument()
    expect(within(panel).getByText(/The \* also catches \/api\/v1\/healthz/)).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: /Save rule/ }))
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          url: '/api/mute/rules/mr_h',
          method: 'PATCH',
          body: expect.objectContaining({ value: '/api/v1/health*' }),
        }),
      ),
    )
  })

  it('adds a method + route rule on this source', async () => {
    const user = userEvent.setup()
    renderAt('/sources/legivent-api?edit=muted')
    expect(await screen.findByText('No rules on legivent-api yet')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /Add rule/ })[0])
    const dialog = await screen.findByRole('form', { name: 'Add rule' })
    await user.click(within(dialog).getByRole('radio', { name: 'Method + route' }))
    await user.type(within(dialog).getByLabelText('Route'), '/api/v1/ping')
    expect(await within(dialog).findByText('312 lines')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /^Add rule/ }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mute/rules')).toBe(true))
    expect(calls.find((c) => c.url === '/api/mute/rules')?.body).toMatchObject({
      source: 'legivent-api',
      rule: { scope: 'source', shape: 'method_route', value: '/api/v1/ping', method: 'GET' },
    })
  })

  it('is read-only for members', async () => {
    settings.sources['legivent-api'] = { ...blankSource(), muted: [rule({})] }
    renderAt('/sources/legivent-api?edit=muted', member)
    // 06.23: a banner, a locked Add rule, on / paused as text, no delete.
    expect(await screen.findByText('Only owners can edit muted lines')).toBeInTheDocument()
    expect(screen.getByText('member · read-only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add rule/ })).toBeDisabled()
    expect(screen.queryByRole('switch', { name: 'Pause path:/api/v1/health' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete path:/api/v1/health' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0)
  })
})

describe('stream row hover → Mute (03.15–03.23)', () => {
  it('Mute mutes the route (query ignored) on this source, rows fade, toast with Undo', async () => {
    backlog = [httpLine(1, '/api/v1/orders'), httpLine(2, '/api/v1/health?probe=1')]
    const user = userEvent.setup()
    renderAt('/?source=legivent-api')
    const row = await waitFor(() => {
      const r = document.querySelector('[data-line-id="2"]')
      if (!r) throw new Error('no row')
      return r as HTMLElement
    })
    const mute = within(row).getByRole('button', {
      name: 'Mute /api/v1/health on legivent-api · any method · from path',
    })
    await user.click(mute)
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mute/rules')).toBe(true), { timeout: 3000 })
    expect(calls.find((c) => c.url === '/api/mute/rules')?.body).toMatchObject({
      source: 'legivent-api',
      rule: { scope: 'source', shape: 'route', value: '/api/v1/health', field: 'path', origin: 'hover' },
    })
    // Hidden from the stream now; the other row stays.
    await waitFor(() => expect(document.querySelector('[data-line-id="2"]')).toBeNull())
    expect(document.querySelector('[data-line-id="1"]')).not.toBeNull()
    expect(await screen.findByText('Muted /api/v1/health on legivent-api')).toBeInTheDocument()
  })

  it('no route on the line: Mute message mutes the exact message', async () => {
    backlog = [{ ...line(1), msg: 'heartbeat ok', raw: 'heartbeat ok', level: 'info' }]
    const user = userEvent.setup()
    renderAt('/?source=legivent-api')
    const btn = await screen.findByRole('button', { name: /^Mute this message on legivent-api/ })
    expect(btn).toHaveTextContent('Mute message')
    await user.click(btn)
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mute/rules')).toBe(true), { timeout: 3000 })
    expect(calls.find((c) => c.url === '/api/mute/rules')?.body.rule).toMatchObject({
      shape: 'message',
      value: 'heartbeat ok',
    })
  })

  it('⇧M opens the menu: pick 2 (method + route), Tab to All sources, ↵ mutes everywhere', async () => {
    backlog = [httpLine(1, '/api/v1/health')]
    const user = userEvent.setup()
    renderAt('/?source=legivent-api')
    await screen.findByText('/api/v1/health')
    await user.keyboard('j')
    await user.keyboard('{Shift>}M{/Shift}')
    const menu = await screen.findByTestId('mute-menu')
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3)
    expect(within(menu).getByRole('menuitemradio', { name: /Mute route · any method/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.keyboard('2')
    expect(within(menu).getByRole('menuitemradio', { name: /Mute GET \/api\/v1\/health only/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.keyboard('{Tab}')
    expect(within(menu).getByRole('radio', { name: /All sources/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('button', { name: /Mute everywhere/ })).toBeInTheDocument()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mute/rules')).toBe(true), { timeout: 3000 })
    const body = calls.find((c) => c.url === '/api/mute/rules')?.body
    expect(body.rule).toMatchObject({ scope: 'global', shape: 'method_route', method: 'GET', value: '/api/v1/health' })
    expect(body.source).toBeUndefined()
  })

  it('members: Mute is locked and M explains why', async () => {
    backlog = [httpLine(1, '/api/v1/health')]
    const user = userEvent.setup()
    renderAt('/?source=legivent-api', member)
    const btn = await screen.findByRole('button', { name: /Only owners can edit muted lines/ })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    await user.click(btn)
    await user.keyboard('j')
    await user.keyboard('m')
    expect(calls).toHaveLength(0)
  })

  it('a row muted by a global rule (Show muted) offers Show on this source only', async () => {
    settings.muted_global = [rule({ id: 'mr_g', scope: 'global', value: '/api/v1/health' })]
    backlog = [httpLine(1, '/api/v1/orders'), httpLine(2, '/api/v1/health')]
    const user = userEvent.setup()
    renderAt('/?source=legivent-api')
    const note = await screen.findByTestId('muted-note')
    expect(note).toHaveTextContent('1 mute rule · 1 hidden')
    await user.click(within(note).getByRole('button', { name: 'Show muted' }))
    const row = await waitFor(() => {
      const r = document.querySelector('[data-line-id="2"]')
      if (!r) throw new Error('no row')
      return r as HTMLElement
    })
    expect(row).toHaveAttribute('data-muted', 'true')
    expect(within(row).getByTestId('muted-tag')).toHaveTextContent('global · path:/api/v1/health')
    await user.click(within(row).getByRole('button', { name: 'Mute options' }))
    await user.click(await screen.findByRole('menuitem', { name: /Show on legivent-api only/ }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/mute/sources/legivent-api/global/mr_g',
        method: 'PUT',
        body: { apply: false },
      }),
    )
  })
})
