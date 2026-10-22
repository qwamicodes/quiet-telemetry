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
