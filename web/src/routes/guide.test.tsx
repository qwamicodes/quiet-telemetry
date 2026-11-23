import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, LintReport, SettingsResponse, SourceInfo } from '@/gen'
import { BASE_PROMPT, PACKS, promptFor, promptSections, SETUP_DEFAULTS, STACKS } from '@/lib/guide'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { owner, seedAuth } from '@/test/auth'

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

const settings: SettingsResponse = {
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

const report = (src: string): LintReport => ({
  source: src,
  sampled: 420,
  passed: 2,
  applicable: 3,
  checks: [
    {
      id: 'json',
      title: 'JSON lines',
      status: 'pass',
      share: 1,
      detail: '420 of 420 records parse',
      fix: '',
      failing: [],
    },
    {
      id: 'canonical',
      title: 'One completion event per request',
      status: 'fail',
      share: 0.2,
      detail: '12 of 60 requests · 31 with more than one',
      fix: 'Let middleware build one event per request and emit it once when the response completes.',
      failing: [],
    },
    { id: 'level', title: 'level', status: 'pass', share: 1, detail: '420 of 420 records', fix: '', failing: [] },
    {
      id: 'job_id',
      title: 'job_id on job records',
      status: 'na',
      share: null,
      detail: 'no job records in the sample',
      fix: '',
      failing: [],
    },
    {
      id: 'error_object',
      title: 'Typed error fields',
      status: 'fail',
      share: 0.12,
      detail: '1568 errors are strings or stringified JSON · 214 of 1782 typed',
      fix: 'Make `error` an object.',
      failing: [
        {
          line_id: 7,
          ts: 1_792_000_000_000,
          note: 'error is a string',
          excerpt: '{"level":"error","error":"paystack timed out","authorization":"[REDACTED]"}',
        },
      ],
    },
    {
      id: 'secrets',
      title: 'Sensitive-value scan',
      status: 'review',
      share: null,
      detail: 'no patterns found; this is not a privacy guarantee',
      fix: '',
      failing: [],
    },
  ],
})

let sources: SourceInfo[]
let lintCalls: string[]

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    queueMicrotask(() => {
      this.onopen?.()
      this.onmessage?.({ data: JSON.stringify({ type: 'backlog', lines: [] }) })
    })
  }
  close() {}
}

beforeEach(() => {
  sources = [source('legivent-api'), source('order-worker')]
  lintCalls = []
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url === '/api/sources') return json({ sources })
      if (url === '/api/settings') return json(settings)
      const m = url.match(/^\/api\/sources\/([^/]+)\/lint/)
      if (m) {
        const name = decodeURIComponent(m[1])
        lintCalls.push(name)
        return json(report(name))
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
  seedAuth(client, owner)
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }), client)
  render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return { router }
}

describe('agent prompt', () => {
  it('the copies in src/guide match docs/', () => {
    for (const f of ['agent-logging-prompt.md', 'logging-product-templates.md']) {
      const docs = readFileSync(resolve(__dirname, `../../../docs/${f}`), 'utf8')
      const copy = readFileSync(resolve(__dirname, `../guide/${f}`), 'utf8')
      expect(copy).toBe(docs)
    }
    expect(BASE_PROMPT.startsWith('You are adding canonical logging')).toBe(true)
  })

  it('puts the stack notes right before Done when, for every stack', () => {
    for (const s of STACKS) {
      const text = promptFor(s.id, SETUP_DEFAULTS)
      const titles = promptSections(text).map((x) => x.title)
      expect(titles[0]).toBe('Reviewed inputs')
      expect(titles.slice(-2)).toEqual([`Stack notes (${s.label})`, 'Done when'])
      expect(text).toContain(BASE_PROMPT.slice(0, 200))
      for (const n of s.notes) expect(text).toContain(n)
    }
    expect(promptFor('node', SETUP_DEFAULTS)).not.toContain('TypeScript · Elysia')
  })

  it('reviewed inputs carry the setup; goals make sampling goal-aware', () => {
    const plain = promptFor('bun', SETUP_DEFAULTS)
    expect(plain).toContain('Goals: none configured. Do not invent targets')
    expect(plain).toContain('Ordinary-completion sample rate: 100% (keep every event)')
    expect(plain).toContain("Adapt Boris Tane's") // the paragraph after the inputs survives
    expect(plain).toContain('Always keep recorded errors')

    const pack = PACKS.find((p) => p.name === 'Event ticketing')
    expect(PACKS).toHaveLength(20)
    expect(pack?.goals.map((g) => g.key)).toEqual(['tickets-checkout', 'tickets-ready', 'tickets-checkin'])
    const text = promptFor('bun', {
      ...SETUP_DEFAULTS,
      app: 'legivent-api / production',
      sample: 10,
      alsoHide: 'payment.card_number, customer.pin',
      goals: [
        {
          id: 'a',
          key: 'orders-fast',
          name: 'Orders finish quickly',
          appliesTo: 'Order requests',
          scope: 'legivent-api · POST /api/v1/orders',
          kind: 'request',
          matters: 'speed_success',
          op: 'under',
          limit: 500,
          unit: 'ms',
          target: 99.9,
          period: 30,
          timing: '',
          rules: '',
          exclusions: '',
        },
      ],
    })
    expect(text).toContain('Language/framework: TypeScript / Elysia; detect installed version')
    expect(text).toContain('Service/environment: legivent-api / production')
    expect(text).toContain('Goal 1 — orders-fast — Orders finish quickly')
    expect(text).toContain('Good: completed response, status <400, no recorded error, duration <500 ms')
    expect(text).toContain('Target: 99.9% over rolling 30 days')
    expect(text).toContain(
      'Redact: passwords, tokens, API keys, authorization, cookies and any configured fields; payment.card_number, customer.pin',
    )
    expect(text).toContain('Keep the rest at 10%.')
    expect(text).not.toContain('Always keep recorded errors')
  })
})

