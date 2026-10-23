import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Histogram } from '@/components/search/histogram'
import type { Bucket, Health, LogLine, SearchResponse, SourceInfo } from '@/gen'
import { fmtClock } from '@/lib/format'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const T = 1_760_000_000_000
const H6 = 6 * 3_600_000
const W = H6 / 60
const sources: SourceInfo[] = [
  {
    name: 'api',
    kind: 'http',
    containers: [],
    group: null,
    group_kind: null,
    lines: 3,
    last_ts: T,
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
  retention_ms: 7 * 86_400_000,
  disk_bytes: 1000,
  stored_lines: 4,
  oldest: 0,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const mk = (id: number, ts: number, msg: string): LogLine => ({
  id,
  ts,
  received: ts,
  source: 'api',
  level: 'info',
  display_id: null,
  ids: [],
  msg,
  fields: { msg },
  raw: msg,
})
/** Lines in bar 1 and bar 2; bar 59 holds lines the first page never reached. */
const lines = [mk(1, T + W + 1_000, 'bar one line'), mk(2, T + 2 * W + 1_000, 'bar two line')]
const bucket = (i: number, count: number): Bucket => ({
  start: T + i * W,
  count,
  debug: 0,
  info: count,
  warn: 0,
  error: 0,
})
const histogram = Array.from({ length: 60 }, (_, i) => bucket(i, i === 1 || i === 2 ? 1 : i === 59 ? 40 : 0))
let nextCursor: string | null = null
const page = (since: number, until: number): SearchResponse => ({
  lines,
  next_cursor: nextCursor,
  total: 42,
  bytes: 1,
  histogram,
  searched: 100,
  took_ms: 3,
  since,
  until,
})

let calls: string[] = []
beforeEach(() => {
  calls = []
  nextCursor = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url.startsWith('/api/sources')) return json({ sources })
      if (url.startsWith('/api/flow-summaries')) return json({ flows: [] })
      if (url.startsWith('/api/search')) {
        const p = new URL(url, 'http://x').searchParams
        return json(page(Number(p.get('since')), Number(p.get('until'))))
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
const bar = (i: number) => screen.findByRole('button', { name: new RegExp(`Jump to ${fmtClock(T + i * W)}$`) })
const resultCalls = () => calls.filter((c) => c.startsWith('/api/search?') && c.includes('limit=200'))
const overviewCalls = () => calls.filter((c) => c.startsWith('/api/search?') && c.includes('limit=1&'))
const range = `from=${T}&to=${T + H6}`

describe('search Histogram', () => {
  it('bars with matches are buttons; the last bar spans to the end of the range', async () => {
    const onJump = vi.fn()
    const user = userEvent.setup()
    render(<Histogram buckets={histogram} since={T} until={T + H6} onJump={onJump} selected={2} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: new RegExp(`Jump to ${fmtClock(T + 2 * W)}$`) })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(screen.getByRole('button', { name: new RegExp(`Jump to ${fmtClock(T + 59 * W)}$`) }))
    expect(onJump).toHaveBeenLastCalledWith({ from: T + 59 * W, to: T + H6 + 1 }, 59)
  })
})

describe('search: click the histogram to jump', () => {
  it('a bar inside the loaded results scrolls there and tints it, without a new query', async () => {
    const user = userEvent.setup()
    const router = renderAt(`/search?q=x&view=lines&${range}`)
    await screen.findByText('bar two line', {}, { timeout: 5000 })
    const before = resultCalls().length
    await user.click(await bar(2))
    const row = screen.getByText('bar two line').closest('[data-line-id]') as HTMLElement
    await waitFor(() => expect(row).toHaveAttribute('data-flash', 'true'))
    expect(screen.getByText('bar one line').closest('[data-line-id]')).not.toHaveAttribute('data-flash')
    expect(await bar(2)).toHaveAttribute('aria-pressed', 'true')
    expect(router.state.location.search.at).toBeUndefined()
    expect(resultCalls()).toHaveLength(before)
  })

  it('a bar past the loaded results re-anchors the page there (at=), keeping the whole histogram', async () => {
    nextCursor = 'more'
    const user = userEvent.setup()
    const router = renderAt(`/search?q=x&view=lines&order=oldest&${range}`)
    await screen.findByText('bar two line', {}, { timeout: 5000 })
    await user.click(await bar(59))

    const at = T + 59 * W
    await waitFor(() => expect(router.state.location.search.at).toBe(at))
    await waitFor(() => expect(resultCalls().some((c) => c.includes(`since=${at}`))).toBe(true))
    // The overview keeps the whole range: its histogram and total.
    await waitFor(() => expect(overviewCalls().length).toBeGreaterThan(0))
    expect(overviewCalls().at(-1)).toContain(`since=${T}&`)
    expect(await screen.findByText(`from ${fmtClock(at)} on`)).toBeInTheDocument()
    expect(await bar(59)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/42 lines/)).toBeInTheDocument()

    // Clear the anchor: the whole range again.
    await user.click(screen.getByRole('button', { name: 'Show results from the whole range' }))
    await waitFor(() => expect(router.state.location.search.at).toBeUndefined())
  })

  it('a linked at= opens the results anchored there with its bar marked', async () => {
    const at = T + 2 * W + 5_000
    renderAt(`/search?q=x&view=lines&${range}&at=${at}`)
    await screen.findByText('bar two line', {}, { timeout: 5000 })
    expect(resultCalls()[0]).toContain(`until=${at}`)
    expect(await bar(2)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(`from ${fmtClock(at)} back`)).toBeInTheDocument()
  })

  it('an at= outside the range is ignored', async () => {
    renderAt(`/search?q=x&view=lines&${range}&at=${T + 2 * H6}`)
    await screen.findByText('bar two line', {}, { timeout: 5000 })
    expect(resultCalls()[0]).toContain(`until=${T + H6}`)
    expect(overviewCalls()).toHaveLength(0)
  })
})
