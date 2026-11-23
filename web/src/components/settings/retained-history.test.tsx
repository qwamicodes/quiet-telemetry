import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetainedHistory } from '@/components/settings/retained-history'
import type { Destination, HistoryJob, HistoryPreview, HistoryStatus, VerifyResult } from '@/gen'
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
  capacity_bytes: null,
  capacity_source: null,
  at_capacity: false,
  removing: false,
  cleanup_error: null,
  cleanup_retry_at: null,
  cleanup_blocked_hours: 0,
  ...over,
})

const job = (over: Partial<HistoryJob> = {}): HistoryJob => ({
  id: 7,
  kind: 'copy',
  state: 'running',
  destination_id: 2,
  destination: 'r2-prod',
  source_id: 1,
  source: 'garage-local',
  total: 312,
  done: 78,
  bytes: 6e8,
  error: null,
  next_retry: null,
  created_at: Date.now() - 60_000,
  updated_at: Date.now(),
  ...over,
})

const PREVIEW: HistoryPreview = {
  retention_days: 30,
  before: Date.UTC(2026, 9, 24),
  hours: 214,
  lines: 900_000,
  bytes: 38e9,
  destinations: [
    { id: 3, name: 'production-r2', hours: 200, bytes: 35e9 },
    { id: 1, name: 'garage-local', hours: 14, bytes: 3e9 },
  ],
}

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
    policy: { retention_days: null, at_capacity: 'evict' },
    retained_from: null,
    expired_hours: 0,
    expired_bytes: 0,
    backfill_hours: 0,
    jobs: [],
  }
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s })
      if (method !== 'GET') calls.push({ url, method, body })
      if (url === '/api/storage/history') return json(status)
      if (url === '/api/settings/history' && method === 'PUT') {
        if (body.retention_days != null && body.confirm !== true)
          return json({ error: 'this deletes 214 archived hours', code: 'confirm_required', preview: PREVIEW }, 409)
        status.policy = { retention_days: body.retention_days, at_capacity: body.at_capacity }
        return json(status.policy)
      }
      if (url === '/api/storage/history/backfill') {
        const j = job({ id: 9, kind: 'backfill', total: status.backfill_hours, done: 0, source: null, source_id: null })
        status.jobs = [j, ...status.jobs]
        return json(j, 202)
      }
      if (url === '/api/storage/history/off') {
        for (const x of status.destinations) {
          x.active = false
          x.state = 'read_only'
        }
        status.active = null
        return new Response(null, { status: 204 })
      }
      const jm = url.match(/^\/api\/storage\/jobs\/(\d+)\/(cancel|retry)$/)
      if (jm) {
        const j = status.jobs.find((x) => x.id === Number(jm[1])) as HistoryJob
        j.state = jm[2] === 'cancel' ? 'cancelled' : 'running'
        return json(j)
      }
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
      const m = url.match(/^\/api\/storage\/destinations\/(\d+)(\/[\w-]+)?$/)
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
        if (m[2] === '/capacity') {
          d.capacity_bytes = body.capacity_bytes
          d.capacity_source = body.capacity_bytes == null ? null : 'owner'
          return json(d)
        }
        if (m[2] === '/retry-cleanup') return json(d)
        if (method === 'DELETE' && body?.delete_history) {
          d.removing = true
          return json({ job: job({ id: 11, kind: 'delete', destination_id: d.id, destination: d.name }) }, 202)
        }
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

  it('a shorter history window shows what it deletes and asks before deleting', async () => {
    status = { ...status, enabled: true, active: 1, destinations: [garage()] }
    const user = userEvent.setup()
    show()
    const group = await screen.findByRole('group', { name: 'Keep history for' })
    expect(screen.getByText('kept indefinitely · default')).toBeInTheDocument()
    await user.click(within(group).getByRole('button', { name: '30d' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Keep history 30 days?')).toBeInTheDocument()
    expect(
      within(dialog).getByText(/This deletes 214 hours · 38\.0 GB from production-r2 and garage-local/),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete 214 hours' }))
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/settings/history',
        method: 'PUT',
        body: { retention_days: 30, at_capacity: 'evict', confirm: true },
      }),
    )
    // When full: stop archiving.
    await user.click(
      within(screen.getByRole('group', { name: 'When a destination is full' })).getByRole('button', {
        name: 'Stop archiving',
      }),
    )
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: { retention_days: 30, at_capacity: 'stop' } }))
  })

  it('members see the policy but cannot change it', async () => {
    status = {
      ...status,
      enabled: true,
      active: 1,
      destinations: [garage()],
      policy: { retention_days: 90, at_capacity: 'evict' },
    }
    show(member)
    const group = await screen.findByRole('group', { name: 'Keep history for' })
    expect(within(group).getByRole('button', { name: '90d' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Capacity' })).not.toBeInTheDocument()
  })

  it('capacity, full, and cleanup blocked with Retry', async () => {
    status = {
      ...status,
      enabled: true,
      active: 1,
      destinations: [
        garage({
          capacity_bytes: 2.4e9,
          capacity_source: 'garage',
          at_capacity: true,
          cleanup_blocked_hours: 12,
          cleanup_error: 'AccessDenied: object lock',
          cleanup_retry_at: Date.now() + 5 * 60_000,
        }),
      ],
    }
    const user = userEvent.setup()
    show()
    const list = await screen.findByRole('list', { name: 'Destinations' })
    expect(within(list).getByText('full')).toBeInTheDocument()
    expect(within(list).getByText('2.4 GB of 2.4 GB · Garage quota')).toBeInTheDocument()
    expect(
      within(list).getByText(
        /Cleanup blocked: 12 hours can't be deleted here \(AccessDenied: object lock\) · trying again in 5 min/,
      ),
    ).toBeInTheDocument()
    await user.click(within(list).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/storage/destinations/1/retry-cleanup'))
    await user.click(within(list).getByRole('button', { name: 'Capacity' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Capacity in GB'), '50')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/storage/destinations/1/capacity',
        method: 'PUT',
        body: { capacity_bytes: 50e9 },
      }),
    )
  })

  it('switching the active destination offers to copy its history', async () => {
    status = {
      ...status,
      enabled: true,
      active: 1,
      destinations: [
        garage(),
        garage({
          id: 2,
          name: 'r2-prod',
          kind: 'r2',
          active: false,
          state: 'read_only',
          hours: 0,
          lines: 0,
          bytes_stored: 0,
          first: null,
          last: null,
        }),
      ],
    }
    const user = userEvent.setup()
    show()
    const list = await screen.findByRole('list', { name: 'Destinations' })
    const rows = within(list).getAllByRole('listitem')
    await user.click(within(rows[1]).getByRole('button', { name: 'Make active' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Copy garage-local's history here \(312 h · 2\.4 GB\)/)).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox')).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Make active' }))
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/storage/destinations/2/activate',
        body: { copy_history: true },
      }),
    )
  })

  it('jobs list progress and cancel', async () => {
    status = { ...status, enabled: true, active: 2, destinations: [garage({ id: 2, name: 'r2-prod' })], jobs: [job()] }
    const user = userEvent.setup()
    show()
    const jobs = await screen.findByRole('list', { name: 'History jobs' })
    expect(within(jobs).getByText('Copying history from garage-local to r2-prod')).toBeInTheDocument()
    expect(within(jobs).getByText(/78 \/ 312 h · 600 MB · running/)).toBeInTheDocument()
    expect(within(jobs).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    await user.click(within(jobs).getByRole('button', { name: 'Cancel job 7' }))
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/storage/jobs/7/cancel'))
  })

  it('a blocked delete job offers Retry', async () => {
    status = {
      ...status,
      enabled: true,
      active: 2,
      destinations: [garage({ id: 2, name: 'r2-prod' })],
      jobs: [
        job({
          id: 11,
          kind: 'delete',
          state: 'blocked',
          destination: 'garage-local',
          error: 'AccessDenied',
          total: 4,
          done: 1,
        }),
      ],
    }
    const user = userEvent.setup()
    show()
    const jobs = await screen.findByRole('list', { name: 'History jobs' })
    expect(within(jobs).getByText("Deleting garage-local's history")).toBeInTheDocument()
    expect(within(jobs).getByText(/cleanup blocked/)).toBeInTheDocument()
    await user.click(within(jobs).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/storage/jobs/11/retry'))
  })

  it('removing a destination can delete its history', async () => {
    status = {
      ...status,
      enabled: true,
      active: 1,
      destinations: [
        garage(),
        garage({ id: 3, name: 'r2-old', kind: 'r2', active: false, state: 'read_only', hours: 24, bytes_stored: 3e6 }),
      ],
    }
    const user = userEvent.setup()
    show()
    const list = await screen.findByRole('list', { name: 'Destinations' })
    const rows = within(list).getAllByRole('listitem')
    await user.click(within(rows[1]).getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Delete its history/ }))
    expect(within(dialog).getByText(/Deletes 24 hours \(3 MB\) in the background/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete its history and remove' }))
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/storage/destinations/3',
        method: 'DELETE',
        body: { delete_history: true },
      }),
    )
  })

  it('offers to archive the local window right after history is on, and remembers Not now', async () => {
    status = { ...status, enabled: true, active: 1, destinations: [garage()], backfill_hours: 23 }
    const user = userEvent.setup()
    show()
    expect(await screen.findByText("23 hours in the local window aren't archived yet")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Archive now' }))
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/storage/history/backfill'))
    // Its job now shows; the offer is gone.
    expect(await screen.findByText('Archiving the local window to r2-prod')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive now' })).not.toBeInTheDocument()
  })

  it('Not now hides the backfill offer; Turn off asks first', async () => {
    status = { ...status, enabled: true, active: 1, destinations: [garage()], backfill_hours: 5 }
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('button', { name: 'Archive now' })).not.toBeInTheDocument()
    expect(localStorage.getItem('quiet.history.backfill.dismissed')).toBe('e02fb9d36cd13960')
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/storage/history/off'))
  })
})
