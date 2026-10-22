import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthState, Health, Invite, Member, User } from '@/gen'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import { authState, member, owner, seedAuth } from '@/test/auth'

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

const DAY = 86_400_000
const invite = (over: Partial<Invite> = {}): Invite => ({
  id: 7,
  preview: 'inv_••••91c4',
  email: 'yaw@legivent.com',
  role: 'member',
  created_by: 'Kwaame Ofori-adjekum',
  created: Date.now() - DAY,
  expires: Date.now() + 6 * DAY,
  used: null,
  revoked: null,
  ...over,
})

type Call = { url: string; method: string; body: unknown; headers: Headers }
let calls: Call[] = []
/** Per-test overrides: return a Response to answer, or undefined to fall through. */
let handler: (c: Call) => Response | undefined = () => undefined
let state: AuthState = authState(owner)
let members: Member[] = []
let invites: Invite[] = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'backlog', lines: [] }) }))
  }
  close() {}
}

beforeEach(() => {
  calls = []
  handler = () => undefined
  state = authState(owner)
  members = [
    { ...owner, last_seen: Date.now() },
    { ...member, last_seen: Date.now() - 2 * 3_600_000 },
  ]
  invites = [invite(), invite({ id: 8, email: 'efua@legivent.com', expires: Date.now() - DAY })]
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      const c: Call = { url, method, body, headers: new Headers(init.headers) }
      calls.push(c)
      const over = handler(c)
      if (over) return over
      if (url === '/api/auth/state') return json(state)
      if (url.startsWith('/api/health')) return json(health)
      if (url.startsWith('/api/sources')) return json({ sources: [] })
      if (url === '/api/members') return json({ members, invites: state.user?.role === 'owner' ? invites : [] })
      if (url === '/api/account/sessions') return json({ sessions: [] })
      if (url === '/api/ingest-tokens') return json({ tokens: [] })
      return json({ error: 'nope' }, 404)
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Render at `path`; `seed` starts signed in as that user (else the app asks the server). */
function renderAt(path: string, seed?: User | null) {
  const client = makeQueryClient()
  if (seed !== undefined) seedAuth(client, seed)
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }), client)
  render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return { router, client }
}

const posted = (url: string) => calls.filter((c) => c.url === url && c.method !== 'GET')

