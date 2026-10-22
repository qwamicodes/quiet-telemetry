import { describe, expect, it } from 'vitest'
import type { FlowNode, FlowSummary } from '@/gen'
import { flowItems, fmtDuration, laneTag, statusLabel } from '@/lib/flow'

const node = (index: number, name: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  index,
  line_id: index + 1,
  source: 'worker',
  level: 'info',
  ts: 1000 + index * 10 + 5,
  start: 1000 + index * 10,
  duration_ms: 5,
  offset_ms: index * 10,
  name,
  summary: '',
  error: false,
  warn: false,
  attempt: null,
  children: [],
  ...extra,
})

describe('flowItems', () => {
  // picked_up, validate_row ×6 with a warning at #4, completed
  const nodes = [
    node(0, 'picked_up'),
    ...[1, 2, 3, 4, 5, 6].map((i) => node(i, 'validate_row', i === 4 ? { warn: true } : {})),
    node(7, 'completed'),
  ]

  it('folds long runs of the same ok step, never a problem step', () => {
    const items = flowItems(nodes)
    expect(items.map((i) => (i.kind === 'run' ? `run×${i.nodes.length}` : i.node.name))).toEqual([
      'picked_up',
      'validate_row',
      'validate_row',
      'validate_row',
      'validate_row', // the warning stands alone and breaks the run
      'validate_row',
      'validate_row',
      'completed',
    ])
    const long = [node(0, 'a'), ...[1, 2, 3, 4, 5].map((i) => node(i, 'row')), node(6, 'z')]
    const folded = flowItems(long)
    expect(folded.map((i) => i.kind)).toEqual(['node', 'run', 'node'])
    const run = folded[1]
    expect(run.kind === 'run' && run.duration).toBe(1055 - 1010)
    // Expanding one run, or all of them, brings the steps back.
    expect(flowItems(long, { expanded: new Set(['worker:1']) })).toHaveLength(7)
    expect(flowItems(long, { expandAll: true })).toHaveLength(7)
  })

  it('problems only keeps problems plus the first and last step', () => {
    expect(flowItems(nodes, { problemsOnly: true }).map((i) => i.kind === 'node' && i.node.index)).toEqual([0, 4, 7])
  })
})

describe('labels', () => {
  const s = { status: 'ok', retries: 0, warnings: 0, errors: 0 } as FlowSummary
  it('says how the flow went', () => {
    expect(statusLabel(s)).toBe('ok')
    expect(statusLabel({ ...s, status: 'warn', warnings: 2 })).toBe('ok · 2 warnings')
    expect(statusLabel({ ...s, status: 'error', retries: 2 })).toBe('failed after 2 retries')
    expect(statusLabel({ ...s, status: 'error' }, { fields: { status: 500 } } as never)).toBe('500 · failed')
  })
  it('formats durations and lane tags', () => {
    expect(fmtDuration(4)).toBe('4ms')
    expect(fmtDuration(1912)).toBe('1.9s')
    expect(fmtDuration(38_200)).toBe('38s')
    expect(fmtDuration(125_000)).toBe('2m 05s')
    expect(fmtDuration(null)).toBe('–')
    expect(laneTag('legivent-api')).toBe('api')
    expect(laneTag('order-worker')).toBe('wkr')
  })
})
