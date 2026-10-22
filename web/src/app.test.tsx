import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, LogLine, SourceInfo } from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'

const sources: SourceInfo[] = [
  { name: 'api', kind: 'http', containers: [], group: null, lines: 2, last_ts: Date.now() },
  { name: 'worker', kind: 'docker', containers: ['proj-worker-1'], group: 'proj', lines: 0, last_ts: null },
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
}

const lines: LogLine[] = [
  {
    id: 1,
    ts: 1_760_000_000_000,
    received: 1_760_000_000_004,
    source: 'api',
    level: 'warn',
    display_id: { key: 'request_id', value: 'req_1' },
    ids: [{ key: 'request_id', value: 'req_1' }],
    msg: 'slow query',
    fields: { level: 40, msg: 'slow query', request_id: 'req_1', db: { ms: 812 } },
    raw: '{"level":40,"msg":"slow query","request_id":"req_1","db":{"ms":812}}',
  },
  {
    id: 2,
    ts: 1_760_000_000_100,
    received: 1_760_000_000_101,
    source: 'api',
    level: null,
    display_id: null,
    ids: [],
    msg: 'plain text line',
    raw: 'plain text line',
  },
]

class FakeSocket {
  static all: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.all.push(this)
    queueMicrotask(() => {
      this.onopen?.()
      this.onmessage?.({ data: JSON.stringify({ type: 'backlog', lines }) })
    })
  }
  close() {}
}

beforeEach(() => {
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.startsWith('/api/health') ? health : url.startsWith('/api/sources') ? { sources } : null
      return new Response(JSON.stringify(body), { status: body ? 200 : 404 })
    }),
  )
  // Give the virtualized list a viewport in jsdom.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderApp(path = '/?source=api') {
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }))
  render(
    <Providers client={makeQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return router
}

describe('stream page', () => {
  it('streams the source and opens the field card on click', async () => {
    const user = userEvent.setup()
    renderApp()
    const row = await screen.findByText('slow query')
    expect(FakeSocket.all[0].url).toContain('source=api')
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Live')

    await user.click(row)
    const card = await screen.findByRole('region', { name: 'Line details' })
    expect(within(card).getByText('db.ms')).toBeInTheDocument()
    expect(within(card).getByText('812')).toBeInTheDocument()

    await user.click(within(card).getByRole('tab', { name: 'Raw' }))
    expect(within(card).getByText(lines[0].raw)).toBeInTheDocument()

    // j moves to the next line; a text line has no Fields tab content.
    await user.keyboard('j')
    expect(within(card).getAllByText('plain text line').length).toBeGreaterThan(0)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Line details' })).not.toBeInTheDocument())
  })

  it('level toggle and text filter reconnect with server-side filters', async () => {
    const user = userEvent.setup()
    const router = renderApp()
    await screen.findByText('slow query')
    await user.click(screen.getByRole('button', { name: 'warn and above' }))
    await waitFor(() => expect(FakeSocket.all.at(-1)?.url).toContain('level=warn'))
    expect(router.state.location.search).toMatchObject({ source: 'api', level: 'warn' })

    await user.type(screen.getByRole('textbox', { name: 'Filter text' }), 'slow')
    await waitFor(() => expect(FakeSocket.all.at(-1)?.url).toContain('q=slow'))
  })
})

describe('popups (every Base UI popup the app uses opens without crashing)', () => {
  it('command palette (Dialog + cmdk) opens from ⌘K and from the sidebar, and jumps to a source', async () => {
    const user = userEvent.setup()
    const router = renderApp()
    await screen.findByText('slow query')

    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('worker')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Jump to/ }))
    const again = await screen.findByRole('dialog')
    await user.click(within(again).getByText('worker'))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ source: 'worker' }))

    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'req_123')
    await user.click(await screen.findByText('open flow'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/flow/req_123'))
    expect(await screen.findByText('Flows arrive in slice 3')).toBeInTheDocument()
  })

  it('tooltips open on hover', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('slow query')
    await user.hover(screen.getByRole('button', { name: 'error and above' }))
    expect(await screen.findByText('Errors only')).toBeInTheDocument()

    await user.click(screen.getByText('slow query'))
    await user.unhover(screen.getByRole('button', { name: 'error and above' }))
    await user.hover(screen.getByRole('button', { name: 'Copy raw line' }))
    expect(await screen.findByText('Copy raw line')).toBeInTheDocument()
  })

  it('stream export (Dialog + RadioGroup + Switch) opens from the top bar for this source', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('slow query')
    await user.click(screen.getByRole('button', { name: 'Export these lines' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Export lines')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'JSON array' }))
    await user.click(within(dialog).getByRole('switch', { name: 'Include raw line' }))
    const href = within(dialog).getByRole('button', { name: 'Download' }).getAttribute('href') ?? ''
    expect(href).toContain('source=api')
    expect(href).toContain('format=json')
    expect(href).toContain('raw=1')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('settings toggles the theme', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await user.click(await screen.findByRole('button', { name: 'Light' }))
    await waitFor(() => expect(document.documentElement).toHaveClass('light'))
    await user.click(screen.getByRole('button', { name: 'Dark' }))
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'))
  })
})
