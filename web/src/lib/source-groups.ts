import { useSyncExternalStore } from 'react'
import type { GroupKind, SourceInfo } from '@/gen'
import { isRecent } from '@/lib/format'

/**
 * Sources grouped by their Docker stack (Compose project or Swarm stack),
 * like a container manager's Containers view. Docker containers in no project
 * are "Standalone"; HTTP / Vector / Fluent Bit / OTLP pushes are "Ingest".
 * The server fills `group` / `group_kind`; the fallbacks cover an older server.
 */
export function groupOf(s: SourceInfo): { name: string; kind: GroupKind } {
  if (s.group_kind && s.group) return { name: s.group, kind: s.group_kind }
  if (s.kind !== 'docker') return { name: 'Ingest', kind: 'ingest' }
  return { name: 'Standalone', kind: 'standalone' }
}

/** The segmented filter next to Live / Idle / Erroring. */
export type GroupFilter = 'all' | 'standalone' | 'stack'

export function inGroupFilter(s: SourceInfo, f: GroupFilter): boolean {
  if (f === 'all') return true
  const k = groupOf(s).kind
  return f === 'standalone' ? k === 'standalone' : k === 'compose' || k === 'stack'
}

export type SourceGroup = {
  key: string
  name: string
  kind: GroupKind
  /** Sources in the group that pass the current filters, in input order. */
  rows: SourceInfo[]
  /** Every source in the group. */
  total: number
  /** Sources in the group that sent a line recently. */
  sending: number
}

const ORDER: Record<GroupKind, number> = { compose: 0, stack: 0, standalone: 1, ingest: 2 }

/**
 * Groups of `shown`, counted against `all`: projects and stacks by name, then
 * Standalone, then Ingest. Groups with nothing shown are left out.
 */
export function groupSources(all: SourceInfo[], shown: SourceInfo[], now = Date.now()): SourceGroup[] {
  const map = new Map<string, SourceGroup>()
  for (const s of all) {
    const g = groupOf(s)
    const key = `${g.kind}:${g.name}`
    let e = map.get(key)
    if (!e) {
      e = { key, name: g.name, kind: g.kind, rows: [], total: 0, sending: 0 }
      map.set(key, e)
    }
    e.total += 1
    if (isRecent(s.last_ts, now)) e.sending += 1
  }
  const names = new Set(shown.map((s) => s.name))
  for (const s of all) {
    if (!names.has(s.name)) continue
    const g = groupOf(s)
    map.get(`${g.kind}:${g.name}`)?.rows.push(s)
  }
  return [...map.values()]
    .filter((g) => g.rows.length > 0)
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name))
}

/** `11/12 sending · 12 shown` */
export const groupSummary = (g: SourceGroup) => `${g.sending}/${g.total} sending · ${g.rows.length} shown`

const KEY = 'quiet.source-groups.collapsed'

function readCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

// One shared copy, so the sidebar and the Sources page collapse together.
let snapshot: string[] | null = null
const listeners = new Set<() => void>()
const get = () => {
  snapshot ??= readCollapsed()
  return snapshot
}
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function toggleGroup(key: string) {
  const cur = get()
  snapshot = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot))
  } catch {
    // storage blocked: collapse still works for this page load
  }
  for (const fn of listeners) fn()
}

/** Test hook: forget the cached copy (after clearing localStorage). */
export function resetCollapsedGroups() {
  snapshot = null
}

/** Collapsed group keys, kept per browser in localStorage. */
export function useCollapsedGroups() {
  const collapsed = useSyncExternalStore(subscribe, get, get)
  return { isCollapsed: (key: string) => collapsed.includes(key), toggle: toggleGroup }
}
