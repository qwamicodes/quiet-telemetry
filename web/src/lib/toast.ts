import type { ReactNode } from 'react'

export type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading'

export interface ToastOpts {
  description?: ReactNode
  /** ms; `null` stays until dismissed. Default 4s (loading: until dismissed). */
  duration?: number | null
  /** One action. A trailing "⌘Z" in the title renders as keycaps. */
  button?: { title: string; onClick: () => void }
  /** Replaces the type's icon (the mute toast uses eye-off, 03.17). */
  icon?: ReactNode
}

export interface ToastItem extends ToastOpts {
  id: string
  type: ToastType
  title: string
}

const DEFAULT_MS = 4000
let items: ToastItem[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const toastStore = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  get: () => items,
}

function show(type: ToastType, title: string, o: ToastOpts = {}): string {
  const id = `t${++seq}`
  const duration = o.duration === undefined ? (type === 'loading' ? null : DEFAULT_MS) : o.duration
  // Newest last; at most 4 on screen.
  items = [...items, { ...o, id, type, title, duration }].slice(-4)
  emit()
  return id
}

function dismiss(id: string) {
  const next = items.filter((t) => t.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

/**
 * The one place the app raises toasts (08.3): a bordered card with a small
 * outline icon, the title, a muted description, an optional action, and a
 * countdown when it times out. Call sites read `toast.success('Copied', { description })`.
 */
export const toast = {
  success: (title: string, o?: ToastOpts) => show('success', title, o),
  error: (title: string, o?: ToastOpts) => show('error', title, o),
  info: (title: string, o?: ToastOpts) => show('info', title, o),
  warning: (title: string, o?: ToastOpts) => show('warning', title, o),
  loading: (title: string, o?: ToastOpts) => show('loading', title, o),
  dismiss,
}
