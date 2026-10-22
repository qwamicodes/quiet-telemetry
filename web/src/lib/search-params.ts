import { z } from 'zod'
import { LEVEL_FILTERS } from '@/lib/format'

/**
 * URL search params for every route, as zod schemas (Standard Schema, so
 * TanStack Router takes them as `validateSearch` directly). Every field
 * `.catch()`es: a hand-edited or stale URL falls back to the default instead
 * of throwing, and the page still opens.
 */
const text = z.string().trim().min(1).optional().catch(undefined)
const minLevel = z.enum(LEVEL_FILTERS).optional().catch(undefined)

/** `/` — the live stream of one source. */
export const streamSearch = z.object({
  source: text,
  level: minLevel,
  q: text,
})
export type StreamSearch = z.infer<typeof streamSearch>

/** `/flow/$id` — `line` is the step whose field card is open. */
export const flowSearch = z.object({
  line: z.coerce.number().int().positive().optional().catch(undefined),
})
export type FlowSearch = z.infer<typeof flowSearch>

/** Time ranges the picker offers; `from`/`to` (unix ms) override them. */
export const RANGES = ['15m', '1h', '6h', '24h', '3d', '7d'] as const
export type Range = (typeof RANGES)[number]
export const RANGE_MS: Record<Range, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '3d': 3 * 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
}

const ms = z.coerce.number().int().positive().optional().catch(undefined)

/** `/search` — free text + `key:value` filters, across sources, over a time range. */
export const searchSearch = z.object({
  q: z.string().optional().catch(undefined),
  source: text,
  range: z.enum(RANGES).default('6h').catch('6h'),
  from: ms,
  to: ms,
  view: z.enum(['flows', 'lines']).default('flows').catch('flows'),
  order: z.enum(['newest', 'oldest']).default('newest').catch('newest'),
})
export type SearchSearch = z.infer<typeof searchSearch>

/** The time bounds a search covers right now, unix ms. */
export function searchBounds(s: Pick<SearchSearch, 'range' | 'from' | 'to'>, now = Date.now()) {
  if (s.from) return { since: s.from, until: s.to ?? now }
  return { since: now - RANGE_MS[s.range], until: now }
}
