import { describe, expect, it } from 'vitest'
import { fmtRangeField, parseRangeField } from '@/components/search/time-range'

const now = new Date(2026, 10, 23, 14, 30).getTime()

describe('custom range fields (05.2)', () => {
  it('reads now, today, yesterday, a bare time, ISO and month-day', () => {
    expect(parseRangeField('now', now)).toBeUndefined()
    expect(parseRangeField('', now)).toBeUndefined()
    expect(parseRangeField('today 08:07', now)).toBe(new Date(2026, 10, 23, 8, 7).getTime())
    expect(parseRangeField('08:07', now)).toBe(new Date(2026, 10, 23, 8, 7).getTime())
    expect(parseRangeField('yesterday 22:10', now)).toBe(new Date(2026, 10, 22, 22, 10).getTime())
    expect(parseRangeField('2026-11-21 09:00', now)).toBe(new Date(2026, 10, 21, 9, 0).getTime())
    expect(parseRangeField('Nov 20 14:07', now)).toBe(new Date(2026, 10, 20, 14, 7).getTime())
    expect(parseRangeField('Dec 31 10:00', now)).toBe(new Date(2025, 11, 31, 10, 0).getTime())
    expect(parseRangeField('soon', now)).toBeNull()
    expect(parseRangeField('25:00', now)).toBeNull()
  })

  it('writes what it reads', () => {
    const t = new Date(2026, 10, 23, 8, 7).getTime()
    expect(fmtRangeField(t, now)).toBe('today 08:07')
    expect(parseRangeField(fmtRangeField(t, now), now)).toBe(t)
    expect(fmtRangeField(new Date(2026, 10, 22, 22, 10).getTime(), now)).toBe('yesterday 22:10')
    expect(fmtRangeField(new Date(2026, 10, 20, 14, 7).getTime(), now)).toBe('Nov 20 14:07')
  })
})
