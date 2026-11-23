import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetainedHistory } from '@/components/settings/retained-history'
import type { Destination, HistoryStatus, VerifyResult } from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { member, owner, seedAuth } from '@/test/auth'

const H = 3_600_000
const NOW = Date.UTC(2026, 10, 23, 14, 0)

const passed = (at = NOW): VerifyResult => ({
  ok: true,
  cleanup: true,
  steps: (['write', 'read', 'list', 'delete'] as const).map((step) => ({ step, ok: true })),
  at,
})

const garage = (over: Partial<Destination> = {}): Destination => ({
  id: 1,
  name: 'garage-local',
  kind: 'garage',
  endpoint: 'http://garage:3900',
  region: 'garage',
  bucket: 'quiet-history',
  prefix: 'quiet/e02fb9d36cd13960/',
  path_style: true,
  access_key_preview: 'GK46••••bca0',
  active: true,
  state: 'ok',
  verified_at: NOW - 60_000,
  last_verify: passed(),
  hours: 312,
  lines: 1_200_000,
  bytes_stored: 2.4e9,
  first: Date.UTC(2026, 10, 9),
  last: Date.UTC(2026, 10, 21),
  error: null,
  next_retry: null,
  created_at: NOW - 14 * 24 * H,
  ...over,
})

let status: HistoryStatus
let calls: { url: string; method: string; body: unknown }[]
let verifyNext: VerifyResult

