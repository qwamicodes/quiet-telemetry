import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomGroup, GroupMode, Health, SettingsResponse, SourceInfo } from '@/gen'
import { resetCollapsedGroups } from '@/lib/source-groups'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { member, seedAuth } from '@/test/auth'

const H = 3_600_000
const NOW = Date.now()
const src = (name: string, over: Partial<SourceInfo> = {}): SourceInfo => ({
  name,
  kind: 'docker',
  containers: [],
  group: 'Standalone',
  group_kind: 'standalone',
  lines: 1000,
  last_ts: NOW,
  display_name: null,
  hidden: false,
  paused: false,
  ...over,
})
const staging = {
  group: 'Legivent staging',
  group_kind: 'manual',
  group_id: 'g_1',
  auto_group: 'Standalone',
  auto_group_kind: 'standalone',
} as const
const apps = { group: 'thelegiventos-applications', group_kind: 'compose' } as const
const grouped = [
  src('staging-api', staging),
  src('staging-bot', staging),
  src('api', apps),
  src('bot', apps),
  src('dokploy'),
  src('traefik', { kind: 'vector', group: 'Ingest', group_kind: 'ingest' }),
]
const custom: CustomGroup[] = [
  { id: 'g_1', name: 'Legivent staging', order: 0 },
  { id: 'g_2', name: 'Edge', order: 1 },
]
const health: Health = {
  ok: true,
  version: '0.1.0',
  started: 0,
  docker: { state: 'connected', containers: 5 },
  store: 'sqlite',
  retention_ms: 24 * H,
  disk_bytes: 0,
  stored_lines: 3000,
  oldest: NOW - H,
  ingest: { auth: 'token', loopback: true, max_body: 16_000_000, rate: 20_000, tokens: 0 },
}
const settings = (mode: GroupMode): SettingsResponse => ({
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
  grouping: { mode, label: 'quiet.group', origin: 'default', locked: false },
  flow_ids: { order: ['request_id', 'job_id', 'trace_id', 'correlation_id'], match_by: 'value' },
  sources: {},
})

let calls: { url: string; method: string; body: unknown }[] = []
let sources = grouped
let mode: GroupMode = 'auto'
const all = () => ({ groups: custom, assigned: { 'staging-api': 'g_1', 'staging-bot': 'g_1' } })

beforeEach(() => {
  calls = []
  sources = grouped
  mode = 'auto'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (method !== 'GET') calls.push({ url, method, body })
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.startsWith('/api/health')) return json(health)
      if (url === '/api/sources') return json({ sources, custom_groups: custom })
      if (url === '/api/settings') return json(settings(mode))
      if (url.startsWith('/api/sources/grouping-preview')) return json({ groups: [], found: 0, docker: 5, total: 6 })
      if (url === '/api/source-groups' && method === 'POST')
        return json({ group: { id: 'g_3', name: body.name, order: 2 }, groups: all() }, 201)
      if (url.startsWith('/api/source-groups')) return json(all())
      if (url.startsWith('/api/stream/stats')) return json({ total: 0, levels: {}, histogram: [] })
      return json({ error: 'nope' }, 404)
    }),
  )
})
afterEach(() => {
  localStorage.clear()
  resetCollapsedGroups()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderAt(path: string, user = undefined as typeof member | undefined) {
  const client = makeQueryClient()
  seedAuth(client, user)
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }), client)
  render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return router
}

const table = () => screen.findByRole('table', {}, { timeout: 5000 })

