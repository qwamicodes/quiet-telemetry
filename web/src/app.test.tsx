import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, LogLine, SourceInfo } from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const sources: SourceInfo[] = [
  {
    name: 'api',
    kind: 'http',
    containers: [],
    group: null,
    group_kind: null,
    lines: 2,
    last_ts: Date.now(),
    display_name: null,
    hidden: false,
    paused: false,
  },
  {
    name: 'worker',
    kind: 'docker',
    containers: ['proj-worker-1'],
    group: 'proj',
    group_kind: null,
    lines: 0,
    last_ts: null,
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

// Fresh timestamps: the stream hides a backlog older than 5 min as "quiet" (08.5).
const NOW = Date.now()
const lines: LogLine[] = [
  {
    id: 1,
    ts: NOW - 2_000,
    received: NOW - 1_996,
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
    ts: NOW - 1_900,
    received: NOW - 1_899,
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

describe('stream page', () => {
  it('streams the source and expands a row inline on click (03.5)', async () => {
    const user = userEvent.setup()
    renderApp()
    const row = await screen.findByText('slow query', {}, { timeout: 5000 })
    expect(FakeSocket.all[0].url).toContain('source=api')
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Live')

    await user.click(row)
    const preview = await screen.findByTestId('row-preview')
    expect(within(preview).getByText('request_id')).toBeInTheDocument()
    expect(within(preview).getByText('db')).toBeInTheDocument()
    expect(within(preview).getByRole('button', { name: /Open flow/ })).toBeInTheDocument()

    // j moves the open preview to the next line; a text line previews its raw text.
    await user.keyboard('j')
    await waitFor(() =>
      expect(within(screen.getByTestId('row-preview')).getByText('plain text line')).toBeInTheDocument(),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('row-preview')).not.toBeInTheDocument())
  })

  it('level chips and text filter reconnect with server-side filters', async () => {
    const user = userEvent.setup()
    const router = renderApp()
    await screen.findByText('slow query', {}, { timeout: 5000 })
    // Every chip is on (no filter); turning info off leaves debug, warn and error.
    await user.click(screen.getByRole('button', { name: 'info lines' }))
    await waitFor(() => expect(FakeSocket.all.at(-1)?.url).toContain('levels=debug%2Cwarn%2Cerror'))
    expect(router.state.location.search).toMatchObject({ source: 'api', level: 'debug,warn,error' })

    await user.type(screen.getByRole('textbox', { name: 'Filter text' }), 'slow')
    await waitFor(() => expect(FakeSocket.all.at(-1)?.url).toContain('q=slow'))
  })
})

describe('popups (every Base UI popup the app uses opens without crashing)', () => {
  it('command palette (Dialog + cmdk) opens from ⌘K and from the sidebar, and jumps to a source', async () => {
    const user = userEvent.setup()
    const router = renderApp()
    await screen.findByText('slow query', {}, { timeout: 5000 })

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
    // No line carries req_123 here (the mock 404s): the 404 flow page (08.6, no close matches).
    expect(await screen.findByText('This flow is no longer in the window.')).toBeInTheDocument()
  })

  it('tooltips open on hover', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('slow query', {}, { timeout: 5000 })
    await user.hover(screen.getByRole('button', { name: 'error lines' }))
    expect(await screen.findByText('Hide error lines · 4')).toBeInTheDocument()
    await user.unhover(screen.getByRole('button', { name: 'error lines' }))
    await user.hover(screen.getByRole('button', { name: 'Export these lines' }))
    expect(await screen.findAllByText('Export these lines')).not.toHaveLength(0)
  })

  it('stream export (Dialog + RadioGroup + Switch) opens from the top bar for this source', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('slow query', {}, { timeout: 5000 })
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

  it('settings → appearance toggles the theme', async () => {
    const user = userEvent.setup()
    renderApp('/settings/appearance')
    await user.click(await screen.findByRole('button', { name: 'Light' }))
    await waitFor(() => expect(document.documentElement).toHaveClass('light'))
    await user.click(screen.getByRole('button', { name: 'Dark' }))
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'))
  })
})
