import type { QueryClient } from '@tanstack/react-query'
import type { AuthState, User } from '@/gen'
import { authQuery } from '@/lib/auth-api'
import { setCsrf } from '@/lib/session'

export const owner: User = {
  id: 1,
  email: 'kwaame@legivent.com',
  name: 'Kwaame Ofori-adjekum',
  role: 'owner',
  created: 1_760_000_000_000,
  password_changed: 1_760_000_000_000,
}

export const member: User = { ...owner, id: 2, email: 'ama@legivent.com', name: 'Ama Mensah', role: 'member' }

export function authState(user: User | null, over: Partial<AuthState> = {}): AuthState {
  return {
    auth: 'on',
    setup_required: false,
    user,
    csrf: user ? 'csrf-1' : null,
    version: '0.1.0',
    host: null,
    ...over,
  }
}

/** Start a test signed in (as the owner unless told otherwise), skipping /api/auth/state. */
export function seedAuth(client: QueryClient, user: User | null = owner, over: Partial<AuthState> = {}) {
  const st = authState(user, over)
  client.setQueryData(authQuery.queryKey, st)
  setCsrf(st.csrf)
}
