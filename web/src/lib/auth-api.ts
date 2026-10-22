import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type {
  AcceptInvite,
  AuthState,
  ChangePassword,
  CompleteReset,
  CreatedInvite,
  CreateInvite,
  Invite,
  InviteProblem,
  LoginRequest,
  Member,
  MembersResponse,
  PasswordChanged,
  ResetInfo,
  ResetLink,
  Role,
  SessionInfo,
  SessionsResponse,
  SetupHost,
  SetupRequest,
  SignedIn,
  SignedOutOthers,
  UpdateProfile,
  User,
} from '@/gen'
import { ApiError, fetchJson, sendJson } from '@/lib/api'
import { publicOrigin } from '@/lib/format'
import { dockerStatus } from '@/lib/schemas'
import { apiFetch, clearSessionLost, setCsrf } from '@/lib/session'

// ---- schemas (each satisfies its generated type) ----------------------------

export const role = z.enum(['owner', 'member']) satisfies z.ZodType<Role>

export const user = z.object({
  id: z.number(),
  email: z.string(),
  name: z.string(),
  role,
  created: z.number(),
  password_changed: z.number(),
}) satisfies z.ZodType<User>

export const member = user.extend({ last_seen: z.number().nullable() }) satisfies z.ZodType<Member>

export const invite = z.object({
  id: z.number(),
  preview: z.string(),
  email: z.string().nullable(),
  role,
  created_by: z.string(),
  created: z.number(),
  expires: z.number(),
  used: z.number().nullable(),
  revoked: z.number().nullable(),
}) satisfies z.ZodType<Invite>

export const inviteProblem = z.object({
  error: z.string(),
  code: z.string(),
  invite: invite.nullable(),
}) satisfies z.ZodType<InviteProblem>

const setupHost = z.object({
  docker: dockerStatus,
  store: z.string(),
  data_dir: z.string().nullable(),
  data_dir_writable: z.boolean(),
  retention_ms: z.number(),
  max_disk: z.number(),
}) satisfies z.ZodType<SetupHost>

export const authState = z.object({
  auth: z.enum(['on', 'off']),
  setup_required: z.boolean(),
  user: user.nullable(),
  csrf: z.string().nullable(),
  version: z.string(),
  instance_name: z.string(),
  host: setupHost.nullable(),
}) satisfies z.ZodType<AuthState>

const signedIn = z.object({ user, csrf: z.string() }) satisfies z.ZodType<SignedIn>

const sessionInfo = z.object({
  id: z.number(),
  created: z.number(),
  last_seen: z.number(),
  expires: z.number(),
  user_agent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
}) satisfies z.ZodType<SessionInfo>

const sessionsResponse = z.object({ sessions: z.array(sessionInfo) }) satisfies z.ZodType<SessionsResponse>
const membersResponse = z.object({
  members: z.array(member),
  invites: z.array(invite),
}) satisfies z.ZodType<MembersResponse>
const createdInvite = z.object({ invite, token: z.string(), path: z.string() }) satisfies z.ZodType<CreatedInvite>
const resetLink = z.object({ token: z.string(), path: z.string(), expires: z.number() }) satisfies z.ZodType<ResetLink>
const resetInfo = z.object({ email: z.string(), name: z.string(), expires: z.number() }) satisfies z.ZodType<ResetInfo>
const passwordChanged = z.object({ user, signed_out: z.number() }) satisfies z.ZodType<PasswordChanged>
const signedOutOthers = z.object({ signed_out: z.number() }) satisfies z.ZodType<SignedOutOthers>

/** Path params of the signed-out link pages: anything else is a broken link. */
export const inviteParams = z.object({ token: z.string().regex(/^inv_[0-9a-f]{16,128}$/) })
export const resetParams = z.object({ token: z.string().regex(/^rst_[0-9a-f]{16,128}$/) })

/** `?redirect=` on /signin: a path on this origin only (never `//evil` or a full URL). */
export const signInSearch = z.object({
  redirect: z
    .string()
    .refine((v) => v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\'))
    .optional()
    .catch(undefined),
})

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// ---- auth state ----------------------------------------------------------------

export const AUTH_KEY = ['auth'] as const

/** Who is signed in. Kept fresh by the mutations below, not by polling. */
export const authQuery = queryOptions({
  queryKey: AUTH_KEY,
  queryFn: async () => {
    const st = await fetchJson('/api/auth/state', authState)
    setCsrf(st.csrf)
    return st
  },
  staleTime: Number.POSITIVE_INFINITY,
  retry: 1,
})

export const useAuth = () => useQuery(authQuery)

/** The signed-in user (or the local owner with auth off). */
export function useMe(): User | null {
  return useAuth().data?.user ?? null
}

export const isOwner = (u: User | null | undefined) => u?.role === 'owner'

/** After any sign-in: remember the CSRF token and the user, drop stale data. */
function useSignedIn() {
  const qc = useQueryClient()
  return (r: SignedIn) => {
    setCsrf(r.csrf)
    const prev = qc.getQueryData(authQuery.queryKey)
    qc.setQueryData(authQuery.queryKey, {
      auth: 'on',
      version: prev?.version ?? '',
      instance_name: prev?.instance_name ?? 'quiet',
      host: null,
      setup_required: false,
      user: r.user,
      csrf: r.csrf,
    } satisfies AuthState)
    clearSessionLost()
    // Everything cached before belongs to the previous session.
    qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] })
  }
}

