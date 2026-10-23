import { useSyncExternalStore } from 'react'
import type { CustomGroup, GroupKind, SourceInfo } from '@/gen'
import { isRecent } from '@/lib/format'

type GroupRef = { name: string; kind: GroupKind; id?: string }

/**
 * Sources grouped as Settings → General → Source grouping says (the server
 * fills `group` / `group_kind`): by default the Compose project or Swarm
 * stack, like a container manager's Containers view. Docker containers in no
 * group are "Standalone"; HTTP / Vector / Fluent Bit / OTLP pushes are
 * "Ingest". A source an owner moved into a custom group (Sources → Move to
 * group) has kind `manual` and that group's id. `null` = grouping is off (a
 * flat list).
 */
export function groupOf(s: SourceInfo): GroupRef | null {
  if (!s.group_kind || !s.group) return null
  return { name: s.group, kind: s.group_kind, id: s.group_id }
}

/** The automatic group of a source (where "Automatic" puts it back). */
export function autoGroupOf(s: SourceInfo): GroupRef | null {
  if (s.group_kind === 'manual') {
    return s.auto_group && s.auto_group_kind ? { name: s.auto_group, kind: s.auto_group_kind } : null
  }
  return groupOf(s)
}

/** Custom groups key by id, so a rename keeps collapse state and filters. */
export const groupKey = (g: GroupRef) => (g.kind === 'manual' && g.id ? `manual:${g.id}` : `${g.kind}:${g.name}`)
export const customGroupKey = (id: string) => `manual:${id}`

/** The tag on a group header (`custom` / `compose` / `stack` / `label` / `docker` / `push`). */
export const KIND_TAG: Record<GroupKind, string> = {
  manual: 'custom',
  compose: 'compose',
  stack: 'stack',
  custom: 'label',
  standalone: 'docker',
  ingest: 'push',
}

/** The segmented filter next to Live / Idle / Erroring. */
export type GroupFilter = 'all' | 'custom' | 'standalone' | 'stack'

export function inGroupFilter(s: SourceInfo, f: GroupFilter): boolean {
  if (f === 'all') return true
  const k = groupOf(s)?.kind
  if (!k) return true
  if (f === 'custom') return k === 'manual'
  return f === 'standalone' ? k === 'standalone' : k === 'compose' || k === 'stack' || k === 'custom'
}

export type SourceGroup = {
  key: string
  name: string
  kind: GroupKind
  /** The custom group's id (kind `manual`). */
  id?: string
  /** Sources in the group that pass the current filters, in input order. */
  rows: SourceInfo[]
  /** Every source in the group. */
  total: number
  /** Sources in the group that sent a line recently. */
  sending: number
  /** Automatic groups: sources that would sit here but were moved into a custom group, by group name. */
  moved: Record<string, number>
}

const ORDER: Record<GroupKind, number> = { manual: -1, compose: 0, stack: 0, custom: 0, standalone: 1, ingest: 2 }

/**
 * Groups of `shown`, counted against `all`: custom groups first, in their
 * own order (`custom`, from `/api/sources`), then projects and stacks by
 * name, then Standalone, then Ingest. Groups with nothing shown are left
 * out, except custom groups with `keepEmpty` (a new group nothing was moved
 * into yet still shows on the Sources page). Empty when grouping is off (no
 * source carries a group).
 */
export function groupSources(
  all: SourceInfo[],
  shown: SourceInfo[],
  now = Date.now(),
  custom: CustomGroup[] = [],
  keepEmpty = false,
): SourceGroup[] {
  const map = new Map<string, SourceGroup>()
  const entry = (g: GroupRef) => {
    const key = groupKey(g)
    let e = map.get(key)
    if (!e) {
      e = { key, name: g.name, kind: g.kind, id: g.id, rows: [], total: 0, sending: 0, moved: {} }
      map.set(key, e)
    }
    return e
  }
  const grouped = all.some((s) => groupOf(s))
  if (grouped && keepEmpty) for (const c of custom) entry({ name: c.name, kind: 'manual', id: c.id })
  for (const s of all) {
    const g = groupOf(s)
    if (!g) continue
    const e = entry(g)
    e.total += 1
    if (isRecent(s.last_ts, now)) e.sending += 1
  }
  // "4 moved to Legivent staging" on the automatic group they left.
  for (const s of all) {
    if (s.group_kind !== 'manual' || !s.group) continue
    const auto = autoGroupOf(s)
    const e = auto && map.get(groupKey(auto))
    if (e) e.moved[s.group] = (e.moved[s.group] ?? 0) + 1
  }
  const names = new Set(shown.map((s) => s.name))
  for (const s of all) {
    if (!names.has(s.name)) continue
    const g = groupOf(s)
    if (g) map.get(groupKey(g))?.rows.push(s)
  }
  const at = (g: SourceGroup) => {
    const i = custom.findIndex((c) => c.id === g.id)
    return i < 0 ? custom.length : i
  }
  return [...map.values()]
    .filter((g) => g.rows.length > 0 || (keepEmpty && g.kind === 'manual' && g.total === 0))
    .sort(
      (a, b) =>
        ORDER[a.kind] - ORDER[b.kind] ||
        (a.kind === 'manual' && b.kind === 'manual' ? at(a) - at(b) : 0) ||
        a.name.localeCompare(b.name),
    )
}

/** `4 moved to Legivent staging` / `5 moved to 2 groups`, or null. */
export function movedNote(g: SourceGroup): string | null {
  const entries = Object.entries(g.moved)
  if (entries.length === 0) return null
  const n = entries.reduce((a, [, c]) => a + c, 0)
  return entries.length === 1 ? `${n} moved to ${entries[0][0]}` : `${n} moved to ${entries.length} groups`
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
