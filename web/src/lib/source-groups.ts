import { useSyncExternalStore } from 'react'
import type { GroupKind, SourceInfo } from '@/gen'
import { isRecent } from '@/lib/format'

/**
 * Sources grouped as Settings → General → Source grouping says (the server
 * fills `group` / `group_kind`): by default the Compose project or Swarm
 * stack, like a container manager's Containers view. Docker containers in no
 * group are "Standalone"; HTTP / Vector / Fluent Bit / OTLP pushes are
 * "Ingest". `null` = grouping is off (a flat list).
 */
export function groupOf(s: SourceInfo): { name: string; kind: GroupKind } | null {
  if (!s.group_kind || !s.group) return null
  return { name: s.group, kind: s.group_kind }
}

export const groupKey = (g: { name: string; kind: GroupKind }) => `${g.kind}:${g.name}`

/** The tag on a group header (`compose` / `stack` / `label` / `docker` / `push`). */
export const KIND_TAG: Record<GroupKind, string> = {
  compose: 'compose',
  stack: 'stack',
  custom: 'label',
  standalone: 'docker',
  ingest: 'push',
}

/** The segmented filter next to Live / Idle / Erroring. */
export type GroupFilter = 'all' | 'standalone' | 'stack'

export function inGroupFilter(s: SourceInfo, f: GroupFilter): boolean {
  if (f === 'all') return true
  const k = groupOf(s)?.kind
  if (!k) return true
  return f === 'standalone' ? k === 'standalone' : k === 'compose' || k === 'stack' || k === 'custom'
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

const ORDER: Record<GroupKind, number> = { compose: 0, stack: 0, custom: 0, standalone: 1, ingest: 2 }

/**
 * Groups of `shown`, counted against `all`: projects and stacks by name, then
 * Standalone, then Ingest. Groups with nothing shown are left out. Empty
 * when grouping is off (no source carries a group).
 */
export function groupSources(all: SourceInfo[], shown: SourceInfo[], now = Date.now()): SourceGroup[] {
  const map = new Map<string, SourceGroup>()
  for (const s of all) {
    const g = groupOf(s)
    if (!g) continue
    const key = groupKey(g)
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
    if (g) map.get(groupKey(g))?.rows.push(s)
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

function write(next: string[]) {
  snapshot = next
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot))
  } catch {
    // storage blocked: collapse still works for this page load
  }
  for (const fn of listeners) fn()
}

export function toggleGroup(key: string) {
  const cur = get()
  write(cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key])
}

export function setGroupCollapsed(key: string, collapsed: boolean) {
  const cur = get().filter((k) => k !== key)
  write(collapsed ? [...cur, key] : cur)
}

/** Collapse every key given, or expand them all when they are all collapsed already. */
export function toggleAllGroups(keys: string[]) {
  const cur = get()
  const allFolded = keys.length > 0 && keys.every((k) => cur.includes(k))
  write(allFolded ? cur.filter((k) => !keys.includes(k)) : [...new Set([...cur, ...keys])])
}

/** Test hook: forget the cached copy (after clearing localStorage). */
export function resetCollapsedGroups() {
  snapshot = null
}

/** Collapsed group keys, kept per browser in localStorage. */
export function useCollapsedGroups() {
  const collapsed = useSyncExternalStore(subscribe, get, get)
  return {
    isCollapsed: (key: string) => collapsed.includes(key),
    toggle: toggleGroup,
    set: setGroupCollapsed,
    toggleAll: toggleAllGroups,
    allCollapsed: (keys: string[]) => keys.length > 0 && keys.every((k) => collapsed.includes(k)),
  }
}

/** Status of one source for dots: paused, sending (a line in the last 60 s), or idle. */
export function sourceStatus(s: SourceInfo, now = Date.now()): 'ok' | 'warn' | 'idle' {
  if (s.paused) return 'warn'
  return isRecent(s.last_ts, now) ? 'ok' : 'idle'
}

/** Sum of the rates of a group's sources, lines/s. */
export function groupRate(rows: SourceInfo[], rates: Record<string, number>): number {
  return rows.reduce((a, s) => a + (rates[s.name] ?? 0), 0)
}
