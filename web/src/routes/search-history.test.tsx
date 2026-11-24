import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, HistoryCoverage, HistorySearchJob, LogLine, SearchResponse } from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

// Phase 5c: a search range past the local window shows what retained history
// covers, searches it (at once when it is only a few hours back), and merges
// the matches with a location tag.

const H = 3_600_000
const T = Date.UTC(2026, 10, 20, 12)
const health: Health = {
  ok: true,
  version: '0.1.1',
  started: 0,
  docker: { state: 'disabled' },
  store: 'sqlite',
  retention_ms: 24 * H,
  disk_bytes: 1000,
  stored_lines: 1,
  oldest: 0,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const line = (id: number, ts: number, msg: string): LogLine => {
  const fields = { level: 'info', msg, flow: 'settle_dealer_payout', request_id: `req_${id}` }
  return {
    id,
    ts,
    received: ts,
    source: 'api',
    level: 'info',
    display_id: { key: 'request_id', value: `req_${id}` },
    ids: [{ key: 'request_id', value: `req_${id}` }],
    msg,
    fields,
    raw: JSON.stringify(fields),
  }
}
const coverage = (auto: boolean): HistoryCoverage => ({
  from: T - 30 * H,
  to: T - 24 * H,
  hours: 6,
  archived: 6,
  destinations: [
    { id: 1, name: 'garage-local', active: true, first: T - 30 * H, last: T - 24 * H, hours: 6, percent: 100 },
  ],
  gaps: [],
  expired_before: null,
  auto,
  truncated: false,
})
const page = (auto: boolean): SearchResponse => ({
  lines: [line(50, T - 2 * H, 'local payout')],
  next_cursor: null,
  total: 1,
  bytes: 100,
  histogram: null,
  searched: 10,
  took_ms: 3,
  since: T - 30 * H,
  until: T,
  history: coverage(auto),
})
let polls = 0
let posted: string[] = []
const job = (state: HistorySearchJob['state']): HistorySearchJob => ({
  id: 'hs_1',
  state,
  done: state === 'retrieving' ? 2 : 6,
  total: 6,
  bytes: 1_000_000,
  downloaded: 1_000_000,
  matched: 1,
  lines: state === 'retrieving' ? [] : [line(7, T - 26 * H, 'archived payout')],
  locations: state === 'retrieving' ? {} : { '7': 'garage-local' },
  histogram: null,
  failures: [],
  coverage: coverage(true),
  created: 0,
  offset: 0,
  count: state === 'retrieving' ? 0 : 1,
})

beforeEach(() => {
  polls = 0
  posted = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url.startsWith('/api/sources')) return json({ sources: [] })
      if (url === '/api/search/history' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)).query)
        return json(job('retrieving'), 202)
      }
      if (url.startsWith('/api/search/history/hs_1')) {
        polls++
        return json(job(polls > 1 ? 'done' : 'retrieving'))
      }
      if (url.startsWith('/api/search')) {
        const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
        return json(page(q.includes('near')))
      }
      if (url.startsWith('/api/flow-summaries')) return json({ flows: [] })
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
}

describe('search across retained history', () => {
  it('a few hours back: searched at once, matches merged and tagged with their location', async () => {
    renderAt(`/search?q=near&view=lines&from=${T - 30 * H}&to=${T}`)
    expect(await screen.findByLabelText('Retained history', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('q=near')
    expect(posted[0]).toContain(`since=${T - 30 * H}`)
    expect(await screen.findByText(/1 event from retained history/, {}, { timeout: 5000 })).toBeInTheDocument()
    // Newest first: the local line, then the archived one.
    await waitFor(() =>
      expect([...document.querySelectorAll('[data-line-id]')].map((e) => e.getAttribute('data-line-id'))).toEqual([
        '50',
        '7',
      ]),
    )
    // Headings by day and location instead of a tag per row (v1.1-19).
    expect(screen.getByText(/ · GARAGE$/)).toBeInTheDocument()
    expect(screen.getByText(/ · RECENT$/)).toBeInTheDocument()
    // An archived line's flow opens in retained history, with the way back (v1.1-23).
    const open = document.querySelector('[data-line-id="7"] a[aria-label="Open as flow"]')
    expect(open?.getAttribute('href')).toMatch(/at=\d+/)
    expect(open?.getAttribute('href')).toContain('back=')
    expect(screen.getByText('2 lines')).toBeInTheDocument()
  })

  it('further back: waits for Search retained history', async () => {
    renderAt(`/search?q=far&view=lines&from=${T - 30 * H}&to=${T}`)
    const btn = await screen.findByRole('button', { name: 'Search retained history' }, { timeout: 5000 })
    expect(posted).toHaveLength(0)
    await userEvent.click(btn)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(await screen.findByText(/1 event from retained history/, {}, { timeout: 5000 })).toBeInTheDocument()
  })
})