describe('custom source groups (06.9)', () => {
  it('shows custom groups above the automatic ones, with the custom tag, notes, rules hint and Custom filter', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    const t = await table()
    const headers = within(t)
      .getAllByRole('button', { expanded: true })
      .map((b) => b.getAttribute('aria-label')?.split(' · ')[0])
    expect(headers).toEqual(['Legivent staging', 'Edge', 'thelegiventos-applications', 'Standalone', 'Ingest'])
    expect(within(t).getAllByText('custom').length).toBeGreaterThan(0)
    expect(within(t).getAllByText('· assigned by you')).toHaveLength(2)
    expect(within(t).getByText('· 2 moved to Legivent staging')).toBeInTheDocument()
    expect(within(t).getByText('Nothing in this group yet')).toBeInTheDocument()
    expect(screen.getByTestId('group-rules-hint')).toHaveTextContent('A group you make wins over Compose / Stack.')
    expect(screen.getByText(/^Your groups first/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Grouping' })).toHaveTextContent('Grouping · Auto')

    await user.click(screen.getByRole('tab', { name: 'Custom' }))
    expect(within(t).getByText('staging-bot')).toBeInTheDocument()
    expect(within(t).queryByText('dokploy')).not.toBeInTheDocument()
  })

  it('New group: name with a counter, pick sources with the filter, create in one request (06.10)', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    await table()
    await user.click(screen.getByRole('button', { name: 'New group' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    await user.type(name, 'legivent STAGING')
    expect(within(dialog).getByText(/already exists/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Create group/ })).toBeDisabled()
    await user.clear(name)
    await user.type(name, 'Workers')
    expect(within(dialog).getByText('7 / 48')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('checkbox', { name: 'dokploy' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Filter sources to pick' }), 'bot')
    await user.click(within(dialog).getByRole('button', { name: 'Select all 2 matches' }))
    expect(within(dialog).getByTestId('picked-count')).toHaveTextContent('3 selected')
    // v0.1 has owners and members only; the board's width beats the shadcn sm:max-w-sm default
    expect(within(dialog).getByTestId('new-group-access')).toHaveTextContent('owners can edit')
    expect(dialog.textContent).not.toMatch(/admins/)
    expect(dialog.className).toMatch(/sm:max-w-130/)
    expect(within(dialog).getByTitle('staging-bot')).toHaveClass('truncate')
    await user.click(within(dialog).getByRole('button', { name: /Create group/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeDefined())
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('/api/source-groups')
    expect(post?.body).toEqual({ name: 'Workers', sources: ['staging-bot', 'bot', 'dokploy'] })
  })

  it('a source’s ⋯ → Move to group moves it into a custom group, and Automatic puts it back (06.11)', async () => {
    // Base UI keeps a closing menu's backdrop around for a frame.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderAt('/sources')
    const t = await table()
    await user.click(within(t).getByRole('button', { name: 'staging-bot actions' }))
    expect(await screen.findByRole('menuitem', { name: /Stream this source/ })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: /Move to group/ }))
    expect(await screen.findByText('Move staging-bot to')).toBeInTheDocument()
    expect(
      screen.getByText('Back to Standalone: no Compose project or stack on this service.', { exact: false }),
    ).toBeInTheDocument()
    // A pointer move would leave the submenu trigger and close it; click the item directly.
    fireEvent.click(screen.getByRole('menuitem', { name: /Automatic \(compose \/ stack\)/ }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/source-groups/assign',
        method: 'PUT',
        body: { sources: ['staging-bot'], group: null },
      }),
    )

    await user.click(within(t).getByRole('button', { name: 'api actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Move to group/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Edge/ }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/source-groups/assign',
        method: 'PUT',
        body: { sources: ['api'], group: 'g_2' },
      }),
    )
  })

  it('the group header ⋯ renames, reorders and deletes a custom group (06.12)', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    const t = await table()
    const open = async () => {
      await user.click(within(t).getByRole('button', { name: 'Legivent staging actions' }))
      return screen.findByRole('menuitem', { name: /Move down/ })
    }
    await open()
    expect(screen.getByRole('menuitem', { name: /Move up/ })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('menuitem', { name: /Move down/ }))
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/source-groups/g_1', method: 'PATCH', body: { order: 1 } }),
    )

    await open()
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Staging{Enter}')
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/source-groups/g_1', method: 'PATCH', body: { name: 'Staging' } }),
    )

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await open()
    const del = screen.getByRole('menuitem', { name: /Delete group/ })
    expect(del).toHaveTextContent('Sources go back to automatic grouping (here: Standalone). No lines are deleted.')
    await user.click(del)
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/source-groups/g_1', method: 'DELETE', body: null }))
  })

  it('members see the groups but no edit controls', async () => {
    const user = userEvent.setup()
    renderAt('/sources', member)
    const t = await table()
    expect(within(t).getAllByText('· assigned by an owner').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'New group' })).not.toBeInTheDocument()
    await user.click(within(t).getByRole('button', { name: 'staging-bot actions' }))
    expect(await screen.findByRole('menuitem', { name: /Stream this source/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Move to group/ })).not.toBeInTheDocument()
  })

  it('Off: one flat list, the custom groups are kept for later', async () => {
    mode = 'off'
    sources = grouped.map((s) => src(s.name, { kind: s.kind, group: null, group_kind: null }))
    renderAt('/sources')
    const t = await table()
    expect(within(t).queryByRole('button', { expanded: true })).not.toBeInTheDocument()
    expect(await screen.findByText(/Your 2 custom groups are kept/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New group' })).not.toBeInTheDocument()
  })

  it('the sidebar and ⌘K list custom groups first', async () => {
    const user = userEvent.setup()
    renderAt('/sources')
    await table()
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(regions.slice(0, 2)).toEqual(['Legivent staging', 'thelegiventos-applications'])
    await user.click(screen.getByRole('button', { name: /Jump to/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('combobox'), 'staging')
    expect(await within(dialog).findByText('Groups')).toBeInTheDocument()
    expect(within(dialog).getAllByText('Legivent staging').length).toBeGreaterThan(0)
  })

  it('Settings → General shows the custom group count with a link to Sources (07.10)', async () => {
    renderAt('/settings')
    const row = await screen.findByTestId('custom-groups-row', {}, { timeout: 5000 })
    expect(row).toHaveTextContent('You can also make your own groups from Sources')
    await waitFor(() => expect(row).toHaveTextContent('· 2 custom groups'))
    expect(within(row).getByRole('link', { name: /Sources/ })).toHaveAttribute('href', '/sources')
  })
})
