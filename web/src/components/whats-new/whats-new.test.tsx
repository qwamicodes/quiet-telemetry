import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormatReport, Health, SourceInfo, WhatsNew } from '@/gen'
import { upgradePrompt } from '@/lib/log-format'
import { CHANGES, markerFor, RELEASE } from '@/lib/whats-new'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { seedAuth } from '@/test/auth'

const NOW = Date.now()
const H = 3_600_000
const src = (name: string, over: Partial<SourceInfo> = {}): SourceInfo => ({
  name,
  kind: 'http',
  containers: [],
  group: null,
  group_kind: null,
  lines: 100,
  last_ts: NOW,
  display_name: null,
  hidden: false,
  paused: false,
  ...over,
})
const health: Health = {
  ok: true,
  version: '0.1.1',
  started: 0,
  docker: { state: 'disabled' },
  store: 'sqlite',
  retention_ms: 24 * H,
  disk_bytes: 0,
  stored_lines: 200,
  oldest: NOW - H,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const report: FormatReport = {
  source: 'legacy-api',
  sample: 200,
  old: 150,
  new: 50,
  other: 0,
  tag: 'v0.1.0',
  last_old: NOW - 60_000,
  last_new: NOW - 1000,
  changes: [
    { id: 'outcome', from: 'outcome', to: 'level + status_code, error when it failed', count: 150, old_format: true },
    { id: 'status', from: 'status', to: 'status_code', count: 120, old_format: true },
    {
      id: 'job_scope',
      from: 'job_id without queue',
      to: "the queue's own job_id + queue + attempt",
      count: 4,
      old_format: false,
    },
  ],
  rollout: [
    { start: NOW - 2 * H, old: 100, new: 0 },
    { start: NOW - H, old: 50, new: 50 },
  ],
  now: NOW,
}
let state: WhatsNew
let puts: unknown[] = []

beforeEach(() => {
  state = { release: RELEASE, eligible: true, since: NOW - H, seen: [], banner_dismissed: false }
  puts = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url.startsWith('/api/health')) return json(health)
      if (url === '/api/sources')
        return json({ sources: [src('legacy-api', { format: 'v0.1.0' }), src('api', { format: 'v0.1.1' })] })
      if (url === '/api/sources/legacy-api/format') return json(report)
      if (url === '/api/whats-new') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { seen?: string[]; banner_dismissed?: boolean }
          puts.push(body)
          state = {
            ...state,
            seen: [...state.seen, ...(body.seen ?? [])],
            banner_dismissed: body.banner_dismissed ?? state.banner_dismissed,
          }
        }
        return json(state)
      }
      return json({})
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

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

describe('markers (v0.1.1-00.4)', () => {
  it('own change first, then roll-up as updated, nothing once seen', () => {
    // 00.1: Guide and its changed tabs; a tab's own updated wins over new parts under it.
    expect(markerFor('guide.agent', CHANGES)).toBe('updated')
    expect(markerFor('guide.canonical', CHANGES)).toBe('updated')
    expect(markerFor('guide.check', CHANGES)).toBe('updated')
    expect(markerFor('guide.ids', CHANGES)).toBeNull()
    expect(markerFor('guide', CHANGES)).toBe('updated')
    expect(markerFor('settings', CHANGES)).toBeNull()
    expect(markerFor('search', CHANGES)).toBeNull()
    expect(markerFor('guide.agent.templates', CHANGES)).toBe('new')
    expect(
      markerFor(
        'guide',
        CHANGES.filter((c) => !c.target.startsWith('guide')),
      ),
    ).toBeNull()
  })
})

describe('upgrade prompt (00.3)', () => {
  it('lists only the changes this source still needs, with counts', () => {
    const p = upgradePrompt('legacy-api', report)
    expect(p).toContain("Update legacy-api's existing logging to the quiet v0.1.1 format.")
    expect(p).toContain('1. Drop outcome; set level from the error.')
    expect(p).toContain('2. status → status_code, a number.')
    expect(p).not.toContain('wideEvents')
  })
})

describe("What's new", () => {
  it('banner, version-chip dot, sheet and Mark all as seen', { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    renderAt('/guide')
    const banner = await screen.findByRole('region', { name: "What's new" }, { timeout: 15_000 })
    expect(banner).toHaveTextContent('quiet is now v0.1.1 · the logging guide changed')
    expect(banner).toHaveTextContent('1 source still uses the v0.1.0 format.')
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' })
    expect(within(sidebar).getByRole('button', { name: /9 unseen changes/ })).toBeInTheDocument()
    expect(within(sidebar).getByText('· v0.1.0')).toBeInTheDocument()
    // Guide rolls up its changed tabs; nothing else in the nav is marked (00.1).
    expect(within(sidebar).getByRole('link', { name: /Guide/ })).toHaveTextContent('updated in v0.1.1')
    expect(within(sidebar).getByRole('link', { name: /Settings/ })).not.toHaveTextContent('updated')

    await user.click(within(banner).getByRole('button', { name: 'What changed' }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByRole('heading', { name: "What's new in v0.1.1" })).toBeInTheDocument()
    expect(within(sheet).getByText('Changes to your logs')).toBeInTheDocument()
    expect(within(sheet).getByText('1 source still logs in the v0.1.0 format')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Upgrade legacy-api' })).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Mark all as seen' }))
    await waitFor(() => expect(puts).toContainEqual({ seen: CHANGES.map((c) => c.id) }))
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(within(sidebar).getByRole('button', { name: /^v0\.1\.1 · What's new$/ })).toBeInTheDocument(),
    )
  })

  it('dismissing the banner is kept per account', { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    renderAt('/guide')
    const banner = await screen.findByRole('region', { name: "What's new" }, { timeout: 15_000 })
    await user.click(within(banner).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(puts).toContainEqual({ banner_dismissed: true }))
    await waitFor(() => expect(screen.queryByRole('region', { name: "What's new" })).not.toBeInTheDocument())
  })

  it('accounts made after the upgrade see no markers', { timeout: 20_000 }, async () => {
    state = { ...state, eligible: false }
    renderAt('/guide')
    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' }, { timeout: 15_000 })
    await waitFor(() =>
      expect(within(sidebar).getByRole('button', { name: /^v0\.1\.1 · What's new$/ })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('region', { name: "What's new" })).not.toBeInTheDocument()
    expect(within(sidebar).queryByText('updated')).not.toBeInTheDocument()
  })
})

describe('upgrade a v0.1.0 source (00.3)', () => {
  it('field map with counts, changes-only prompt and rollout', { timeout: 20_000 }, async () => {
    renderAt('/sources/legacy-api/upgrade')
    const map = await screen.findByRole('region', { name: 'Field map' }, { timeout: 15_000 })
    expect(screen.getByRole('heading', { name: 'Upgrade legacy-api to v0.1.1' })).toBeInTheDocument()
    expect(screen.getByText('v0.1.0 format')).toBeInTheDocument()
    expect(screen.getByText(/200 received records · checked .* · 150 use v0.1.0 fields/)).toBeInTheDocument()
    const rows = within(map).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('"outcome": "failed"')
    expect(rows[1]).toHaveTextContent('150')
    expect(rows[3]).toHaveTextContent('Advice')
    const agent = screen.getByRole('region', { name: 'Upgrade with your agent' })
    expect(within(agent).getByRole('button', { name: 'Copy upgrade prompt' })).toBeInTheDocument()
    expect(agent).toHaveTextContent('change only what each event contains')
    expect(screen.getByRole('region', { name: 'Rollout' })).toHaveTextContent('50 of 200 records use v0.1.1')
  })
})
