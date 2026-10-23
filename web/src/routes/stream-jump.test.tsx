import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamHistogram } from '@/components/stream/stream-histogram'
import type { Bucket, Health, LogLine, SearchResponse, SourceInfo, StreamStats } from '@/gen'
import { fmtClock } from '@/lib/format'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const M = 60_000
const NOW = Date.now()
const SINCE = NOW - (NOW % M) - 59 * M
const sources: SourceInfo[] = [
  {
    name: 'api',
    kind: 'http',
    containers: [],
    group: null,
    group_kind: null,
    lines: 3,
    last_ts: NOW,
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
  store: 'memory',
  retention_ms: 86_400_000,
  disk_bytes: 0,
  stored_lines: 0,
  oldest: null,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const mk = (id: number, ts: number, msg: string, level: LogLine['level'] = 'info'): LogLine => ({
  id,
  ts,
  received: ts,
  source: 'api',
  level,
  display_id: null,
  ids: [],
  msg,
  fields: { level, msg },
  raw: JSON.stringify({ level, msg }),
})
/** Bar 50 (9 minutes ago) is only in history; bar 59 (this minute) is in the buffer. */
const OLD_BAR = 50
const oldStart = SINCE + OLD_BAR * M
const NEW_BAR = 59
const newStart = SINCE + NEW_BAR * M
const backlog = [mk(10, newStart - 30_000, 'previous minute line'), mk(11, newStart + 100, 'current minute line')]
const historyLines = [mk(3, oldStart + 1_000, 'old minute line', 'error'), mk(4, oldStart + 2_000, 'old second line')]

const bucket = (i: number, count: number, error = 0): Bucket => ({
  start: SINCE + i * M,
  count,
  debug: 0,
  info: count - error,
  warn: 0,
  error,
})
const stats: StreamStats = {
  total: 5,
  levels: { debug: 0, info: 4, warn: 0, error: 1, none: 0 },
  histogram: Array.from({ length: 60 }, (_, i) =>
    i === OLD_BAR ? bucket(i, 2, 1) : i === NEW_BAR - 1 ? bucket(i, 1) : i === NEW_BAR ? bucket(i, 1) : bucket(i, 0),
  ),
  since: NOW - 86_400_000,
  until: NOW + 60_000,
  hist_since: SINCE,
  hist_width: M,
}
const searchPage = (ls: LogLine[]): SearchResponse => ({
  lines: ls,
  next_cursor: null,
  total: null,
  bytes: null,
  histogram: null,
  searched: 10,
  took_ms: 1,
  since: 0,
  until: 0,
})

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.all.push(this)
    queueMicrotask(() => {
      this.onopen?.()
      this.onmessage?.({ data: JSON.stringify({ type: 'backlog', lines: backlog }) })
    })
  }
  close() {}
}

let calls: string[] = []
beforeEach(() => {
  calls = []
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url.startsWith('/api/sources')) return json({ sources })
      if (url.startsWith('/api/stream/stats')) return json(stats)
      if (url.startsWith('/api/search')) return json(searchPage(historyLines))
      return json(null, 404)
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

function renderApp(path = '/?source=api') {
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

const bar = (start: number) => screen.findByRole('button', { name: new RegExp(`Jump to ${fmtClock(start)}$`) })
const searches = () => calls.filter((c) => c.startsWith('/api/search?'))

describe('StreamHistogram', () => {
  it('bars with lines are buttons that jump; empty minutes are not; the jumped-to bar is marked', async () => {
    const onJump = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <StreamHistogram buckets={stats.histogram} since={SINCE} width={M} levels={[]} onJump={onJump} />,
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    const old = screen.getByRole('button', { name: new RegExp(`Jump to ${fmtClock(oldStart)}$`) })
    expect(old).toHaveAttribute('title', expect.stringContaining('click to jump'))
    expect(old).toHaveAccessibleName(expect.stringContaining('1 errors'))
    expect(old.className).toContain('cursor-pointer')

    await user.click(old)
    expect(onJump).toHaveBeenLastCalledWith({ from: oldStart, to: oldStart + M })
    // Keyboard: focus + Enter, and the page's own Enter shortcut never sees it.
    const page = vi.fn()
    window.addEventListener('keydown', page)
    old.focus()
    await user.keyboard('{Enter}')
    expect(onJump).toHaveBeenCalledTimes(2)
    expect(page).not.toHaveBeenCalled()
    window.removeEventListener('keydown', page)

    rerender(
      <StreamHistogram
        buckets={stats.histogram}
        since={SINCE}
        width={M}
        levels={[]}
        onJump={onJump}
        selected={oldStart}
      />,
    )
    expect(old).toHaveAttribute('aria-pressed', 'true')
    // Only the levels that are on count: with errors only, the info-only bars have nothing to jump to.
    rerender(<StreamHistogram buckets={stats.histogram} since={SINCE} width={M} levels={['error']} onJump={onJump} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('without onJump the bars stay plain', () => {
    render(<StreamHistogram buckets={stats.histogram} since={SINCE} width={M} levels={[]} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('stream: click the histogram to jump', () => {
  it('a minute outside the buffer: pauses, loads it from history with the filters, tints it; back to live drops it', async () => {
    const user = userEvent.setup()
    renderApp('/?source=api&level=info,error&q=svc:api')
    await screen.findByText('current minute line', {}, { timeout: 5000 })
    await user.click(await bar(oldStart))

    await waitFor(() => expect(searches()).toHaveLength(1))
    const q = new URL(searches()[0], 'http://x').searchParams
    expect(q.get('source')).toBe('api')
    expect(q.get('levels')).toBe('info,error')
    expect(q.get('q')).toBe('svc:api')
    expect(q.get('order')).toBe('oldest')
    expect(q.get('since')).toBe(String(oldStart))
    // Up to the oldest buffered line, so history and buffer meet.
    expect(q.get('until')).toBe(String(backlog[0].ts))

    const old = await screen.findByText('old minute line')
    const row = old.closest('[role="row"]') as HTMLElement
    await waitFor(() => expect(row).toHaveAttribute('data-flash', 'true'))
    // History sits above the buffer.
    const ids = [...document.querySelectorAll('[data-line-id]')].map((e) => Number(e.getAttribute('data-line-id')))
    expect(ids).toEqual([3, 4, 10, 11])
    expect(await bar(oldStart)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('stream-footer')).toHaveTextContent(`paused · at ${fmtClock(oldStart)}`)

    // The tint fades.
    await waitFor(() => expect(row).not.toHaveAttribute('data-flash'), { timeout: 3000 })

    // Back to live: history and the marked bar go.
    await user.click(screen.getByRole('button', { name: /Jump to latest|new line/ }))
    await waitFor(() => expect(screen.queryByText('old minute line')).not.toBeInTheDocument())
    expect(await bar(oldStart)).toHaveAttribute('aria-pressed', 'false')
  })

  it('a minute already in the buffer: no request, just scroll and tint', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('current minute line', {}, { timeout: 5000 })
    fireEvent.click(await bar(newStart))
    const row = screen.getByText('current minute line').closest('[role="row"]') as HTMLElement
    await waitFor(() => expect(row).toHaveAttribute('data-flash', 'true'))
    expect(screen.getByText('previous minute line').closest('[role="row"]')).not.toHaveAttribute('data-flash')
    expect(searches()).toHaveLength(0)
    expect(screen.getByTestId('stream-footer')).toHaveTextContent('paused')
    // G resumes live.
    await user.keyboard('G')
    await waitFor(() => expect(screen.getByTestId('stream-footer')).not.toHaveTextContent('paused'))
  })
})
