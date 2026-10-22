import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Flow, FlowNotFound, FlowResponse, FlowSummary, Health, LogLine, SourceInfo } from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const T = 1_760_000_000_000
const sources: SourceInfo[] = [
  {
    name: 'api',
    kind: 'docker',
    containers: [],
    group: null,
    group_kind: null,
    lines: 3,
    last_ts: T,
    display_name: null,
    hidden: false,
    paused: false,
  },
  {
    name: 'worker',
    kind: 'docker',
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
  retention_ms: 86_400_000,
  disk_bytes: 0,
  stored_lines: 0,
  oldest: null,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}

const mk = (id: number, source: string, ts: number, fields: Record<string, unknown>): LogLine => {
  const ids: LogLine['ids'] = []
  if (fields.request_id) ids.push({ key: 'request_id', value: String(fields.request_id) })
  if (fields.job_id) ids.push({ key: 'job_id', value: String(fields.job_id) })
  return {
    id,
    ts,
    received: ts,
    source,
    level: fields.level === 50 ? 'error' : fields.level === 40 ? 'warn' : 'info',
    display_id: ids[0] ?? null,
    ids,
    msg: String(fields.msg ?? ''),
    fields,
    raw: JSON.stringify(fields),
  }
}

const reqLine = mk(1, 'api', T + 120, {
  level: 30,
  method: 'POST',
  path: '/api/v1/payouts',
  status: 201,
  duration_ms: 120,
  request_id: 'req_1',
  msg: 'create_payout → 201',
})
const picked = mk(2, 'worker', T + 200, { level: 30, phase: 'picked_up', job_id: 'payout:1', request_id: 'req_1' })
const failed = mk(3, 'worker', T + 1_100, {
  level: 50,
  operation: 'settle',
  job_id: 'payout:1',
  attempt: 0,
  outcome: 'failed',
  duration_ms: 800,
  err: { code: 'TIMEOUT' },
})

const summary: FlowSummary = {
  key: '1',
  title: 'POST /api/v1/payouts',
  status: 'error',
  line_count: 3,
  steps: 4,
  sources: ['api', 'worker'],
  started: T,
  ended: T + 1_100,
  duration_ms: 1_100,
  retries: 0,
  errors: 1,
  warnings: 0,
  ids: [
    { key: 'request_id', value: 'req_1' },
    { key: 'job_id', value: 'payout:1' },
  ],
  stitched_by: ['request_id', 'job_id'],
  truncated: false,
}

const multi: Flow = {
  ...summary,
  opened: { key: 'request_id', value: 'req_1' },
  nodes: [
    {
      index: 0,
      line_id: 1,
      source: 'api',
      level: 'info',
      ts: T + 120,
      start: T,
      duration_ms: 120,
      offset_ms: 0,
      name: 'POST /api/v1/payouts',
      summary: '201',
      error: false,
      warn: false,
      attempt: null,
      span_id: null,
      parent: null,
      depth: 0,
      children: [{ name: 'db.insert', summary: '', at_ms: 5, duration_ms: 30, error: false }],
    },
    {
      index: 1,
      line_id: 2,
      source: 'worker',
      level: 'info',
      ts: T + 200,
      start: T + 200,
      duration_ms: null,
      offset_ms: 200,
      name: 'picked_up',
      summary: '',
      error: false,
      warn: false,
      attempt: null,
      span_id: null,
      parent: null,
      depth: 0,
      children: [],
    },
    {
      index: 2,
      line_id: 3,
      source: 'worker',
      level: 'error',
      ts: T + 1_100,
      start: T + 300,
      duration_ms: 800,
      offset_ms: 300,
      name: 'settle',
      summary: 'failed · TIMEOUT · attempt 0',
      error: true,
      warn: false,
      attempt: 0,
      span_id: null,
      parent: null,
      depth: 0,
      children: [],
    },
  ],
  edges: [
    { from: 0, to: 1, kind: 'handoff', via: { key: 'request_id', value: 'req_1' }, gap_ms: 200 },
    { from: 1, to: 2, kind: 'next', via: null, gap_ms: 100 },
  ],
  lines: [reqLine, picked, failed],
  missing_parent: null,
  partial: false,
  span_tree: false,
}

const lonely = mk(7, 'api', T, { level: 30, method: 'GET', path: '/api/v1/orders', status: 200, request_id: 'req_9' })
const one: Flow = {
  ...summary,
  key: '7',
  title: 'GET /api/v1/orders',
  status: 'ok',
  line_count: 1,
  steps: 1,
  sources: ['api'],
  errors: 0,
  ids: [{ key: 'request_id', value: 'req_9' }],
  stitched_by: ['request_id'],
  opened: { key: 'request_id', value: 'req_9' },
  nodes: [{ ...multi.nodes[0], line_id: 7, name: 'GET /api/v1/orders', children: [] }],
  edges: [],
  lines: [lonely],
  missing_parent: null,
  partial: false,
  span_tree: false,
}

// The same steps read as a span tree (OTLP traces): settle ran inside picked_up, inside the request.
const traced: Flow = {
  ...multi,
  span_tree: true,
  nodes: multi.nodes.map((n, i) => ({ ...n, source: 'api', span_id: `s${i}`, parent: i ? i - 1 : null, depth: i })),
  edges: [
    { from: 0, to: 1, kind: 'child', via: null, gap_ms: 200 },
    { from: 1, to: 2, kind: 'child', via: null, gap_ms: 100 },
  ],
}

const notFound: FlowNotFound = {
  error: 'no lines carry this id in the window',
  id: 'req_7c19e0',
  close: [{ key: 'request_id', value: 'req_7c19e6', msg: 'GET /api/v1/cases', ts: T, source: 'api' }],
  since: T - 86_400_000,
  until: T,
}

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    queueMicrotask(() => {
      this.onopen?.()
      // Fresh timestamps: the stream hides a backlog older than 5 min as "quiet" (08.5).
      const now = Date.now()
      const lines = [reqLine, failed].map((l, i) => ({ ...l, ts: now - 1_000 + i, received: now - 1_000 + i }))
      this.onmessage?.({ data: JSON.stringify({ type: 'backlog', lines }) })
    })
  }
  close() {}
}

