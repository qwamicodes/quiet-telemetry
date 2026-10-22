import { describe, expect, it } from 'vitest'
import { flowSearch, streamSearch } from '@/lib/search-params'

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
})
