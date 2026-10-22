import { describe, expect, it } from 'vitest'
import type { LogLine } from '@/gen'
import { groupByFlow, highlight, joinQuery, notableFields, splitQuery, terms } from '@/lib/query'

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
