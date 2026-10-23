import type { LogLine, SearchResponse } from '@/gen'
import { fetchJson } from '@/lib/api'
import { searchResponse } from '@/lib/schemas'
import { toQuery } from '@/lib/search-api'

/**
 * Click a histogram bar, land on its lines. The pure parts of that live here
 * (tested in `histogram-jump.test.ts`); the stream and search pages wire them.
 */

/** One bar's time span, unix ms: `from` inclusive, `to` exclusive. */
export interface Span {
  from: number
  to: number
}

export const inSpan = (ts: number, s: Span) => ts >= s.from && ts < s.to

/**
 * Index (in display order) of the row to put at the top for a bar: the first
 * row shown whose time falls in the bar. With newest at the bottom that is the
 * minute's first line; with newest on top, the minute's newest line, so the
 * whole minute reads downward from the top. -1 when no row is in the bar.
 */
export function jumpIndex(rows: readonly { ts: number }[], span: Span): number {
  return rows.findIndex((r) => inSpan(r.ts, span))
}

/**
 * Row to land on when the bar itself has no row on screen (all its lines are
 * muted or filtered out client-side): the first row after it, else the last
 * row before it. -1 when there are no rows.
 */
export function nearestIndex(rows: readonly { ts: number }[], span: Span): number {
  if (!rows.length) return -1
  let after = -1
  let afterTs = Number.POSITIVE_INFINITY
  let before = -1
  let beforeTs = Number.NEGATIVE_INFINITY
  rows.forEach((r, i) => {
    if (r.ts >= span.from && r.ts < afterTs) {
      after = i
      afterTs = r.ts
    } else if (r.ts < span.from && r.ts > beforeTs) {
      before = i
      beforeTs = r.ts
    }
  })
  return after >= 0 ? after : before
}

/**
 * Whether the stream's buffer already holds every line of the bar: it does
 * when its oldest line is older than the bar's start (the buffer is
 * contiguous from there to now). Otherwise the bar's lines, or some of them,
 * fell off or were never in the backlog and must come from history.
 */
export function bufferCovers(lines: readonly { ts: number }[], span: Span): boolean {
  if (!lines.length) return false
  let oldest = lines[0].ts
  for (const l of lines) if (l.ts < oldest) oldest = l.ts
  return oldest < span.from
}

/**
 * History lines first, then the live buffer, without duplicates: a line the
 * buffer has wins (it is the same line, and the buffer's copy keeps its place).
 */
export function mergeHistory(history: readonly LogLine[], buffer: readonly LogLine[]): LogLine[] {
  if (!history.length) return buffer as LogLine[]
  const have = new Set(buffer.map((l) => l.id))
  const older = history.filter((l) => !have.has(l.id))
  return older.length ? [...older, ...buffer] : (buffer as LogLine[])
}

/** At most this many history lines per jump (the server's page cap). */
export const HISTORY_LIMIT = 1000

/**
 * The `/api/search` query for a stream jump: this source and the stream's
 * filters (level chips, query), oldest first from the bar's start up to the
 * oldest line already buffered (or now), so history and buffer meet.
 */
export function historyQuery(o: {
  source: string
  levels?: string
  q?: string
  span: Span
  until: number
  limit?: number
}): string {
  return toQuery({
    source: o.source,
    levels: o.levels || undefined,
    q: o.q || undefined,
    since: o.span.from,
    until: Math.max(o.span.from, o.until),
    order: 'oldest',
    limit: o.limit ?? HISTORY_LIMIT,
  })
}

export function fetchHistory(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  return fetchJson(`/api/search?${query}`, searchResponse, { signal })
}

/**
 * Search results cover a time span: everything between the query's bounds
 * that has been paged in. Newest first, that runs from the oldest loaded line
 * (all the way down to `since` once the last page is in) up to `until`;
 * oldest first, the mirror image.
 */
export function loadedSpan(o: {
  lines: readonly { ts: number }[]
  since: number
  until: number
  order: 'newest' | 'oldest'
  hasMore: boolean
}): Span {
  if (!o.hasMore) return { from: o.since, to: o.until + 1 }
  if (!o.lines.length) return { from: o.until + 1, to: o.until + 1 }
  let min = o.lines[0].ts
  let max = o.lines[0].ts
  for (const l of o.lines) {
    if (l.ts < min) min = l.ts
    if (l.ts > max) max = l.ts
  }
  return o.order === 'newest' ? { from: min, to: o.until + 1 } : { from: o.since, to: max + 1 }
}

/**
 * The `at=` anchor (unix ms) for a bar on Search: newest first lists lines at
 * or before it, so it is the bar's last millisecond; oldest first lists lines
 * at or after it, so the bar's start.
 */
export function anchorFor(span: Span, order: 'newest' | 'oldest'): number {
  return order === 'newest' ? span.to - 1 : span.from
}

/** Search bounds re-anchored at `at` (ignored when outside them). */
export function anchoredBounds(
  b: { since: number; until: number },
  at: number | undefined,
  order: 'newest' | 'oldest',
): { since: number; until: number } {
  if (at == null || at < b.since || at > b.until) return b
  return order === 'newest' ? { since: b.since, until: at } : { since: at, until: b.until }
}

/** The bar (index) of a histogram that holds `ts`; -1 when none does. */
export function barAt(buckets: readonly { start: number }[], ts: number | null | undefined, width: number): number {
  if (ts == null || !buckets.length) return -1
  return buckets.findIndex((b) => ts >= b.start && ts < b.start + width)
}

/** A histogram's bar width: the step between bars, else the span split evenly. */
export function barWidth(buckets: readonly { start: number }[], since: number, until: number): number {
  if (buckets.length > 1) return buckets[1].start - buckets[0].start
  return Math.max(1, until - since)
}
