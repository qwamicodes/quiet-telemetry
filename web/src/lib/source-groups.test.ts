import { afterEach, describe, expect, it } from 'vitest'
import type { GroupKind, SourceInfo } from '@/gen'
import {
  groupOf,
  groupSources,
  groupSummary,
  inGroupFilter,
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
