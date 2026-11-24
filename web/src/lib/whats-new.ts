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
/**
 * Where a change shows: a screen, or a part of one (`guide.agent`). Parents
 * roll up as `updated`; visiting a screen clears the changes under it.
 */
export type Target =
  | 'stream'
  | 'flow'
  | 'flow.fieldcard'
  | 'search'
  | 'sources'
  | 'settings'
  | 'settings.appearance'
  | 'guide'
  | 'guide.agent'
  | 'guide.agent.templates'
  | 'guide.agent.examples'
  | 'guide.canonical'
  | 'guide.canonical.context'
  | 'guide.canonical.redaction'
  | 'guide.canonical.levels'
  | 'guide.ids'
  | 'guide.check'

export interface Change {
  id: string
  kind: ChangeKind
  target: Target
  /** "Changes to your logs" (what your code writes) or "Changes to quiet". */
  area: 'logs' | 'app'
  title: string
  /** Mono line: the fields that changed (logs only). */
  fields?: string
  /** One plain sentence under the title (logs only). */
  summary?: string
  /** Where the row opens (quiet changes): label and path. */
  open?: { label: string; to: '/' | '/guide'; tab?: 'agent' | 'check' | 'canonical' }
}

export const RELEASE = '0.1.1'
export const PREVIOUS = '0.1.0'
/** Release date, shown in the sheet header. */
export const RELEASED = '23 Nov 2026'
export const CHANGELOG_URL = 'https://github.com/qwamicodes/quiet-telemetry/blob/main/CHANGELOG.md'

export const CHANGES: Change[] = [
  {
    id: 'event-shape',
    kind: 'updated',
    target: 'guide.canonical',
    area: 'logs',
    title: 'One event shape for every request and job',
    fields:
      'status → status_code · msg → flow · outcome → level + error · wideEvents.calls → removed, add fields directly',
    summary: 'Old lines keep working in Stream, Flow and Search.',
  },
  {
    id: 'context',
    kind: 'new',
    target: 'guide.canonical.context',
    area: 'logs',
    title: 'Request and response context',
    fields: 'request.headers · params · query · route · response.headers · body_capture: disabled | truncated',
    summary: 'Bodies stay off until you allow them per route. 8 KB per body, 32 KB per event.',
  },
  {
    id: 'redaction',
    kind: 'new',
    target: 'guide.canonical.redaction',
    area: 'logs',
    title: 'Sensitive values are marked [REDACTED]',
    summary:
      'Passwords, tokens, cookies and fields you choose are removed before the log is written. Email and phone stay visible unless you hide them.',
  },
  {
    id: 'levels-jobs',
    kind: 'updated',
    target: 'guide.canonical.levels',
    area: 'logs',
    title: 'Levels and job ids',
    summary:
      "error for a recorded error or HTTP ≥400, warn for slow successes, info otherwise. Jobs keep the queue's own id plus its queue: payout-88-1300 on payouts.",
  },
  {
    id: 'prompt-setup',
    kind: 'updated',
    target: 'guide.agent',
    area: 'app',
    title: 'Prompt setup: language, goals and privacy in one place',
    open: { label: 'Guide', to: '/guide', tab: 'agent' },
  },
  {
    id: 'templates',
    kind: 'new',
    target: 'guide.agent.templates',
    area: 'app',
    title: '20 product templates for SLO goals',
    open: { label: 'Guide', to: '/guide', tab: 'agent' },
  },
  {
    id: 'examples',
    kind: 'new',
    target: 'guide.agent.examples',
    area: 'app',
    title: 'Examples for TypeScript, Python, Go and Rust',
    open: { label: 'Guide', to: '/guide', tab: 'agent' },
  },
  {
    id: 'check-logs',
    kind: 'updated',
    target: 'guide.check',
    area: 'app',
    title: 'Check my logs: 12 checks for the new format',
    open: { label: 'Guide', to: '/guide', tab: 'check' },
  },
  {
    id: 'field-card',
    kind: 'updated',
    target: 'flow.fieldcard',
    area: 'app',
    title: 'Field card groups Request, Response and Context',
    open: { label: 'Stream', to: '/' },
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

/** Visiting a screen (or tab) marks the changes on it, and on its parts, as seen. */
export function useSeenOnVisit(target: Target | null) {
  const { unseen, markSeen } = useWhatsNew()
  const ids = target ? unseen.filter((c) => under(c.target, target)).map((c) => c.id) : []
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