describe('Guide (11.x)', () => {
  it('the sidebar opens the overview with the four steps and quick links', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/settings')
    await user.click(await screen.findByRole('link', { name: 'Guide' }))
    expect(await screen.findByRole('heading', { name: 'How to use quiet' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/guide')
    for (const t of ['Connect a source', 'Watch the stream', 'Open a line as a flow', 'Read the field card'])
      expect(screen.getByRole('region', { name: t })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Instruct your agent' })).toHaveTextContent('recommended')
    expect(screen.getByRole('link', { name: /Check my logs.*checks for one source/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open a sample flow/ })).toBeInTheDocument()
  })

  it('Copy prompt copies the full prompt with the default Node · pino notes and says so', async () => {
    const user = userEvent.setup()
    renderAt('/guide')
    const header = await screen.findByRole('heading', { name: 'How to use quiet' })
    await user.click(within(header.closest('header') as HTMLElement).getByRole('button', { name: 'Copy prompt' }))
    const text = await navigator.clipboard.readText()
    expect(text).toBe(promptFor('node'))
    expect(text).toContain('## Stack notes (Node · pino)')
    expect(await screen.findByText('Prompt copied')).toBeInTheDocument()
    expect(screen.getByText('Node · pino notes included')).toBeInTheDocument()
  })

  it('⌘⇧C copies the prompt from anywhere; plain ⌘C is left alone', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    await screen.findByRole('link', { name: 'Guide' })
    await navigator.clipboard.writeText('untouched')
    await user.keyboard('{Meta>}c{/Meta}')
    expect(await navigator.clipboard.readText()).toBe('untouched')
    await user.keyboard('{Meta>}{Shift>}C{/Shift}{/Meta}')
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(promptFor('node')))
  })

  it('G H opens the guide and G L opens Check my logs', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/sources')
    await screen.findByRole('link', { name: 'Guide' })
    await user.keyboard('gh')
    await waitFor(() => expect(router.state.location.pathname).toBe('/guide'))
    await user.keyboard('gl')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'check' }))
    expect(await screen.findByRole('heading', { name: 'Verify your logs' })).toBeInTheDocument()
  })

  it('setup: app details, a custom goal, language; review shows them in the prompt', async () => {
    const user = userEvent.setup()
    renderAt('/guide?tab=agent')
    expect(await screen.findByRole('heading', { name: 'Set up your logging prompt' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('App / environment'), 'legivent-api / production')
    await user.click(screen.getByRole('button', { name: 'Add goal' }))
    await user.type(screen.getByLabelText('Goal name'), 'Orders finish quickly')
    await user.type(screen.getByLabelText('Applies to'), 'Order requests')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('Order requests · 99.9% under 500 ms · last 30 days')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Routine logs'), '10')
    await user.click(screen.getAllByRole('radio', { name: 'TypeScript · Elysia' })[0])
    expect(localStorage.getItem('quiet.guide.stack')).toBe('bun')

    await user.click(screen.getByRole('button', { name: /Review prompt/ }))
    expect(await screen.findByRole('heading', { name: 'Review your logging prompt' })).toBeInTheDocument()
    const prompt = screen.getByTestId('prompt-text')
    expect(prompt).toHaveTextContent('Goal 1 — orders-finish-quickly — Orders finish quickly')
    expect(prompt).toHaveTextContent('Service/environment: legivent-api / production')
    expect(prompt).toHaveTextContent('## Stack notes (TypeScript · Elysia)')
    const index = screen.getByRole('region', { name: 'In this prompt' })
    expect(within(index).getByRole('link', { name: /Sampling · your SLOs/ })).toBeInTheDocument()
    expect(within(index).queryByRole('link', { name: /Reviewed inputs/ })).toBeNull()
    expect(screen.getByRole('region', { name: 'Your goals' })).toHaveTextContent('1 included')

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await navigator.clipboard.readText()).toBe(promptFor('bun'))
    expect(await screen.findByText('TypeScript · Elysia notes and your SLOs included')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply in your repo/ })).toHaveAttribute('aria-current', 'step')
  })

  it('templates: search, empty state, add a pack with Undo; no project blocks adding', async () => {
    const user = userEvent.setup()
    renderAt('/guide?tab=agent')
    await user.click((await screen.findAllByRole('button', { name: 'Browse templates' }))[0])
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('1–3 of 20 products')).toBeInTheDocument()
    await user.type(within(drawer).getByLabelText('Search products'), 'weather')
    expect(within(drawer).getByText('No product templates match “weather”')).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'Clear search' }))
    await user.selectOptions(within(drawer).getByLabelText('Product type'), 'Event ticketing')
    expect(within(drawer).getByRole('tab', { name: /Recommended 1/ })).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'View goals: Event ticketing' }))
    expect(within(drawer).getByText('Choose a project first')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Add 3 goals' })).toBeDisabled()
    await user.selectOptions(within(drawer).getByLabelText('Project'), 'legivent-api')
    await user.click(within(drawer).getByRole('checkbox', { name: /Check-in stays fast/ }))
    expect(within(drawer).getByText('2 selected')).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'Add 2 goals' }))

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('2 Event ticketing goals were added')
    expect(screen.getByText(/Checkout feels fast/)).toBeInTheDocument()
    await user.click(within(banner).getByRole('button', { name: 'Undo' }))
    expect(screen.queryByText(/Checkout feels fast/)).toBeNull()
  })

  it('Check my logs (Verify your logs): table, badges, fix prompt and source select', async () => {
    const user = userEvent.setup()
    renderAt('/guide?tab=check')
    expect(await screen.findByRole('heading', { name: 'Verify your logs' })).toBeInTheDocument()
    await screen.findByText('5 checks')
    expect(lintCalls).toContain('legivent-api')
    const checks = screen.getByRole('region', { name: 'Checks' })
    // n/a rows are left out.
    expect(within(checks).getAllByRole('row')).toHaveLength(6)
    expect(checks).toHaveTextContent('12 of 60 requests · 31 with more than one')
    expect(checks).toHaveTextContent('→ Emit one completion event per request')
    expect(checks).toHaveTextContent('→ Preserve typed error reason and details')
    expect(checks).not.toHaveTextContent('n/a')
    expect(screen.getAllByText('12%').length).toBeGreaterThan(0)
    expect(screen.getByText('214 of 1782 typed')).toBeInTheDocument()
    const fix = screen.getByTestId('fix-prompt')
    expect(fix).toHaveTextContent('Review legivent-api using the existing logger.')
    expect(fix).toHaveTextContent('2. Normalize error strings to message')
    await user.click(screen.getByRole('button', { name: 'Copy fix prompt' }))
    expect(await navigator.clipboard.readText()).toContain('Review legivent-api')

    // 11.6 Failing fields · excerpt: the server's sanitized records.
    const failing = screen.getByRole('region', { name: 'Failing fields' })
    expect(failing).toHaveTextContent('error is a string')
    expect(failing).toHaveTextContent('line 7')
    expect(failing).toHaveTextContent('"authorization":"[REDACTED]"')

    await user.selectOptions(screen.getByLabelText('Source to check'), 'order-worker')
    await waitFor(() => expect(lintCalls).toContain('order-worker'))
    expect(await screen.findByText(/newest records · order-worker/)).toBeInTheDocument()
  })

  it('event examples and ids & flows follow the v0.1.1 contract', async () => {
    const user = userEvent.setup()
    renderAt('/guide?tab=canonical')
    expect(await screen.findByRole('heading', { name: 'Event examples' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'How each case is logged' })).toHaveTextContent(
      'Queue cancellation / timeout',
    )
    expect(screen.getByRole('region', { name: "Don't" })).toHaveTextContent('error.message holding stringified JSON')
    await user.click(screen.getByRole('link', { name: 'Ids & flows' }))
    expect(await screen.findByRole('region', { name: 'Preserve native ids and their scope' })).toBeInTheDocument()
    expect(screen.queryByText(/globally unique/)).toBeNull()
    expect(screen.getAllByText('payout-88-1300').length).toBeGreaterThan(0)
  })

  it('the command palette opens the guide', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/sources')
    await user.click(await screen.findByRole('button', { name: /Jump to/ }))
    await user.click(await screen.findByRole('option', { name: /Open guide · The canonical line/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/guide'))
  })
})