describe('signed-out redirects', () => {
  it('no owner yet: every page goes to first-run setup', async () => {
    state = authState(null, { setup_required: true })
    const { router } = renderAt('/search?q=boom')
    await waitFor(() => expect(router.state.location.pathname).toBe('/setup'))
    expect(await screen.findByRole('heading', { name: 'Set up quiet' })).toBeInTheDocument()
  })

  it('signed out: app pages go to sign in and come back afterwards', async () => {
    const user = userEvent.setup()
    state = authState(null)
    handler = (c) =>
      c.url === '/api/auth/login'
        ? c.body && (c.body as { password: string }).password === 'right password!!'
          ? json({ user: owner, csrf: 'csrf-2' })
          : json({ error: 'email or password is wrong', code: 'bad_credentials' }, 401)
        : undefined
    const { router } = renderAt('/search?q=boom')
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'))
    // The search page's defaults are filled in before the guard runs.
    expect((router.state.location.search as { redirect: string }).redirect).toMatch(/^\/search\?q=boom/)

    const form = await screen.findByRole('form', { name: 'Sign in' })
    await user.type(within(form).getByLabelText('Email'), 'kwaame@legivent.com')
    await user.type(within(form).getByLabelText('Password'), 'wrong password!')
    await user.click(within(form).getByRole('button', { name: /Sign in/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is wrong')

    await user.clear(within(form).getByLabelText('Password'))
    await user.type(within(form).getByLabelText('Password'), 'right password!!')
    await user.click(within(form).getByRole('button', { name: /Sign in/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'))
    expect(router.state.location.search).toMatchObject({ q: 'boom' })
    expect(posted('/api/auth/login')[1].body).toEqual({
      email: 'kwaame@legivent.com',
      password: 'right password!!',
      remember: true,
    })
  })

  it('a redirect to another site is ignored; signed-in users skip the sign-in page', async () => {
    state = authState(null)
    const { router } = renderAt('/signin?redirect=//evil.example/x')
    await screen.findByRole('form', { name: 'Sign in' })
    expect(router.state.location.search).toEqual({})
    const again = renderAt('/signin', owner)
    await waitFor(() => expect(again.router.state.location.pathname).toBe('/'))
  })

  it('setup is gone once an owner exists', async () => {
    const { router } = renderAt('/setup', owner)
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })
})

describe('first-run setup', () => {
  it('creates the owner and lands on the app', async () => {
    const user = userEvent.setup()
    state = authState(null, {
      setup_required: true,
      host: {
        docker: { state: 'connected', containers: 9 },
        store: 'sqlite',
        data_dir: '/data',
        data_dir_writable: true,
        retention_ms: DAY,
        max_disk: 5_000_000_000,
      },
    })
    handler = (c) => (c.url === '/api/auth/setup' ? json({ user: owner, csrf: 'csrf-9' }, 201) : undefined)
    const { router } = renderAt('/setup')
    const form = await screen.findByRole('form', { name: 'Create owner account' })
    expect(screen.getByText('docker.sock · 9 containers')).toBeInTheDocument()
    await user.type(within(form).getByLabelText('Your name'), 'Kwaame Ofori-adjekum')
    await user.type(within(form).getByLabelText('Email'), 'kwaame@legivent.com')
    await user.type(within(form).getByLabelText('Password'), 'short')
    expect(screen.getByText('too short · 5 characters')).toBeInTheDocument()
    await user.type(within(form).getByLabelText('Password'), ' but now Long!')
    expect(screen.getByText(/strong · 19 characters/)).toBeInTheDocument()
    await user.click(within(form).getByRole('button', { name: /Create owner account/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(posted('/api/auth/setup')[0].body).toEqual({
      name: 'Kwaame Ofori-adjekum',
      email: 'kwaame@legivent.com',
      password: 'short but now Long!',
    })
    // The session's CSRF token rides on the next write.
    expect(screen.getByRole('button', { name: /Account menu/ })).toBeInTheDocument()
  })
})

describe('invite links', () => {
  it('a valid invite locks its email and signs the new member in', async () => {
    const user = userEvent.setup()
    state = authState(null)
    handler = (c) => {
      if (c.url === '/api/auth/invite') return json(invite())
      if (c.url === '/api/auth/invite/accept')
        return json({ user: { ...member, email: 'yaw@legivent.com' }, csrf: 'c' }, 201)
      return undefined
    }
    const token = `inv_${'a'.repeat(64)}`
    const { router } = renderAt(`/invite/${token}`)
    expect(await screen.findByText('Kwaame Ofori-adjekum invited you as a member')).toBeInTheDocument()
    const form = screen.getByRole('form', { name: 'Accept invite' })
    const email = within(form).getByLabelText('Email')
    expect(email).toHaveValue('yaw@legivent.com')
    expect(email).toHaveAttribute('readonly')
    await user.type(within(form).getByLabelText('Your name'), 'Yaw Boateng')
    await user.type(within(form).getByLabelText('Password'), 'fourteen chars')
    await user.click(within(form).getByRole('button', { name: /Join/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(posted('/api/auth/invite/accept')[0].body).toEqual({
      token,
      name: 'Yaw Boateng',
      password: 'fourteen chars',
    })
  })

  it('an expired invite says so, with who made it and when', async () => {
    state = authState(null)
    handler = (c) =>
      c.url === '/api/auth/invite'
        ? json(
            { error: 'this link has expired', code: 'expired', invite: invite({ expires: Date.now() - 3 * DAY }) },
            410,
          )
        : undefined
    renderAt(`/invite/inv_${'b'.repeat(64)}`)
    expect(await screen.findByRole('heading', { name: 'This invite link has expired' })).toBeInTheDocument()
    expect(screen.getByText('inv_••••91c4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy message' })).toHaveTextContent('Copy message for Kwaame')
  })

  it('a malformed link is broken without asking the server', async () => {
    state = authState(null)
    renderAt('/invite/not-a-token')
    expect(await screen.findByRole('heading', { name: 'This link is broken' })).toBeInTheDocument()
    expect(posted('/api/auth/invite')).toHaveLength(0)
  })
})

describe('members', () => {
  it('owner: invite link banner, role select, reset link from the row menu (Menu + Dialog open)', async () => {
    const user = userEvent.setup()
    handler = (c) => {
      if (c.url === '/api/invites' && c.method === 'POST')
        return json({ invite: invite(), token: 'inv_q7Hc', path: '/invite/inv_q7Hc' }, 201)
      if (c.url === '/api/members/2/reset-link')
        return json({ token: 'rst_1', path: '/reset/rst_1', expires: Date.now() + DAY })
      return undefined
    }
    renderAt('/settings/members', owner)
    const people = await screen.findByRole('list', { name: 'People' })
    expect(within(people).getByText('Ama Mensah')).toBeInTheDocument()
    expect(within(people).getByText('active now')).toBeInTheDocument()
    expect(within(people).getByText('expired')).toBeInTheDocument()

    const form = screen.getByRole('form', { name: 'Create invite link' })
    await user.type(within(form).getByLabelText('Invitee email'), 'yaw@legivent.com')
    await user.click(within(form).getByRole('button', { name: /Create invite link/ }))
    expect(await screen.findByTestId('invite-link')).toHaveTextContent('/invite/inv_q7Hc')
    const post = posted('/api/invites')[0]
    expect(post.body).toEqual({ email: 'yaw@legivent.com', role: 'member' })
    expect(post.headers.get('x-quiet-csrf')).toBe('csrf-1')

    await user.click(within(people).getByRole('button', { name: 'More for Ama Mensah' }))
    await user.click(await screen.findByRole('menuitem', { name: /Password reset link/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/\/reset\/rst_1/)).toBeInTheDocument()
  })

  it('member: reads the list, manages nothing', async () => {
    state = authState(member)
    renderAt('/settings/members', member)
    const people = await screen.findByRole('list', { name: 'People' })
    expect(within(people).getByText('Kwaame Ofori-adjekum')).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Create invite link' })).not.toBeInTheDocument()
    expect(within(people).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(people).queryByText('pending')).not.toBeInTheDocument()
  })
})

describe('session', () => {
  it('a 401 mid-session shows "session expired"; signing in again keeps the page', async () => {
    const user = userEvent.setup()
    let expired = false
    handler = (c) => {
      if (c.url === '/api/auth/login') {
        expired = false
        return json({ user: owner, csrf: 'csrf-3' })
      }
      if (expired && c.url.startsWith('/api/') && !c.url.startsWith('/api/auth/'))
        return json({ error: 'your session expired; sign in again', code: 'session_expired' }, 401)
      return undefined
    }
    const { router } = renderAt('/settings/account', owner)
    await screen.findByRole('region', { name: 'Sessions' })
    expired = true
    // Any API call notices (the sources poll within 3 s); opening Members asks at once.
    await user.click(screen.getByRole('link', { name: 'Members' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Your session expired')).toBeInTheDocument()
    expect(within(dialog).getByText('kwaame@legivent.com')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Password'), 'correct horse battery')
    await user.click(within(dialog).getByRole('button', { name: /Sign in again/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/settings/members')
    expect(posted('/api/auth/login').at(-1)?.body).toMatchObject({ email: 'kwaame@legivent.com' })
  })

  it('user menu (Menu) opens; sign out goes to the sign-in page', async () => {
    const user = userEvent.setup()
    handler = (c) => (c.url === '/api/auth/logout' ? new Response(null, { status: 204 }) : undefined)
    const { router } = renderAt('/settings', owner)
    await user.click(await screen.findByRole('button', { name: /Account menu for Kwaame/ }))
    expect(await screen.findByRole('menuitem', { name: /Account/ })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: /Sign out/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'))
    expect(posted('/api/auth/logout')[0].headers.get('x-quiet-csrf')).toBe('csrf-1')
  })
})