beforeEach(() => {
  calls = []
  verifyNext = passed()
  status = {
    enabled: false,
    enabled_at: null,
    instance_id: 'e02fb9d36cd13960',
    active: null,
    destinations: [],
    gaps: [],
    gap_hours: 0,
    waiting_hours: 0,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s })
      if (method !== 'GET') calls.push({ url, method, body })
      if (url === '/api/storage/history') return json(status)
      if (url === '/api/storage/destinations' && method === 'POST') {
        const d = garage({
          id: 2,
          name: body.name,
          kind: body.kind,
          active: false,
          state: 'read_only',
          hours: 0,
          lines: 0,
          bytes_stored: 0,
          first: null,
          last: null,
          last_verify: verifyNext,
        })
        status.destinations.push(d)
        return json({ destination: d, verify: verifyNext }, 201)
      }
      const m = url.match(/^\/api\/storage\/destinations\/(\d+)(\/\w+)?$/)
      if (m) {
        const d = status.destinations.find((x) => x.id === Number(m[1]))
        if (!d) return json({ error: 'no such destination', code: 'not_found' }, 404)
        if (m[2] === '/activate') {
          for (const x of status.destinations) {
            x.active = x.id === d.id
            x.state = x.active ? 'ok' : 'read_only'
          }
          status.enabled = true
          status.active = d.id
          return json(d)
        }
        if (m[2] === '/verify') return json(verifyNext)
        if (method === 'DELETE') {
          status.destinations = status.destinations.filter((x) => x.id !== d.id)
          return new Response(null, { status: 204 })
        }
      }
      return json({ error: 'nope' }, 404)
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function show(user = owner) {
  const client = makeQueryClient()
  seedAuth(client, user)
  render(
    <Providers client={client}>
      <RetainedHistory sqlite />
    </Providers>,
  )
}

describe('Settings → Storage → Retained history (5a)', () => {
  it('is off until a destination is connected; members see no Connect', async () => {
    show(member)
    expect(await screen.findByText('off · local window only')).toBeInTheDocument()
    expect(screen.getByText(/in Garage next to quiet, or in a bucket you bring/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Connect storage/ })).not.toBeInTheDocument()
  })

  it('connects R2: Save and verify shows each step, then turns history on', async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole('button', { name: /Connect storage/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cloudflare R2' }))
    expect(within(dialog).getByLabelText('Name')).toHaveValue('r2-history')
    expect(within(dialog).getByLabelText('Endpoint')).toHaveAttribute(
      'placeholder',
      'https://<account id>.r2.cloudflarestorage.com',
    )
    await user.type(within(dialog).getByLabelText('Endpoint'), 'https://acc.r2.cloudflarestorage.com')
    await user.type(within(dialog).getByLabelText('Access key id'), 'AKIAEXAMPLE1234')
    await user.type(within(dialog).getByLabelText('Secret access key'), 'shh-secret')
    await user.click(within(dialog).getByRole('button', { name: 'Save and verify' }))
    await waitFor(() =>
      expect(calls[0]).toMatchObject({
        url: '/api/storage/destinations',
        method: 'POST',
        body: {
          name: 'r2-history',
          kind: 'r2',
          endpoint: 'https://acc.r2.cloudflarestorage.com',
          bucket: 'quiet-history',
          path_style: false,
          access_key_id: 'AKIAEXAMPLE1234',
          secret_access_key: 'shh-secret',
          activate: false,
        },
      }),
    )
    const steps = await within(dialog).findByRole('list', { name: 'Verify results' })
    expect(within(steps).getAllByLabelText('passed')).toHaveLength(4)
    await user.click(within(dialog).getByRole('button', { name: 'Turn on retained history' }))
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/storage/destinations/2/activate',
        body: { copy_history: false },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('on · r2-history')).toBeInTheDocument()
  })

  it('a failed Verify says which step and offers no Make active', async () => {
    verifyNext = {
      ok: false,
      cleanup: false,
      steps: [
        { step: 'write', ok: false, error: 'AccessDenied' },
        { step: 'read', ok: false, error: 'skipped: write failed' },
        { step: 'list', ok: false, error: 'skipped: write failed' },
        { step: 'delete', ok: false, error: 'skipped: write failed' },
      ],
      at: NOW,
    }
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole('button', { name: /Connect storage/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Endpoint'), 'http://garage:3900')
    await user.type(within(dialog).getByLabelText('Access key id'), 'GK1234567890')
    await user.type(within(dialog).getByLabelText('Secret access key'), 'x')
    await user.click(within(dialog).getByRole('button', { name: 'Save and verify' }))
    expect(await within(dialog).findByText('AccessDenied')).toBeInTheDocument()
    expect(within(dialog).getByText(/Verify failed for/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /active|Turn on/ })).not.toBeInTheDocument()
  })

  it('lists destinations: active, read only, unavailable with retry, gaps; removing keeps the data', async () => {
    status = {
      ...status,
      enabled: true,
      active: 1,
      destinations: [
        garage({
          state: 'unavailable',
          error: 'connection refused',
          next_retry: Date.now() + 30_000,
        }),
        garage({
          id: 3,
          name: 'r2-old',
          kind: 'r2',
          active: false,
          state: 'read_only',
          hours: 24,
          lines: 9000,
          bytes_stored: 3e6,
        }),
      ],
      gaps: [{ hour: Date.UTC(2026, 10, 8, 3), reason: 'disk_cap', at: NOW }],
      gap_hours: 1,
      waiting_hours: 3,
    }
    const user = userEvent.setup()
    show()
    expect(await screen.findByText('on · garage-local · 3 h waiting')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Destinations' })
    expect(within(list).getByText('active')).toBeInTheDocument()
    expect(within(list).getByText('read only')).toBeInTheDocument()
    expect(within(list).getByText(/Unreachable: connection refused · retrying in \d+s/)).toBeInTheDocument()
    expect(within(list).getByText(/312 h · 1\.2M lines · 2\.4 GB/)).toBeInTheDocument()
    expect(within(list).getAllByText(/key GK46••••bca0/)).toHaveLength(2)
    expect(screen.getByText(/1 hour not retained · latest: .*the disk cap dropped it/)).toBeInTheDocument()
    // The active one can't be removed; the read-only one can, keeping its data.
    const rows = within(list).getAllByRole('listitem')
    expect(within(rows[0]).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    await user.click(within(rows[1]).getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/The objects stay in quiet-history/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove, keep its data' }))
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/storage/destinations/3',
        method: 'DELETE',
        body: { delete_history: false },
      }),
    )
  })
})
