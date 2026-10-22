import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, LogLine, SearchResponse, SourceInfo } from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const sources: SourceInfo[] = [
  {
    name: 'api',
    kind: 'docker',
    containers: [],
    group: null,
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
  mk(3, 'worker', 'req_1', 'error', 'settle_dealer_payout failed', { dealer_id: 88 }),
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
    warn: 0,
    error: 0,
  })),
  searched: 412_000,
  took_ms: 84,
  since: T,
  until: T + 6 * 3_600_000,
})

let calls: string[] = []

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
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
      if (url.startsWith('/api/search')) {
        const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
        return json(page(q.includes('nothing') ? [] : lines))
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
    await user.click(within(dialog).getByRole('button', { name: 'job_id' }))
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
})