export function useSetup() {
  const done = useSignedIn()
  return useMutation({
    mutationFn: (b: SetupRequest) => fetchJson('/api/auth/setup', signedIn, json(b)),
    onSuccess: done,
  })
}

export function useLogin() {
  const done = useSignedIn()
  return useMutation({
    mutationFn: (b: LoginRequest) => fetchJson('/api/auth/login', signedIn, json(b)),
    onSuccess: done,
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      // A session that already ended is signed out either way.
      await sendJson('/api/auth/logout', json({})).catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) throw e
      })
    },
    onSuccess: () => {
      setCsrf(null)
      clearSessionLost()
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] })
      qc.setQueryData(authQuery.queryKey, (prev) => (prev ? { ...prev, user: null, csrf: null } : prev))
    },
  })
}

// ---- invite + reset links (signed out) ------------------------------------------------

export type InviteLookup = { ok: true; invite: Invite } | { ok: false; problem: InviteProblem }

/** `POST /api/auth/invite`: an expired/used/revoked link is a result, not an error. */
export async function lookupInvite(token: string): Promise<InviteLookup> {
  const res = await apiFetch('/api/auth/invite', json({ token }))
  const body: unknown = await res.json().catch(() => null)
  if (res.ok) return { ok: true, invite: invite.parse(body) }
  const p = inviteProblem.safeParse(body)
  if (p.success) return { ok: false, problem: p.data }
  throw new ApiError(
    '/api/auth/invite',
    res.status,
    (body as { error?: string } | null)?.error ?? 'invite lookup failed',
  )
}

export const inviteQuery = (token: string) =>
  queryOptions({ queryKey: ['invite', token], queryFn: () => lookupInvite(token), retry: false, staleTime: 30_000 })

export function useAcceptInvite() {
  const done = useSignedIn()
  return useMutation({
    mutationFn: (b: AcceptInvite) => fetchJson('/api/auth/invite/accept', signedIn, json(b)),
    onSuccess: done,
  })
}

export const resetQuery = (token: string) =>
  queryOptions({
    queryKey: ['reset', token],
    queryFn: () => fetchJson('/api/auth/reset', resetInfo, json({ token })),
    retry: false,
    staleTime: 30_000,
  })

export function useCompleteReset() {
  return useMutation({
    mutationFn: (b: CompleteReset) => sendJson('/api/auth/reset/accept', json(b)),
  })
}

// ---- account ----------------------------------------------------------------------------

export function useUpdateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: UpdateProfile) => fetchJson('/api/account', user, json(b, 'PATCH')),
    onSuccess: (u) => {
      qc.setQueryData(authQuery.queryKey, (prev) => (prev ? { ...prev, user: u } : prev))
      qc.invalidateQueries({ queryKey: ['members'] })
    },
  })
}

export function useChangePassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: ChangePassword) => fetchJson('/api/account/password', passwordChanged, json(b)),
    onSuccess: (r) => {
      qc.setQueryData(authQuery.queryKey, (prev) => (prev ? { ...prev, user: r.user } : prev))
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
}

export const sessionsQuery = queryOptions({
  queryKey: ['sessions'],
  queryFn: () => fetchJson('/api/account/sessions', sessionsResponse),
  select: (d) => d.sessions,
  refetchInterval: 30_000,
})

export const useSessions = () => useQuery(sessionsQuery)

export function useSignOutSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => sendJson(`/api/account/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

export function useSignOutOthers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => fetchJson('/api/account/sessions/sign-out-others', signedOutOthers, json({})),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

// ---- members (owners manage, everyone reads) ----------------------------------------------

export const membersQuery = queryOptions({
  queryKey: ['members'],
  queryFn: () => fetchJson('/api/members', membersResponse),
  refetchInterval: 30_000,
})

export const useMembers = () => useQuery(membersQuery)

function useInvalidateMembers() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['members'] })
}

export function useCreateInvite() {
  const done = useInvalidateMembers()
  return useMutation({
    mutationFn: (b: CreateInvite) => fetchJson('/api/invites', createdInvite, json(b)),
    onSuccess: done,
  })
}

export function useRevokeInvite() {
  const done = useInvalidateMembers()
  return useMutation({
    mutationFn: (id: number) => fetchJson(`/api/invites/${id}`, invite, { method: 'DELETE' }),
    onSuccess: done,
  })
}

export function useSetRole() {
  const done = useInvalidateMembers()
  return useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) =>
      fetchJson(`/api/members/${id}`, user, json({ role }, 'PATCH')),
    onSuccess: done,
  })
}

export function useRemoveMember() {
  const done = useInvalidateMembers()
  return useMutation({
    mutationFn: (id: number) => fetchJson(`/api/members/${id}`, user, { method: 'DELETE' }),
    onSuccess: done,
  })
}

export function useResetLink() {
  return useMutation({
    mutationFn: (id: number) => fetchJson(`/api/members/${id}/reset-link`, resetLink, json({})),
  })
}

/** A link on this origin, for the copy buttons. */
export const absolute = (path: string) => `${publicOrigin()}${path}`
