import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreatedIngestToken, Health, IngestToken, SourceInfo } from '@/gen'
import { firstArrival, maskToken, snippets } from '@/lib/connect'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const SECRET = `qi_${'8d1f0c2e9b7a44e5a1c3f2b6d90e'.padEnd(48, '0')}1a77`
const health: Health = {
  ok: true,
  version: '0.1.0',
  started: 0,
  docker: { state: 'connected', containers: 9 },
  store: 'sqlite',
  retention_ms: 86_400_000,
  disk_bytes: 0,
  stored_lines: 0,
  oldest: null,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const token = (over: Partial<IngestToken> = {}): IngestToken => ({
  id: 1,
  name: 'vector',
  preview: 'qi_••••1a77',
  source: null,
  created: 1_760_000_000_000,
  last_used: null,
  revoked: null,
  ...over,
})

let sources: SourceInfo[] = []
let tokens: IngestToken[] = []
let posts: { url: string; body: unknown; method: string }[] = []

beforeEach(() => {
  sources = []
  tokens = []
  posts = []
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url.startsWith('/api/sources')) return json({ sources })
      if (url === '/api/ingest-tokens' && method === 'POST') {
        const body = JSON.parse(String(init?.body))
        posts.push({ url, body, method })
        const t = token({ id: tokens.length + 1, name: body.name, source: body.source ?? null })
        tokens = [t, ...tokens]
        return json({ token: t, secret: SECRET } satisfies CreatedIngestToken, 201)
      }
      if (url === '/api/ingest-tokens') return json({ tokens })
      const del = url.match(/^\/api\/ingest-tokens\/(\d+)$/)
      if (del && method === 'DELETE') {
        posts.push({ url, body: null, method })
        tokens = tokens.map((t) => (t.id === Number(del[1]) ? { ...t, revoked: Date.now() } : t))
        return json(tokens.find((t) => t.id === Number(del[1])))
      }
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
  return { router, client }
}

describe('connect a source', () => {
  it('first run shows the welcome tiles; a tile opens the connect panel for that kind', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/')
    // First render pays the lazy route chunk cost on a cold CI runner.
    expect(await screen.findByText('Nothing is sending lines yet.', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('Nothing connected yet')).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: /Fluent Bit/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/connect'))
    expect(router.state.location.search).toEqual({ kind: 'fluentbit' })
    expect(await screen.findByRole('region', { name: 'Connect Fluent Bit' })).toBeInTheDocument()
  })

  it('Vector: generates a token, fills the real URL + token into vector.toml, then goes live', async () => {
    const user = userEvent.setup()
    const { client } = renderAt('/connect?kind=vector')
    const panel = await screen.findByRole('region', { name: 'Connect Vector' })
    await user.click(within(panel).getByRole('button', { name: /Generate token/ }))

    // One token, scoped to any source (Vector names sources per event).
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toEqual({ name: 'vector' })

    // The snippet shows the token masked; Copy gets the real thing.
    const snippet = await within(panel).findByTestId('snippet')
    expect(snippet).toHaveTextContent(`uri = "${window.location.origin}/ingest/vector"`)
    expect(snippet).toHaveTextContent(`auth.token = "${maskToken(SECRET)}"`)
    expect(snippet.textContent).not.toContain(SECRET)
    await user.click(within(panel).getByRole('button', { name: 'Copy config' }))
    expect(await navigator.clipboard.readText()).toContain(`auth.token = "${SECRET}"`)
    await user.click(within(panel).getByRole('button', { name: /Reveal/ }))
    expect(within(panel).getByTestId('snippet')).toHaveTextContent(SECRET)

    // Loopback note: remote shippers need QUIET_ADDR.
    expect(within(panel).getByText(/QUIET_ADDR=0.0.0.0:7070/)).toBeInTheDocument()

    // Waiting… then the first line from a vector source arrives.
    expect(within(panel).getByText('waiting for the first line …')).toBeInTheDocument()
    sources = [
      {
        name: 'traefik',
        kind: 'vector',
        containers: [],
        group: null,
        group_kind: null,
        lines: 41,
        last_ts: Date.now(),
        display_name: null,
        hidden: false,
        paused: false,
      },
    ]
    await act(() => client.invalidateQueries({ queryKey: ['sources'] }))
    expect(await within(panel).findByText('traefik is connected')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /Open stream/ })).toHaveAttribute('href', '/?source=traefik')
  })

  it('File / stdin binds the token to the typed source; other sources growing do not count', async () => {
    const user = userEvent.setup()
    const { client } = renderAt('/connect?kind=file')
    const panel = await screen.findByRole('region', { name: 'Connect File / stdin' })
    const name = within(panel).getByRole('textbox', { name: 'Source name' })
    await user.clear(name)
    await user.type(name, 'cron-runner')
    await user.click(within(panel).getByRole('button', { name: /Generate token/ }))
    await waitFor(() => expect(posts[0]?.body).toEqual({ name: 'file / stdin · cron-runner', source: 'cron-runner' }))
    const snippet = await within(panel).findByTestId('snippet')
    expect(snippet).toHaveTextContent('X-Quiet-Source: cron-runner')
    expect(snippet).toHaveTextContent('quiet pipe --name cron-runner')

    sources = [
      {
        name: 'other',
        kind: 'http',
        containers: [],
        group: null,
        group_kind: null,
        lines: 5,
        last_ts: Date.now(),
        display_name: null,
        hidden: false,
        paused: false,
      },
    ]
    await act(() => client.invalidateQueries({ queryKey: ['sources'] }))
    expect(within(panel).queryByText(/is connected/)).not.toBeInTheDocument()
    sources = [
      ...sources,
      {
        name: 'cron-runner',
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
    await act(() => client.invalidateQueries({ queryKey: ['sources'] }))
    expect(await within(panel).findByText('cron-runner is connected')).toBeInTheDocument()
  })

  it('Docker needs no token: shows the socket state and waits right away', async () => {
    renderAt('/connect')
    const panel = await screen.findByRole('region', { name: 'Connect Docker' })
    expect(within(panel).getByTestId('snippet')).toHaveTextContent('/var/run/docker.sock:/var/run/docker.sock:ro')
    expect(await within(panel).findByText('readable · 9 containers')).toBeInTheDocument()
    expect(await within(panel).findByText('watching /var/run/docker.sock …')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /Generate token/ })).not.toBeInTheDocument()
  })
})

