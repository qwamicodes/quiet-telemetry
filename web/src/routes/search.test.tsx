import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL } from '@/components/export-dialog'
import type { Health, LogLine, SearchResponse, SourceInfo } from '@/gen'
import { toast } from '@/lib/toast'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const sources: SourceInfo[] = [
  {
    name: 'api',
    kind: 'docker',
    containers: [],
    group: null,
    group_kind: null,
    lines: 3,
    last_ts: Date.now(),
    display_name: null,
    hidden: false,
    paused: false,
  },
  {
    name: 'worker',
    kind: 'http',
    containers: [],
    group: null,
    group_kind: null,
    lines: 1,
    last_ts: Date.now(),
    display_name: null,
    hidden: false,
    paused: false,
  },
]
const health: Health = {
  ok: true,
  version: '0.1.0',
  started: 0,
  docker: { state: 'disabled' },
  store: 'sqlite',
  retention_ms: 86_400_000,
  disk_bytes: 1000,
  stored_lines: 4,
  oldest: 0,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const T = 1_760_000_000_000
const mk = (id: number, source: string, rid: string, level: LogLine['level'], msg: string, extra = {}): LogLine => {
  const fields = { level, msg, request_id: rid, ...extra }
  return {
    id,
    ts: T + id * 1000,
    received: T + id * 1000,
    source,
    level,
    display_id: { key: 'request_id', value: rid },
    ids: [{ key: 'request_id', value: rid }],
    msg,
    fields,
    raw: JSON.stringify(fields),
  }
}
const lines = [
  mk(3, 'worker', 'req_1', 'error', 'settle_dealer_payout failed', { dealer_id: 88, operation: 'settle_payout' }),
  mk(2, 'api', 'req_2', 'info', 'GET /health'),
  mk(1, 'api', 'req_1', 'warn', 'GET /dealers/88/payouts slow', { duration_ms: 1912 }),
]
const page = (ls: LogLine[]): SearchResponse => ({
  lines: ls,
  next_cursor: null,
  total: ls.length,
  bytes: 4096,
  histogram: Array.from({ length: 60 }, (_, i) => ({
    start: T + i,
    count: i === 59 ? ls.length : 0,
    debug: 0,
    info: i === 59 ? ls.length : 0,
    warn: 0,
    error: 0,
  })),
  searched: 412_000,
  took_ms: 84,
  since: T,
  until: T + 6 * 3_600_000,
})

let calls: string[] = []
let jobReady = false
/** `GET /api/settings`; null → 404 (no muted-lines rules). */
let settingsBody: unknown = null
let bodies: Record<string, string> = {}

beforeEach(() => {
  calls = []
  bodies = {}
  jobReady = false
  settingsBody = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (init?.body) bodies[url] = String(init.body)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url.startsWith('/api/sources')) return json({ sources })
      if (url.startsWith('/api/export/token')) {
        const { query } = JSON.parse(String(init?.body))
        return json({
          token: 'qx_0123456789abcdef9c1e',
          expires_at: Date.now() + 900_000,
          path: `/api/export?${query}`,
        })
      }
      if (url.startsWith('/api/flow-summaries')) {
        // req_1's flow has 5 lines (its worker retries didn't match the search).
        const { ids } = JSON.parse(String(init?.body)) as { ids: string[] }
        const flow = {
          key: '1',
          title: 'settle_dealer_payout',
          status: 'error',
          line_count: 5,
          steps: 6,
          sources: ['api', 'worker'],
          started: T,
          ended: T + 9_600,
          duration_ms: 9_600,
          retries: 2,
          errors: 1,
          warnings: 1,
          ids: [{ key: 'request_id', value: 'req_1' }],
          stitched_by: ['request_id', 'job_id'],
          truncated: false,
        }
        return json({ flows: ids.map((id) => ({ id, flow: id === 'req_1' ? flow : null })) })
      }
      if (url.startsWith('/api/export/jobs')) {
        // 05.7: preparing → (poll) 40% → (poll) ready; DELETE cancels.
        if (init?.method === 'DELETE') return new Response(null, { status: 204 })
        const base = {
          id: 'job1',
          total: 250_000,
          file_name: 'quiet-api-2026-10-22.ndjson.gz',
          started: Date.now(),
          masked: true,
          error: null,
          expires_at: null,
          finished: null,
        }
        if (init?.method === 'POST') {
          return json({ ...base, state: 'preparing', done: 0, bytes: 0, eta_ms: null }, 202)
        }
        if (!jobReady) return json({ ...base, state: 'preparing', done: 100_000, bytes: 1, eta_ms: 6_000 })
        return json({ ...base, state: 'ready', done: 250_000, bytes: 48_000_000, eta_ms: null, finished: 1 })
      }
      if (url.startsWith('/api/search')) {
        const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
        if (q.includes('huge')) return json({ ...page(lines), total: 250_000, bytes: 960_000_000 })
        return json(page(q.includes('nothing') ? [] : lines))
      }
      if (url === '/api/settings' && settingsBody) return json(settingsBody)
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

const searches = () => calls.filter((c) => c.startsWith('/api/search?') && c.includes('limit=200'))

describe('search route', () => {
  it('bad URL params fall back to defaults; results group by flow', async () => {
    const router = renderAt('/search?q=dealer&range=bogus&view=nope&order=sideways')
    expect(
      await screen.findByText('GET /dealers/88/payouts slow', { exact: false }, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ q: 'dealer', range: '6h', view: 'flows', order: 'newest' })
    const url = new URL(searches()[0], 'http://x')
    expect(url.searchParams.get('q')).toBe('dealer')
    expect(url.searchParams.get('order')).toBe('newest')
    expect(url.searchParams.get('buckets')).toBe('60')
    expect(Number(url.searchParams.get('until')) - Number(url.searchParams.get('since'))).toBe(6 * 3_600_000)

    // Two flows: req_1 (worker + api) and req_2.
    expect(screen.getByText(/3 lines in 2 flows/)).toBeInTheDocument()
    // Group by flow is the stitched flow: its title, how many of its lines matched, its steps.
    expect(await screen.findByText(/failed · 2 of 5 lines match · 6 steps · 9.6s/)).toBeInTheDocument()
    expect(screen.getByText('settle_dealer_payout')).toBeInTheDocument()
    expect(screen.getByText('api → worker')).toBeInTheDocument()
    expect(screen.getByText(/1 line match/)).toBeInTheDocument() // req_2 has no flow summary
    expect(calls.filter((c) => c === '/api/flow-summaries')).toHaveLength(1)
    expect(screen.getAllByRole('link', { name: /Open flow/ })[0]).toHaveAttribute('href', '/flow/req_1')
    expect(screen.getByRole('figure', { name: 'Matches over time' })).toBeInTheDocument()
  })

  it('typing + Enter searches; clicking a value adds a key:value chip; chips come off', async () => {
    const user = userEvent.setup()
    const router = renderAt('/search')
    const input = await screen.findByRole('textbox', { name: 'Search' })
    await user.type(input, '88{Enter}')
    await waitFor(() => expect(router.state.location.search.q).toBe('88'))

    await user.click(await screen.findByRole('button', { name: 'dealer_id:88' }))
    await waitFor(() => expect(router.state.location.search.q).toBe('dealer_id:88 88'))
    await waitFor(() => expect(searches().at(-1)).toContain('q=dealer_id%3A88%2088'))

    await user.click(screen.getByRole('button', { name: 'Remove dealer_id:88' }))
    await waitFor(() => expect(router.state.location.search.q).toBe('88'))
  })

  it('lines view and the no-results state', async () => {
    const user = userEvent.setup()
    const router = renderAt('/search?q=nothing&source=worker&range=1h')
    expect(await screen.findByText('No lines match in the last 1h')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Search last 24h/ }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: '24h' }))
    expect(router.state.location.search.source).toBeUndefined()

    await router.navigate({ to: '/search', search: { q: 'dealer', view: 'lines' } })
    expect(await screen.findByText(/^3 lines$/)).toBeInTheDocument()
  })

  it('no results suggests similar values seen in the window (05.3)', async () => {
    const user = userEvent.setup()
    const router = renderAt('/search?q=nothing_settled&range=1h')
    expect(await screen.findByText('No lines match in the last 1h')).toBeInTheDocument()
    const chip = await screen.findByRole('button', { name: 'operation:settle_payout' }, { timeout: 5000 })
    await user.click(chip)
    await waitFor(() => expect(router.state.location.search.q).toBe('operation:settle_payout'))
  })

  it('the time picker shows the whole window; dragging across it picks a range (05.2)', async () => {
    const user = userEvent.setup()
    const router = renderAt('/search?q=dealer')
    await screen.findByText(/3 lines in 2 flows/)
    await user.click(screen.getByRole('button', { name: /Last 6h/ }))
    expect(await screen.findByText('24h window')).toBeInTheDocument()
    const bars = await screen.findAllByTestId('brush-bar')
    expect(calls.some((c) => c.includes('buckets=48'))).toBe(true)
    fireEvent.pointerDown(bars[10])
    fireEvent.pointerEnter(bars[20])
    // While dragging, the bars under the brush are highlighted.
    expect(bars[15]).toHaveAttribute('data-on', 'true')
    expect(bars[25]).not.toHaveAttribute('data-on')
    fireEvent.pointerUp(bars[20])
    await waitFor(() => expect(router.state.location.search.from).toBeTypeOf('number'))
    expect(router.state.location.search.to).toBeTypeOf('number')
  })

  it('time range picker (Popover) and source select (Select) open and change the URL', async () => {
    const user = userEvent.setup()
    const router = renderAt('/search?q=dealer')
    await screen.findByText(/3 lines in 2 flows/)
    await user.click(screen.getByRole('button', { name: /Last 6h/ }))
    await user.click(await screen.findByRole('option', { name: /Last 24 hours/ }))
    await waitFor(() => expect(router.state.location.search.range).toBe('24h'))

    await user.click(screen.getByRole('combobox', { name: 'Source' }))
    await user.click(await screen.findByRole('option', { name: 'worker' }))
    await waitFor(() => expect(router.state.location.search.source).toBe('worker'))
  })
})

