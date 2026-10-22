import { describe, expect, it } from 'vitest'
import type { FlowSummary, LogLine } from '@/gen'
import { displayIds, groupByFlow, highlight, joinQuery, notableFields, splitQuery, terms } from '@/lib/query'

const line = (
  id: number,
  rid: string | null,
  level: LogLine['level'],
  fields: Record<string, unknown> = {},
): LogLine => ({
  id,
  ts: 1000 + id,
  received: 1000 + id,
  source: id > 2 ? 'worker' : 'api',
  level,
  display_id: rid ? { key: 'request_id', value: rid } : null,
  ids: rid ? [{ key: 'request_id', value: rid }] : [],
  msg: `m${id}`,
  fields,
  raw: '{}',
})

describe('query helpers', () => {
  it('splits chips from free text and joins them back', () => {
    expect(splitQuery('dealer level:>=warn 88 -path:/health GET /a:b')).toEqual({
      chips: ['level:>=warn', '-path:/health'],
      text: 'dealer 88 GET /a:b',
    })
    expect(joinQuery(['source:api'], ' slow ')).toBe('source:api slow')
    expect(terms('Dealer -noise "a b" status:500 x')).toEqual(['dealer', 'a b'])
  })

  it('groups by the shown id, worst level and sources', () => {
    const g = groupByFlow([line(1, 'r1', 'info'), line(3, 'r1', 'error'), line(2, null, 'warn')])
    expect(g.map((x) => [x.key, x.lines.length, x.worst, x.sources])).toEqual([
      ['request_id:r1', 2, 'error', ['api', 'worker']],
      ['line:2', 1, 'warn', ['api']],
    ])
  })

  it('picks matching fields first and highlights words', () => {
    const l = line(1, 'r1', 'info', { dealer_id: 88, status: 200, msg: 'x', user: { plan: 'pro' } })
    expect(notableFields(l, ['88'])).toEqual([
      ['dealer_id', '88'],
      ['status', '200'],
    ])
    expect(highlight('GET /dealers/88', ['dealer'])).toEqual([
      { s: 'GET /', hit: false },
      { s: 'dealer', hit: true },
      { s: 's/88', hit: false },
    ])
  })
})

describe('groupByFlow with flow summaries', () => {
  it('merges groups whose ids stitch into one flow, in order of first match', () => {
    const job: LogLine = {
      ...line(9, null, 'error'),
      display_id: { key: 'job_id', value: 'payout:1' },
      ids: [{ key: 'job_id', value: 'payout:1' }],
    }
    const lines = [job, line(2, 'req_2', 'info'), line(1, 'req_1', 'warn')]
    const flow = { key: '1', line_count: 5 } as FlowSummary
    const summaries = new Map<string, FlowSummary | null>([
      ['req_1', flow],
      ['payout:1', flow],
      ['req_2', null],
    ])
    const groups = groupByFlow(lines, summaries)
    expect(groups.map((g) => g.lines.map((l) => l.id))).toEqual([[9, 1], [2]])
    expect(groups[0].summary).toBe(flow)
    expect(groups[0].worst).toBe('error')
    // Without summaries: one group per display id.
    expect(groupByFlow(lines)).toHaveLength(3)
    expect(displayIds(lines)).toEqual(['payout:1', 'req_2', 'req_1'])
  })
})