describe('ingest tokens settings', () => {
  it('creates a token (secret shown once), lists it, and revokes it after confirming', async () => {
    const user = userEvent.setup()
    tokens = [token({ id: 9, name: 'laptop stdin', preview: 'qi_••••0b4d', last_used: Date.now() - 60_000 })]
    renderAt('/settings/ingest-tokens')
    const section = await screen.findByRole('region', { name: 'Ingest tokens' })
    expect(await within(section).findByText('laptop stdin')).toBeInTheDocument()
    expect(within(section).getByText('1m ago')).toBeInTheDocument()

    // Create: name + one source (Dialog + RadioGroup open and work).
    await user.click(within(section).getByRole('button', { name: /Create token/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: 'Token name' }), 'fluent bit · cron')
    await user.click(within(dialog).getByRole('radio', { name: 'One source' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Source name' }), 'cron-runner')
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }))
    await waitFor(() => expect(posts[0]?.body).toEqual({ name: 'fluent bit · cron', source: 'cron-runner' }))
    expect(await within(section).findByTestId('new-secret')).toHaveTextContent(SECRET)
    expect(within(section).getByText(/won't be shown again/)).toBeInTheDocument()
    expect(await within(section).findByText('cron-runner')).toBeInTheDocument()

    // Revoke asks first.
    await user.click(within(section).getByRole('button', { name: 'Revoke laptop stdin' }))
    const confirm = await screen.findByRole('dialog')
    expect(confirm).toHaveTextContent('qi_••••0b4d')
    await user.click(within(confirm).getByRole('button', { name: 'Revoke token' }))
    await waitFor(() => expect(posts.some((p) => p.method === 'DELETE' && p.url === '/api/ingest-tokens/9')).toBe(true))
    expect(await within(section).findByText('revoked')).toBeInTheDocument()
  })
})

describe('sources page', () => {
  it('lists every source with its receiver kind, rate and last line', async () => {
    sources = [
      {
        name: 'legivent-api',
        kind: 'docker',
        containers: ['api.1'],
        group: 'legivent',
        group_kind: null,
        lines: 1200,
        last_ts: Date.now(),
        display_name: null,
        hidden: false,
        paused: false,
      },
      {
        name: 'cron-runner',
        kind: 'fluentbit',
        containers: [],
        group: null,
        group_kind: null,
        lines: 288,
        last_ts: Date.now() - 3 * 3_600_000,
        display_name: null,
        hidden: false,
        paused: false,
      },
      {
        name: 'payments-svc',
        kind: 'otlp',
        containers: [],
        group: null,
        group_kind: null,
        lines: 5,
        last_ts: Date.now(),
        display_name: null,
        hidden: false,
        paused: false,
      },
    ]
    const user = userEvent.setup()
    renderAt('/sources')
    const table = await screen.findByRole('table')
    const row = (name: string) => within(table).getByRole('link', { name }).closest('tr') as HTMLElement
    await within(table).findByRole('link', { name: 'cron-runner' })
    expect(within(row('cron-runner')).getByText('fluent bit')).toBeInTheDocument()
    expect(within(row('cron-runner')).getByText('3h ago')).toBeInTheDocument()
    expect(within(row('payments-svc')).getByText('otlp')).toBeInTheDocument()
    expect(within(row('legivent-api')).getByText('1.2k')).toBeInTheDocument()
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Idle 1' }))
    expect(within(table).queryByRole('link', { name: 'payments-svc' })).not.toBeInTheDocument()
  })
})

describe('snippets', () => {
  it('fills host/port/tls for Fluent Bit and the endpoint for OTLP', () => {
    const fb = snippets('fluentbit', {
      origin: 'https://quiet.legivent.com',
      token: SECRET,
      source: 'x',
      version: '0.1.0',
    })
    expect(fb[0].code).toContain('Host             quiet.legivent.com')
    expect(fb[0].code).toContain('Port             443')
    expect(fb[0].code).toContain('tls              On')
    expect(fb[0].code).toContain(`Header           Authorization Bearer ${SECRET}`)
    const local = snippets('fluentbit', {
      origin: 'http://127.0.0.1:7070',
      token: SECRET,
      source: 'x',
      version: '0.1.0',
    })
    expect(local[0].code).toContain('Port             7070')
    expect(local[0].code).not.toContain('tls')
    const otlp = snippets('otlp', {
      origin: 'http://127.0.0.1:7070',
      token: SECRET,
      source: 'payments-svc',
      version: '0.1.0',
    })
    expect(otlp.map((s) => s.file)).toEqual(['.env (SDK)', 'otel-collector.yaml'])
    expect(otlp[0].code).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:7070')
    expect(otlp[0].code).toContain('OTEL_SERVICE_NAME=payments-svc')
  })

  it('first arrival matches the name first, else the receiver kind', () => {
    const s = (name: string, kind: SourceInfo['kind'], lines: number): SourceInfo => ({
      name,
      kind,
      containers: [],
      group: null,
      group_kind: null,
      lines,
      last_ts: 1,
      display_name: null,
      hidden: false,
      paused: false,
    })
    const base = { api: 10 }
    expect(firstArrival('otlp', [s('api', 'otlp', 10), s('pay', 'otlp', 2)], base, 'svc')?.name).toBe('pay')
    expect(firstArrival('otlp', [s('svc', 'otlp', 1), s('pay', 'otlp', 2)], base, 'svc')?.name).toBe('svc')
    expect(firstArrival('vector', [s('api', 'otlp', 11)], base)).toBeNull()
    expect(firstArrival('file', [s('api', 'http', 11)], base, 'cron')).toBeNull()
  })
})
