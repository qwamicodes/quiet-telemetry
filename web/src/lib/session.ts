import { useSyncExternalStore } from 'react'

/**
 * Browser-side session bits that live outside React Query:
 *
 * - the CSRF token the server hands out with the session (`/api/auth/state`,
 *   sign in, setup, invite accept). Every non-GET request sends it back as
 *   `X-Quiet-Csrf`; the session cookie itself is HttpOnly and never seen here.
 * - whether the session ended while the app was open (a 401 from any API call,
 *   or the stream closing with 4401). The app shell then shows the "session
 *   expired" dialog over the page instead of navigating away.
 */
let csrf: string | null = null
let lost = false
const listeners = new Set<() => void>()

export const CSRF_HEADER = 'x-quiet-csrf'

export function setCsrf(token: string | null) {
  csrf = token
}

export function getCsrf() {
  return csrf
}

function emit() {
  for (const l of listeners) l()
}

export function markSessionLost() {
  if (lost) return
  lost = true
  emit()
}

export function clearSessionLost() {
  if (!lost) return
  lost = false
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useSessionLost = () =>
  useSyncExternalStore(
    subscribe,
    () => lost,
    () => false,
  )

/** For tests: forget everything between renders. */
export function resetSession() {
  csrf = null
  lost = false
  emit()
}

const UNSAFE = /^(POST|PUT|PATCH|DELETE)$/i

/**
 * `fetch` for the quiet API: sends the CSRF token on writes and notices a
 * session that ended (401 `session_expired` / `session_required`).
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? 'GET'
  const headers = new Headers(init.headers)
  if (UNSAFE.test(method) && csrf) headers.set(CSRF_HEADER, csrf)
  const res = await fetch(url, { ...init, headers, credentials: 'same-origin' })
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    const code = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null
    if (code?.code === 'session_expired' || code?.code === 'session_required') markSessionLost()
  }
  return res
}
