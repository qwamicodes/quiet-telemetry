import { afterEach, describe, expect, it } from 'vitest'
import type { GroupKind, SourceInfo } from '@/gen'
import {
  autoGroupOf,
  groupOf,
  groupSources,
  groupSummary,
  inGroupFilter,
  movedNote,
  resetCollapsedGroups,
  toggleAllGroups,
  toggleGroup,
} from '@/lib/source-groups'

const NOW = 1_800_000_000_000
const src = (name: string, over: Partial<SourceInfo> = {}): SourceInfo => ({
  name,
  kind: 'docker',
  containers: [],
  group: 'Standalone',
  group_kind: 'standalone',
  lines: 1,
  last_ts: NOW,
  display_name: null,
  hidden: false,
  paused: false,
  ...over,
})
const g = (group: string, group_kind: GroupKind) => ({ group, group_kind })

afterEach(() => {
  localStorage.clear()
  resetCollapsedGroups()
})

describe('source groups', () => {
  it('reads the server group; null means grouping is off', () => {
    expect(groupOf(src('api', g('shop', 'stack')))).toEqual({ name: 'shop', kind: 'stack' })
    expect(groupOf(src('redis'))).toEqual({ name: 'Standalone', kind: 'standalone' })
    expect(groupOf(src('x', { group: null, group_kind: null }))).toBeNull()
    expect(groupSources([src('x', { group: null, group_kind: null })], [])).toEqual([])
  })

  it('orders projects and stacks by name, then Standalone, then Ingest, and counts sending (60 s)', () => {
    const all = [
      src('push', { kind: 'http', ...g('Ingest', 'ingest') }),
      src('redis'),
      src('web', g('zeta', 'compose')),
      src('api', g('alpha', 'stack')),
      src('worker', { ...g('alpha', 'stack'), last_ts: NOW - 61_000 }),
    ]
    const shown = all.filter((s) => s.name !== 'worker')
    const groups = groupSources(all, shown, NOW)
    expect(groups.map((x) => x.name)).toEqual(['alpha', 'zeta', 'Standalone', 'Ingest'])
    expect(groupSummary(groups[0])).toBe('1/2 sending · 1 shown')
    // A group with nothing shown is left out.
    expect(groupSources(all, [all[1]], NOW).map((x) => x.name)).toEqual(['Standalone'])
  })

  it('filters by group kind; custom-label groups count as Compose / Stack', () => {
    const stack = src('a', g('s', 'stack'))
    const compose = src('b', g('c', 'compose'))
    const custom = src('e', g('payments', 'custom'))
    const alone = src('c')
    const push = src('d', { kind: 'vector', ...g('Ingest', 'ingest') })
    const all = [stack, compose, custom, alone, push]
    expect(all.filter((s) => inGroupFilter(s, 'stack'))).toEqual([stack, compose, custom])
    expect(all.filter((s) => inGroupFilter(s, 'standalone'))).toEqual([alone])
    expect(all.filter((s) => inGroupFilter(s, 'all'))).toHaveLength(5)
  })

  it('collapse state is one shared list in localStorage; collapse all toggles back', () => {
    toggleGroup('compose:a')
    expect(JSON.parse(localStorage.getItem('quiet.source-groups.collapsed') ?? '[]')).toEqual(['compose:a'])
    toggleAllGroups(['compose:a', 'compose:b'])
    expect(JSON.parse(localStorage.getItem('quiet.source-groups.collapsed') ?? '[]')).toEqual([
      'compose:a',
      'compose:b',
    ])
    toggleAllGroups(['compose:a', 'compose:b'])
    expect(JSON.parse(localStorage.getItem('quiet.source-groups.collapsed') ?? '[]')).toEqual([])
  })
})

describe('custom groups', () => {
  const custom = [
    { id: 'g_b', name: 'Zed first', order: 0 },
    { id: 'g_a', name: 'Apps', order: 1 },
    { id: 'g_e', name: 'Empty', order: 2 },
  ]
  const moved = (name: string, id: string, gname: string, auto = 'Standalone') =>
    src(name, { group: gname, group_kind: 'manual', group_id: id, auto_group: auto, auto_group_kind: 'standalone' })
  const all = [
    src('redis'),
    moved('staging-api', 'g_a', 'Apps'),
    moved('staging-bot', 'g_a', 'Apps'),
    moved('edge', 'g_b', 'Zed first'),
    src('web', g('alpha', 'compose')),
  ]

  it('puts custom groups first in their own order, keys them by id and notes what moved', () => {
    const groups = groupSources(all, all, NOW, custom)
    expect(groups.map((x) => x.name)).toEqual(['Zed first', 'Apps', 'alpha', 'Standalone'])
    expect(groups[1].key).toBe('manual:g_a')
    expect(movedNote(groups[3])).toBe('3 moved to 2 groups')
    expect(movedNote(groupSources(all.slice(0, 3), all.slice(0, 3), NOW, custom)[1])).toBe('2 moved to Apps')
    expect(autoGroupOf(all[1])).toEqual({ name: 'Standalone', kind: 'standalone' })
  })

  it('keeps an empty custom group only when asked, and filters by Custom', () => {
    expect(groupSources(all, all, NOW, custom).some((x) => x.name === 'Empty')).toBe(false)
    expect(groupSources(all, all, NOW, custom, true).map((x) => x.name)).toContain('Empty')
    expect(all.filter((s) => inGroupFilter(s, 'custom')).map((s) => s.name)).toEqual([
      'staging-api',
      'staging-bot',
      'edge',
    ])
    expect(inGroupFilter(all[1], 'stack')).toBe(false)
    // Grouping off: no groups, even kept custom ones.
    const flat = [src('x', { group: null, group_kind: null })]
    expect(groupSources(flat, flat, NOW, custom, true)).toEqual([])
  })
})