describe('muted lines in search (06.3)', () => {
  const settingsWith = (instance: boolean, apiInclude: boolean | null = null) => ({
    general: {
      instance_name: 'quiet',
      stream_direction: 'bottom',
      timezone: 'local',
      public_url: null,
      timestamps: 'millis',
      max_line_bytes: 65536,
      keep_non_json: true,
      check_updates: false,
      search_include_muted: instance,
    },
    storage: {
      retention_ms: 86_400_000,
      retention_origin: 'default',
      max_disk: 5e9,
      max_disk_origin: 'default',
      flag_retention_ms: 86_400_000,
      flag_max_disk: 5e9,
      at_cap: 'drop_oldest_hour',
    },
    muted_search: { include: instance, origin: 'setting', flag: false },
    grouping: { mode: 'auto', label: 'quiet.group', origin: 'default', locked: false },
    flow_ids: { order: ['request_id', 'job_id', 'trace_id', 'correlation_id'], match_by: 'value' },
    sources: {
      api: {
        display_name: null,
        hidden: false,
        paused: false,
        retention_ms: null,
        id_keys: null,
        default_level: null,
        mask_fields: [],
        unmasked: [],
        muted: [{ field: 'msg', value: 'GET /health*' }],
        search_include_muted: apiInclude,
      },
    },
  })
  const downloadHref = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Export' }))
    const dialog = await screen.findByRole('dialog')
    const href = within(dialog).getByRole('button', { name: 'Download' }).getAttribute('href') ?? ''
    const row = within(dialog).queryByText(/as in this view|search setting/)?.textContent ?? null
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    return { href, row }
  }

  it('hidden by default; Show muted includes them dimmed and tagged (muted=include); Hide hides them again', async () => {
    settingsBody = settingsWith(false)
    const user = userEvent.setup()
    const router = renderAt('/search?q=dealer&view=lines')
    const note = await screen.findByTestId('muted-note')
    expect(note).toHaveTextContent('1 muted · hidden')
    expect(screen.queryByText('GET /health')).not.toBeInTheDocument()
    // The export leaves them out too (per source, as search shows them).
    let ex = await downloadHref(user)
    expect(ex.href).toContain('muted=auto')

    await user.click(within(note).getByRole('button', { name: 'Show muted' }))
    await waitFor(() => expect(router.state.location.search.muted).toBe('include'))
    expect(await screen.findByText('GET /health')).toBeInTheDocument()
    const row = document.querySelector('[data-line-id="2"]') as HTMLElement
    expect(row).toHaveAttribute('data-muted', 'true')
    expect(row.className).toContain('opacity-50')
    expect(within(row).getByText('muted')).toBeInTheDocument()
    // Other rows are not dimmed.
    expect(document.querySelector('[data-line-id="1"]')).not.toHaveAttribute('data-muted')
    expect(screen.getByTestId('muted-note')).toHaveTextContent('1 muted line included')
    ex = await downloadHref(user)
    expect(ex.href).not.toContain('muted=')
    expect(ex.row).toBe('included, as in this view')

    await user.click(within(screen.getByTestId('muted-note')).getByRole('button', { name: 'Hide' }))
    await waitFor(() => expect(router.state.location.search.muted).toBe('hide'))
    await waitFor(() => expect(screen.queryByText('GET /health')).not.toBeInTheDocument())
    ex = await downloadHref(user)
    expect(ex.href).toContain('muted=hide')
    expect(ex.row).toBe('left out, as in this view')
  })

  it('the setting includes them without a URL param; muted=hide overrides it for one search', async () => {
    settingsBody = settingsWith(true)
    renderAt('/search?q=dealer&view=lines')
    const note = await screen.findByTestId('muted-note')
    expect(note).toHaveTextContent('1 muted line included')
    expect(await screen.findByText('GET /health')).toBeInTheDocument()
    expect(within(note).getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('a source can opt out of the instance default; a hand-edited muted= falls back to the setting', async () => {
    settingsBody = settingsWith(true, false)
    renderAt('/search?q=dealer&view=lines&muted=sometimes')
    expect(await screen.findByTestId('muted-note')).toHaveTextContent('1 muted · hidden')
    expect(screen.queryByText('GET /health')).not.toBeInTheDocument()
  })
})

describe('export dialog', () => {
  it('builds the download URL from the search and copies a qx_ curl', async () => {
    const user = userEvent.setup()
    renderAt('/search?q=dealer&source=api')
    await screen.findByText(/3 lines in 2 flows/)
    await user.click(screen.getByRole('button', { name: 'Export' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Export search results')).toBeInTheDocument()
    expect(await within(dialog).findByText(/≈ 3 lines · ~4 KB raw/)).toBeInTheDocument()

    // NDJSON by default, gzip + mask on.
    let href = within(dialog).getByRole('button', { name: 'Download' }).getAttribute('href') ?? ''
    expect(href).toMatch(/^\/api\/export\?/)
    expect(href).toContain('format=ndjson')
    expect(href).toContain('gzip=1')
    expect(href).toContain('mask=pii')
    expect(href).toContain('q=dealer')
    expect(href).toContain('source=api')
    expect(within(dialog).getByText(/quiet-api-\d{4}-\d{2}-\d{2}\.ndjson\.gz/)).toBeInTheDocument()

    // CSV: columns appear, one more can be added, gzip off.
    await user.click(within(dialog).getByRole('radio', { name: 'CSV' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Add job_id' }))
    await user.click(within(dialog).getByRole('switch', { name: 'Gzip' }))
    href = within(dialog).getByRole('button', { name: 'Download' }).getAttribute('href') ?? ''
    expect(decodeURIComponent(href)).toContain(
      'columns=timestamp,level,source,request_id,msg,status,duration_ms,job_id',
    )
    expect(href).toContain('format=csv')
    expect(href).not.toContain('gzip')

    // Copy curl: a token for exactly this query; the full token goes to the clipboard only.
    await user.click(within(dialog).getByRole('button', { name: 'Copy curl' }))
    const curl = await within(dialog).findByTestId('curl')
    expect(curl).toHaveTextContent('qx_····9c1e')
    expect(curl).not.toHaveTextContent('0123456789abcdef')
    // user-event provides the clipboard; read back what was copied.
    const copied = await navigator.clipboard.readText()
    expect(copied).toContain('Bearer qx_0123456789abcdef9c1e')
    const tokenCall = calls.find((c) => c === '/api/export/token')
    expect(tokenCall).toBeTruthy()
    expect(copied).toContain(href)
  })

  it('over ~100k lines the server prepares the file with progress; Cancel stops it; ready → toast + Download (05.7/05.8)', async () => {
    POLL.ms = 10
    const success = vi.spyOn(toast, 'success')
    const info = vi.spyOn(toast, 'info')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const user = userEvent.setup()
    renderAt('/search?q=huge&source=api')
    await user.click(await screen.findByRole('button', { name: 'Export' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/≈ 250k lines/)).toBeInTheDocument()

    // Large: Download is a button that starts a server job (no direct href).
    let download = within(dialog).getByRole('button', { name: 'Download' })
    expect(download.getAttribute('href')).toBeNull()
    await user.click(download)
    const progress = await within(dialog).findByRole('region', { name: 'Export progress' })
    expect(JSON.parse(bodies['/api/export/jobs']).query).toContain('q=huge')
    expect(within(progress).getByText(/prepares the file on the server first/)).toBeInTheDocument()
    expect(await within(progress).findByText('Preparing 250k lines · 40%')).toBeInTheDocument()
    expect(progress).toHaveTextContent('100k / 250k · ~6s left')
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeDisabled()

    // Cancel: DELETE, progress goes away.
    await user.click(within(progress).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(within(dialog).queryByRole('region', { name: 'Export progress' })).toBeNull())
    expect(calls).toContain('/api/export/jobs/job1')
    expect(info).toHaveBeenCalledWith('Export cancelled', expect.anything())

    // Again, to the end: a toast with the file and its size, and Download works.
    await user.click(within(dialog).getByRole('button', { name: 'Download' }))
    await within(dialog).findByText('Preparing 250k lines · 40%')
    jobReady = true
    await waitFor(() => expect(success).toHaveBeenCalledWith('Export ready', expect.anything()), { timeout: 3000 })
    const opts = success.mock.calls.find((c) => c[0] === 'Export ready')?.[1]
    expect(opts?.description).toBe('quiet-api-2026-10-22.ndjson.gz · 48 MB')
    download = within(dialog).getByRole('button', { name: 'Download' })
    await waitFor(() => expect(download).toBeEnabled())
    await user.click(download)
    expect(click).toHaveBeenCalled()
    expect((click.mock.contexts.at(-1) as HTMLAnchorElement).getAttribute('href')).toBe(
      '/api/export/jobs/job1/download',
    )
  })
})
