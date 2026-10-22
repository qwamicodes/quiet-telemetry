import { describe, expect, it } from 'vitest'
import { flowParams, flowSearch, lineParams, streamSearch } from '@/lib/search-params'

describe('route search params', () => {
  it('keeps valid stream params', () => {
    expect(streamSearch.parse({ source: 'api', level: 'warn', q: 'slow' })).toEqual({
      source: 'api',
      level: 'warn',
      q: 'slow',
    })
  })

  it('falls back on bad values instead of throwing', () => {
    expect(streamSearch.parse({ source: '', level: 'loud', q: 42 })).toEqual({})
    expect(streamSearch.parse({})).toEqual({})
    expect(flowSearch.parse({ line: 'abc' })).toEqual({})
    expect(flowSearch.parse({ line: '12' })).toEqual({ line: 12 })
  })

  it('path params: a flow id is any non-empty id up to 256 chars; a line id is a positive integer', () => {
    expect(flowParams.parse({ id: ' payout:88:1300 ' })).toEqual({ id: 'payout:88:1300' })
    expect(flowParams.safeParse({ id: '  ' }).success).toBe(false)
    expect(flowParams.safeParse({ id: 'x'.repeat(257) }).success).toBe(false)
    expect(lineParams.parse({ lineId: '42' })).toEqual({ lineId: 42 })
    expect(lineParams.safeParse({ lineId: 'abc' }).success).toBe(false)
    expect(lineParams.safeParse({ lineId: '-1' }).success).toBe(false)
  })
})
