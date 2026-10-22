import { describe, expect, it } from 'vitest'
import type { SourceInfo } from '@/gen'
import { groupOf, groupSources, groupSummary, inGroupFilter } from '@/lib/source-groups'

const NOW = 1_800_000_000_000
const src = (name: string, over: Partial<SourceInfo> = {}): SourceInfo => ({
  name,
  kind: 'docker',
  containers: [],
  group: null,
  group_kind: null,
  lines: 1,
  last_ts: NOW,
  display_name: null,
  hidden: false,
  paused: false,
  ...over,
})

describe('source groups', () => {
  it('uses the server group, else Standalone for docker and Ingest for pushes', () => {
    expect(groupOf(src('api', { group: 'shop', group_kind: 'stack' }))).toEqual({ name: 'shop', kind: 'stack' })
    expect(groupOf(src('redis'))).toEqual({ name: 'Standalone', kind: 'standalone' })
    expect(groupOf(src('pay', { kind: 'otlp' }))).toEqual({ name: 'Ingest', kind: 'ingest' })
  })

  it('orders projects and stacks by name, then Standalone, then Ingest, and counts sending', () => {
    const all = [
      src('push', { kind: 'http' }),
      src('redis'),
      src('web', { group: 'zeta', group_kind: 'compose' }),
      src('api', { group: 'alpha', group_kind: 'stack' }),
      src('worker', { group: 'alpha', group_kind: 'stack', last_ts: NOW - 5 * 60_000 }),
    ]
    const shown = all.filter((s) => s.name !== 'worker')
    const g = groupSources(all, shown, NOW)
    expect(g.map((x) => x.name)).toEqual(['alpha', 'zeta', 'Standalone', 'Ingest'])
    expect(groupSummary(g[0])).toBe('1/2 sending · 1 shown')
    // A group with nothing shown is left out.
    expect(groupSources(all, [all[1]], NOW).map((x) => x.name)).toEqual(['Standalone'])
  })

  it('filters by group kind', () => {
    const stack = src('a', { group: 's', group_kind: 'stack' })
    const compose = src('b', { group: 'c', group_kind: 'compose' })
    const alone = src('c')
    const push = src('d', { kind: 'vector' })
    expect([stack, compose, alone, push].filter((s) => inGroupFilter(s, 'stack'))).toEqual([stack, compose])
    expect([stack, compose, alone, push].filter((s) => inGroupFilter(s, 'standalone'))).toEqual([alone])
    expect([stack, compose, alone, push].filter((s) => inGroupFilter(s, 'all'))).toHaveLength(4)
  })
})