let calls: string[] = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url.startsWith('/api/sources')) return json({ sources })
      if (url.startsWith('/api/flow-summaries')) {
        const { ids } = JSON.parse(String(init?.body)) as { ids: string[] }
        return json({ flows: ids.map((id) => ({ id, flow: id === 'req_1' || id === 'payout:1' ? summary : null })) })
      }
      if (url.startsWith('/api/flow?')) {
        const p = new URL(url, 'http://x').searchParams
        const ok = (flow: Flow): FlowResponse => ({ flow, since: T - 86_400_000, until: T, took_ms: 3 })
        if (p.get('id') === 'req_1' || p.get('id') === 'payout:1' || p.get('line') === '3') return json(ok(multi))
        if (p.get('id') === 'req_9' || p.get('line') === '7') return json(ok(one))
        if (p.get('id') === 'trace_1') return json(ok(traced))
        if (p.get('id') === 'req_gone') return json({ ...notFound, id: 'req_gone', close: [] }, 404)
        return json(notFound, 404)
      }
      if (url.startsWith('/api/search')) {
        return json({
          lines: [],
          next_cursor: null,
          total: 0,
          bytes: 0,
          histogram: null,
          searched: 0,
          took_ms: 1,
          since: T,
          until: T,
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

describe('flow route', () => {
  it('a trace reads as a span tree: child edges name the parent span', async () => {
    renderAt('/flow/trace_1')
    expect(await screen.findByText(/span tree/)).toBeInTheDocument()
    expect(screen.getByText('in POST /api/v1/payouts')).toBeInTheDocument()
    expect(screen.getByText('in picked_up')).toBeInTheDocument()
    const deepest = screen.getByRole('button', { name: 'Step settle' }).parentElement as HTMLElement
    expect(deepest.style.paddingLeft).toBe('32px')
  })

  it('shows the stitched steps, timeline and the field card of the failing step', async () => {
    renderAt('/flow/req_1')
    expect(await screen.findByRole('heading', { name: 'POST /api/v1/payouts' })).toBeInTheDocument()
    expect(screen.getByText('201 · failed')).toBeInTheDocument()
    expect(screen.getByText(/4 steps · 3 lines · 2 sources · 1.1s/)).toBeInTheDocument()
    expect(screen.getByText(/stitched by request_id → job_id/)).toBeInTheDocument()
    expect(calls).toContain('/api/flow?id=req_1')

    const timeline = screen.getByRole('region', { name: 'Timeline' })
    expect(within(timeline).getByText('db.insert')).toBeInTheDocument()
    const graph = screen.getByRole('region', { name: 'Flow steps' })
    expect(within(graph).getByText('request_id req_1')).toBeInTheDocument() // the handoff
    // No line picked: the card opens on the error.
    expect(within(graph).getByRole('button', { name: 'Step settle' })).toHaveAttribute('aria-pressed', 'true')
    const card = screen.getByRole('region', { name: 'Line details' })
    expect(within(card).getByText('3 / 3')).toBeInTheDocument()
    expect(within(card).getByText('TIMEOUT')).toBeInTheDocument()
    expect(within(card).getByRole('group', { name: 'error' })).toBeInTheDocument()
  })

  it('clicking a node opens its line in the card and puts it in the URL; j/k move', async () => {
    const user = userEvent.setup()
    const router = renderAt('/flow/req_1')
    const graph = await screen.findByRole('region', { name: 'Flow steps' })
    await user.click(within(graph).getByRole('button', { name: 'Step POST /api/v1/payouts' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ line: 1 }))
    const card = screen.getByRole('region', { name: 'Line details' })
    expect(within(card).getByText('1 / 3')).toBeInTheDocument()
    expect(within(card).getByText('/api/v1/payouts')).toBeInTheDocument()

    await user.keyboard('j')
    await waitFor(() => expect(router.state.location.search).toEqual({ line: 2 }))
    expect(within(screen.getByRole('region', { name: 'Line details' })).getByText('2 / 3')).toBeInTheDocument()

    // Pick a field, then filter by it: a search for that key:value.
    await user.click(
      within(screen.getByRole('region', { name: 'Line details' })).getByRole('button', { name: /phase/ }),
    )
    await user.click(screen.getByRole('button', { name: 'Filter by phase' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'))
    expect(router.state.location.search).toMatchObject({ q: 'phase:picked_up' })
  })

  it('a bad ?line= falls back to the default step; ?line= picks one', async () => {
    renderAt('/flow/req_1?line=abc')
    const graph = await screen.findByRole('region', { name: 'Flow steps' })
    expect(within(graph).getByRole('button', { name: 'Step settle' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('a one-node flow is just the card', async () => {
    renderAt('/flow/req_9')
    expect(await screen.findByText('A one-node flow is just the card')).toBeInTheDocument()
    expect(screen.getByText('200 · 1 line')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Flow steps' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Line details' })).toBeInTheDocument()
  })

  it('an unknown id says so and offers close matches', async () => {
    renderAt('/flow/req_7c19e0')
    expect(await screen.findByText('No lines with this id')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /req_7c19e6/ })).toHaveAttribute('href', '/flow/req_7c19e6')
    expect(screen.getByRole('button', { name: /Search all sources/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/search?'),
    )
    expect(screen.getByRole('link', { name: 'Settings → Storage' })).toHaveAttribute('href', '/settings/storage')
  })

  it('Export flow (05.6) exports every id of the flow over its whole span, gzip off', async () => {
    const user = userEvent.setup()
    renderAt('/flow/req_1')
    await screen.findByRole('heading', { name: 'POST /api/v1/payouts' })
    const header = screen.getAllByRole('banner')[0]
    const buttons = within(header)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(buttons.slice(-3)).toEqual(['Export flow', 'Copy flow JSON', 'Open in stream'])
    await user.click(screen.getByRole('button', { name: 'Export flow' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('Every line stitched into this flow, from both sources, in time order.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/whole flow/)).toBeInTheDocument()
    expect(within(dialog).getByText(/3 lines · 4 steps/)).toBeInTheDocument()
    expect(within(dialog).getByText('quiet-flow-req_1.ndjson')).toBeInTheDocument()
    const href = decodeURIComponent(within(dialog).getByRole('button', { name: 'Download' }).getAttribute('href') ?? '')
    expect(href).toContain('id=req_1,payout:1')
    expect(href).toContain(`since=${T}`)
    expect(href).toContain(`until=${T + 1_100}`)
    expect(href).not.toContain('gzip')
  })

  it('o opens the flow in the stream; esc goes back to the stream', async () => {
    const user = userEvent.setup()
    const router = renderAt('/flow/req_1')
    await screen.findByRole('heading', { name: 'POST /api/v1/payouts' })
    await user.keyboard('o')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(router.state.location.search).toMatchObject({ source: 'api', q: 'req_1' })

    await router.navigate({ to: '/flow/$id', params: { id: 'req_1' } })
    await screen.findByRole('heading', { name: 'POST /api/v1/payouts' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('a one-node flow card can open its line in the stream', async () => {
    const user = userEvent.setup()
    const router = renderAt('/flow/req_9')
    await screen.findByText('A one-node flow is just the card')
    const card = screen.getByRole('region', { name: 'Line details' })
    await user.click(within(card).getByRole('button', { name: /Open in stream/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('an id with no close matches gets the 404 page (08.6)', async () => {
    renderAt('/flow/req_gone')
    expect(await screen.findByText('This flow is no longer in the window.')).toBeInTheDocument()
    expect(screen.getByText('Searchable window')).toBeInTheDocument()
    expect(screen.getByText('request_id, job_id, trace_id, correlation_id')).toBeInTheDocument()
    expect(screen.getByText(/all 2 · none paused/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to stream' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('button', { name: /Search 24h for req_gone/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/search?'),
    )
    expect(screen.getByRole('button', { name: 'Storage settings' })).toHaveAttribute('href', '/settings/storage')
  })

  it('/line/$lineId opens a line as its flow; a non-numeric line id is a broken link', async () => {
    renderAt('/line/3')
    expect(await screen.findByRole('heading', { name: 'POST /api/v1/payouts' })).toBeInTheDocument()
    expect(calls).toContain('/api/flow?line=3')
    const graph = screen.getByRole('region', { name: 'Flow steps' })
    expect(within(graph).getByRole('button', { name: 'Step settle' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('a broken line link never reaches the server', async () => {
    renderAt('/line/abc')
    expect(await screen.findByText('This flow link is broken')).toBeInTheDocument()
    expect(calls.some((c) => c.startsWith('/api/flow'))).toBe(false)
  })
})

describe('stream → flow', () => {
  it('shows each row’s flow steps and opens the selected line as a flow with Enter', async () => {
    const user = userEvent.setup()
    const router = renderAt('/?source=api')
    const row = await screen.findByText('create_payout', {}, { timeout: 5000 })
    // Steps column: one square per step, once the batched summaries land.
    await waitFor(() => expect(screen.getAllByTitle('4 steps · 3 lines').length).toBeGreaterThan(0), {
      timeout: 3000,
    })
    expect(calls.filter((c) => c === '/api/flow-summaries')).toHaveLength(1)
    expect(screen.getByText('120ms')).toBeInTheDocument() // duration column

    await user.click(row)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/flow/req_1'))
    expect(router.state.location.search).toEqual({ line: 1 })
  })
})
