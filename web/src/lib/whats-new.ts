import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { WhatsNew, WhatsNewUpdate } from '@/gen'
import { fetchJson } from '@/lib/api'

/**
 * What's new (v0.1.1-00.1 … 00.4): one list of changes per release feeds the
 * sheet, the version-chip dot, every `new` / `updated` marker and the
 * one-time banner. The server keeps what each account has seen.
 */
export type ChangeKind = 'new' | 'updated'
/** Where a change shows: a screen, or a part of one (`guide.agent`). Parents roll up. */
export type Target =
  | 'stream'
  | 'flow'
  | 'search'
  | 'sources'
  | 'settings'
  | 'settings.appearance'
  | 'guide'
  | 'guide.agent'
  | 'guide.canonical'
  | 'guide.ids'
  | 'guide.check'

export interface Change {
  id: string
  kind: ChangeKind
  target: Target
  /** "Changes to your logs" (what your code writes) or "Changes to quiet". */
  area: 'logs' | 'app'
  title: string
  summary: string
}

export const RELEASE = '0.1.1'

export const CHANGES: Change[] = [
  {
    id: 'event-shape',
    kind: 'updated',
    target: 'guide.canonical',
    area: 'logs',
    title: 'One canonical event per request or job attempt',
    summary:
      'Write flow, status_code and duration_ms when the work ends. outcome, msg-only lines and wideEvents.calls are no longer part of the contract; records that still use them keep working.',
  },
  {
    id: 'context',
    kind: 'new',
    target: 'guide.canonical',
    area: 'logs',
    title: 'Request and response context',
    summary:
      'request and response carry headers, params, query and route; body_capture says when a body was left out or cut.',
  },
  {
    id: 'redaction',
    kind: 'new',
    target: 'sources',
    area: 'logs',
    title: 'Credentials are [REDACTED] before storage',
    summary:
      'Passwords, tokens, auth headers and cookies are replaced before quiet stores a line. A source can add its own keys and hide email or phone.',
  },
  {
    id: 'levels-jobs',
    kind: 'updated',
    target: 'guide.ids',
    area: 'logs',
    title: 'Levels and job ids',
    summary:
      'error for a recorded error or HTTP ≥ 400, warn for a slow success. Jobs keep the queue’s own job_id with queue and attempt.',
  },
  {
    id: 'guide-agent',
    kind: 'updated',
    target: 'guide.agent',
    area: 'app',
    title: 'Instrument with an agent',
    summary: 'Set up your app and goals, pick from 20 templates, then review and copy a prompt made for it.',
  },
  {
    id: 'check-logs',
    kind: 'updated',
    target: 'guide.check',
    area: 'app',
    title: 'Check my logs scores v0.1.1',
    summary: 'Each check says what to change, and a Fix with your agent prompt is built from the findings.',
  },
  {
    id: 'flow-activity',
    kind: 'updated',
    target: 'flow',
    area: 'app',
    title: 'Flows open as an activity list',
    summary: 'One row per request and per job, attempts inside. The timeline and graph moved behind Timing.',
  },
  {
    id: 'appearance',
    kind: 'new',
    target: 'settings.appearance',
    area: 'app',
    title: 'Appearance',
    summary: 'Light, dark or system theme, row density, wrap, error-row tint and accent, saved to this browser.',
  },
  {
    id: 'phone',
    kind: 'new',
    target: 'stream',
    area: 'app',
    title: 'Works on a phone',
    summary: 'A tab bar, two-line stream cards and a flow with its field card in a bottom sheet.',
  },
]

// ---- server state --------------------------------------------------------------------

export const whatsNew = z.object({
  release: z.string(),
  eligible: z.boolean(),
  since: z.number(),
  seen: z.array(z.string()),
  banner_dismissed: z.boolean(),
}) satisfies z.ZodType<WhatsNew>

export const whatsNewQuery = queryOptions({
  queryKey: ['whats-new'],
  queryFn: ({ signal }) => fetchJson('/api/whats-new', whatsNew, { signal }),
  staleTime: 60_000,
})

const put = (body: WhatsNewUpdate) =>
  fetchJson('/api/whats-new', whatsNew, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// ---- markers ---------------------------------------------------------------------------

const under = (target: string, parent: string) => target === parent || target.startsWith(`${parent}.`)

/**
 * The marker for a screen or part of one: its own unseen change's kind, else
 * `updated` when something under it is unseen (roll-up), else none. One
 * marker per item.
 */
export function markerFor(target: Target, unseen: Change[]): ChangeKind | null {
  const own = unseen.find((c) => c.target === target)
  if (own) return own.kind
  return unseen.some((c) => under(c.target, target)) ? 'updated' : null
}

export function useWhatsNew() {
  const qc = useQueryClient()
  const q = useQuery(whatsNewQuery)
  const m = useMutation({
    mutationFn: put,
    onSuccess: (d) => qc.setQueryData(whatsNewQuery.queryKey, d),
  })
  const state = q.data
  // Only accounts from before the upgrade see markers, and only for this list.
  const active = !!state && state.eligible && state.release === RELEASE
  const unseen = active ? CHANGES.filter((c) => !state.seen.includes(c.id)) : []
  const { mutate } = m
  const markSeen = useCallback(
    (ids: string[]) => {
      if (!active || !state) return
      const fresh = ids.filter((id) => !state.seen.includes(id))
      if (fresh.length) mutate({ seen: fresh })
    },
    [active, state, mutate],
  )
  return {
    active,
    unseen,
    showBanner: active && !state.banner_dismissed,
    marker: (target: Target) => markerFor(target, unseen),
    markSeen,
    markAllSeen: () => markSeen(CHANGES.map((c) => c.id)),
    dismissBanner: () => {
      if (active) mutate({ banner_dismissed: true })
    },
  }
}

/** Visiting a screen (or tab) marks the changes that point exactly at it as seen. */
export function useSeenOnVisit(target: Target | null) {
  const { unseen, markSeen } = useWhatsNew()
  const ids = target ? unseen.filter((c) => c.target === target).map((c) => c.id) : []
  const key = ids.join(',')
  useEffect(() => {
    if (key) markSeen(key.split(','))
  }, [key, markSeen])
}

// ---- the sheet's open state (sidebar chip, banner, ⌘K) ------------------------------------

let sheetOpen = false
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}
export function setWhatsNewOpen(open: boolean) {
  sheetOpen = open
  emit()
}
export function useWhatsNewOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => sheetOpen,
    () => false,
  )
  return [open, setWhatsNewOpen]
}
