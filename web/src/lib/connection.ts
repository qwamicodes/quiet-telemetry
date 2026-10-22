import { useSyncExternalStore } from 'react'

/**
 * The live WebSocket's health, app-wide: the stream owns the socket, but the
 * "Can't reach the quiet server" banner sits above the whole app and the
 * sidebar dims its rates while it is down.
 */
export interface ConnectionInfo {
  down: boolean
  /** When the socket closed, unix ms. */
  since: number | null
  attempt: number
  retryAt: number | null
  retry: () => void
}

const idle: ConnectionInfo = { down: false, since: null, attempt: 0, retryAt: null, retry: () => {} }
let current = idle
const listeners = new Set<() => void>()

export function setConnection(next: Partial<ConnectionInfo> | null) {
  current = next == null ? idle : { ...current, ...next }
  for (const l of listeners) l()
}

export function useConnection(): ConnectionInfo {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
    () => idle,
  )
}
