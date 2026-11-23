import { describe, expect, it } from 'vitest'
import { filterSummary } from '@/components/mobile/mobile-stream'

describe('filterSummary (10.1 "warn+ · 2 filters")', () => {
  it('names the level floor and counts the filters', () => {
    expect(filterSummary(['warn', 'error'], 2)).toBe('warn+ · 2 filters')
    expect(filterSummary(['error'], 0)).toBe('error')
    expect(filterSummary(['info', 'warn', 'error'], 1)).toBe('info+ · 1 filter')
  })

  it('every level, or none picked, says nothing about levels', () => {
    expect(filterSummary([], 0)).toBe('')
    expect(filterSummary(['debug', 'info', 'warn', 'error'], 0)).toBe('')
    expect(filterSummary([], 3)).toBe('3 filters')
  })

  it('a gap in the levels lists them', () => {
    expect(filterSummary(['debug', 'error'], 0)).toBe('debug, error')
  })
})
