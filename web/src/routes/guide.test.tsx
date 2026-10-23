import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, LintReport, SettingsResponse, SourceInfo } from '@/gen'
import { BASE_PROMPT, promptFor, promptSections, STACKS } from '@/lib/guide'
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
  docker: { state: 'connected', containers: 3 },
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
    { id: 'json', title: 'Lines are JSON', status: 'pass', share: 1, detail: '420 of 420 lines', fix: '' },
    {
      id: 'canonical',
      title: 'One canonical line per request',
      status: 'fail',
      share: 0.2,
      detail: '12 of 60 requests · 31 with more than one',
      fix: 'Write one line per request when it ends, with `status` and `duration_ms`.',
    },
    { id: 'level', title: 'Level on every line', status: 'pass', share: 1, detail: '420 of 420 JSON lines', fix: '' },
    {
      id: 'calls',
      title: 'wideEvents.calls are well formed',
      status: 'na',
      share: null,
      detail: 'no calls in the sample',
      fix: '',
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
  it('the copy in src/guide matches docs/agent-logging-prompt.md', () => {
    const docs = readFileSync(resolve(__dirname, '../../../docs/agent-logging-prompt.md'), 'utf8')
    const copy = readFileSync(resolve(__dirname, '../guide/agent-logging-prompt.md'), 'utf8')
    expect(copy).toBe(docs)
    expect(BASE_PROMPT.startsWith('You are adding canonical, wide-event logging')).toBe(true)
  })

  it('puts the stack notes right before Done when, for every stack', () => {
    for (const s of STACKS) {
      const text = promptFor(s.id)
      const titles = promptSections(text).map((x) => x.title)
      expect(titles.slice(-2)).toEqual([`Stack notes (${s.label})`, 'Done when'])
      expect(text).toContain(BASE_PROMPT.slice(0, 200))
      for (const n of s.notes) expect(text).toContain(n)
    }
    expect(promptFor('node')).not.toContain('Bun · Elysia')
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
    expect(screen.getByRole('link', { name: /Check my logs.*scorecard for one source/ })).toBeInTheDocument()
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
    expect(await screen.findByRole('heading', { name: 'Check my logs' })).toBeInTheDocument()
  })

  it('the agent tab switches stack notes, indexes sections and ticks the done list', async () => {
    const user = userEvent.setup()
    renderAt('/guide?tab=agent')
    expect(await screen.findByRole('heading', { name: 'Instrument your app with an agent' })).toBeInTheDocument()
    const prompt = screen.getByTestId('prompt-text')
    expect(prompt).toHaveTextContent('## Stack notes (Node · pino)')
    expect(screen.getByRole('radio', { name: 'Node · pino' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Bun · Elysia' }))
    expect(prompt).toHaveTextContent('## Stack notes (Bun · Elysia)')
    expect(prompt).toHaveTextContent('`onAfterResponse` writes the one canonical line')
    expect(localStorage.getItem('quiet.guide.stack')).toBe('bun')
    const index = screen.getByRole('region', { name: 'In this prompt' })
    expect(within(index).getByRole('link', { name: /Stack notes \(Bun · Elysia\)/ })).toBeInTheDocument()
    expect(within(index).getByRole('link', { name: /Done when/ })).toBeInTheDocument()

    const done = screen.getByRole('region', { name: 'Done looks like' })
    const box = within(done).getByRole('checkbox', { name: /A thrown error still logs the line/ })
    await user.click(box)
    expect(box).toBeChecked()

    // The copied prompt follows the picked stack.
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await navigator.clipboard.readText()).toBe(promptFor('bun'))
  })

  it('Check my logs scores the first source and switches sources', async () => {
    const user = userEvent.setup()
    renderAt('/guide?tab=check')
    expect(await screen.findByText('2 / 3 checks pass')).toBeInTheDocument()
    expect(lintCalls).toContain('legivent-api')
    const checks = screen.getByRole('list', { name: 'Checks' })
    expect(within(checks).getAllByRole('listitem')).toHaveLength(4)
    expect(checks).toHaveTextContent('12 of 60 requests · 31 with more than one')
    expect(checks).toHaveTextContent('Write one line per request when it ends')
    expect(checks).toHaveTextContent('n/a')
    expect(screen.getByText(/1 check needs work/)).toBeInTheDocument()

    await user.click(
      within(screen.getByRole('navigation', { name: 'Source to check' })).getByRole('link', { name: /order-worker/ }),
    )
    await waitFor(() => expect(lintCalls).toContain('order-worker'))
    expect(await screen.findByText(/newest 420 lines of order-worker/)).toBeInTheDocument()
  })

  it('the command palette opens the guide', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/sources')
    await user.click(await screen.findByRole('button', { name: /Jump to/ }))
    await user.click(await screen.findByRole('option', { name: /Guide · how to use quiet/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/guide'))
  })
})
