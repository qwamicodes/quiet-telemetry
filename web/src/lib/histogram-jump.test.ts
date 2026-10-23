import { describe, expect, it } from 'vitest'
import type { LogLine } from '@/gen'
import {
  anchoredBounds,
  anchorFor,
  barAt,
  barWidth,
  bufferCovers,
  historyQuery,
  jumpIndex,
  loadedSpan,
  mergeHistory,
  nearestIndex,
} from '@/lib/histogram-jump'

const M = 60_000
const T = 1_760_000_000_000 - (1_760_000_000_000 % M)
const line = (id: number, ts: number): LogLine => ({
  id,
  ts,
  received: ts,
  source: 'api',
  level: 'info',
  display_id: null,
  ids: [],
  msg: `line ${id}`,
  fields: undefined,
  raw: `line ${id}`,
})
const minute = (k: number) => ({ from: T + k * M, to: T + (k + 1) * M })

describe('jumpIndex / nearestIndex', () => {
  const rows = [line(1, T + 5), line(2, T + M + 10), line(3, T + M + 20), line(4, T + 3 * M)]
  it('finds the first row of the minute in display order', () => {
    expect(jumpIndex(rows, minute(1))).toBe(1)
    // Newest on top: the minute's newest row comes first.
    expect(jumpIndex([...rows].reverse(), minute(1))).toBe(1)
    expect(jumpIndex(rows, minute(2))).toBe(-1)
  })
  it('falls back to the first row after the minute, else the last before it', () => {
    expect(nearestIndex(rows, minute(2))).toBe(3)
    expect(nearestIndex(rows, minute(9))).toBe(3)
    expect(nearestIndex(rows.slice(1), { from: T, to: T + 1 })).toBe(0)
    expect(nearestIndex([], minute(0))).toBe(-1)
  })
  it('skips rows without a time (search group headers)', () => {
    expect(jumpIndex([{ ts: Number.NaN }, { ts: T + M }], minute(1))).toBe(1)
    expect(nearestIndex([{ ts: Number.NaN }, { ts: T + 5 * M }], minute(1))).toBe(1)
  })
})

describe('bufferCovers', () => {
  it('is true only when the buffer starts before the minute', () => {
    expect(bufferCovers([line(1, T + 10), line(2, T + M + 5)], minute(1))).toBe(true)
    // The buffer starts inside the minute: its first lines may have fallen off.
    expect(bufferCovers([line(1, T + M + 5)], minute(1))).toBe(false)
    expect(bufferCovers([line(1, T + 5 * M)], minute(1))).toBe(false)
    expect(bufferCovers([], minute(1))).toBe(false)
  })
})

describe('mergeHistory', () => {
  it('puts history first and drops lines the buffer already has', () => {
    const buf = [line(5, T + 2 * M), line(6, T + 3 * M)]
    const merged = mergeHistory([line(3, T), line(4, T + M), line(5, T + 2 * M)], buf)
    expect(merged.map((l) => l.id)).toEqual([3, 4, 5, 6])
    expect(merged[2]).toBe(buf[0])
    expect(mergeHistory([], buf)).toBe(buf)
    expect(mergeHistory([line(5, T + 2 * M)], buf)).toBe(buf)
  })
})

describe('historyQuery', () => {
  it('asks for this source and filters, oldest first, from the minute to the buffer', () => {
    const q = new URLSearchParams(
      historyQuery({ source: 'api', levels: 'warn,error', q: 'status:>=500', span: minute(1), until: T + 9 * M }),
    )
    expect(Object.fromEntries(q)).toEqual({
      source: 'api',
      levels: 'warn,error',
      q: 'status:>=500',
      since: String(T + M),
      until: String(T + 9 * M),
      order: 'oldest',
      limit: '1000',
    })
    const bare = new URLSearchParams(historyQuery({ source: 'api', span: minute(1), until: T }))
    expect(bare.has('levels')).toBe(false)
    expect(bare.has('q')).toBe(false)
    // Never a range that ends before it starts.
    expect(bare.get('until')).toBe(String(T + M))
  })
})

describe('search: loaded span and anchor', () => {
  const lines = [line(9, T + 50 * M), line(8, T + 40 * M)]
  it('newest first: from the oldest loaded line up to until; everything once the last page is in', () => {
    expect(loadedSpan({ lines, since: T, until: T + 60 * M, order: 'newest', hasMore: true })).toEqual({
      from: T + 40 * M,
      to: T + 60 * M + 1,
    })
    expect(loadedSpan({ lines, since: T, until: T + 60 * M, order: 'newest', hasMore: false })).toEqual({
      from: T,
      to: T + 60 * M + 1,
    })
  })
  it('oldest first: from since up to the newest loaded line', () => {
    expect(loadedSpan({ lines, since: T, until: T + 60 * M, order: 'oldest', hasMore: true })).toEqual({
      from: T,
      to: T + 50 * M + 1,
    })
  })
  it('anchors at the bar end (newest) or start (oldest), inside the range only', () => {
    expect(anchorFor(minute(3), 'newest')).toBe(T + 4 * M - 1)
    expect(anchorFor(minute(3), 'oldest')).toBe(T + 3 * M)
    const b = { since: T, until: T + 60 * M }
    expect(anchoredBounds(b, T + 10 * M, 'newest')).toEqual({ since: T, until: T + 10 * M })
    expect(anchoredBounds(b, T + 10 * M, 'oldest')).toEqual({ since: T + 10 * M, until: T + 60 * M })
    expect(anchoredBounds(b, T + 90 * M, 'newest')).toBe(b)
    expect(anchoredBounds(b, undefined, 'newest')).toBe(b)
  })
  it('finds the bar holding a time', () => {
    const buckets = [{ start: T }, { start: T + M }, { start: T + 2 * M }]
    expect(barWidth(buckets, T, T + 3 * M)).toBe(M)
    expect(barWidth([{ start: T }], T, T + 5)).toBe(5)
    expect(barAt(buckets, T + M + 1, M)).toBe(1)
    expect(barAt(buckets, T + 9 * M, M)).toBe(-1)
    expect(barAt(buckets, undefined, M)).toBe(-1)
  })
})
