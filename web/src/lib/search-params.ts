import { z } from 'zod'
import { normalizeLevelParam } from '@/lib/levels'

/**
 * URL search params for every route, as zod schemas (Standard Schema, so
 * TanStack Router takes them as `validateSearch` directly). Every field
 * `.catch()`es: a hand-edited or stale URL falls back to the default instead
 * of throwing, and the page still opens.
 */
const text = z.string().trim().min(1).optional().catch(undefined)
/**
 * The stream's level chips: a comma list (`level=warn,error`), or `all` to
 * override a source's default level. Kept as a string so the URL stays
 * readable; `levelsFromParam` turns it into chips.
 */
const streamLevel = z.string().transform(normalizeLevelParam).optional().catch(undefined)

/** `/` — the live stream of one source. */
export const streamSearch = z.object({
  source: text,
  level: streamLevel,
  q: text,
})
export type StreamSearch = z.infer<typeof streamSearch>

/** `/flow/$id` and `/line/$lineId` — `line` is the step whose field card is open. */
export const flowSearch = z.object({
  line: z.coerce.number().int().positive().optional().catch(undefined),
})
export type FlowSearch = z.infer<typeof flowSearch>

/**
 * Path params. A broken link (empty or absurd id, a line id that isn't a
 * number) fails here and the route shows its "broken flow link" page instead
 * of asking the server.
 */
export const flowParams = z.object({ id: z.string().trim().min(1).max(256) })
export const lineParams = z.object({ lineId: z.coerce.number().int().positive() })

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
  /**
   * Muted lines (06.3), a one-off override of "Include muted lines in
   * search": `include` shows them dimmed, `hide` leaves them out. Unset
   * follows the setting (per source, else Settings → General, else hidden).
   */
  muted: z.enum(['include', 'hide']).optional().catch(undefined),
})
export type SearchSearch = z.infer<typeof searchSearch>

/** The time bounds a search covers right now, unix ms. */
export function searchBounds(s: Pick<SearchSearch, 'range' | 'from' | 'to'>, now = Date.now()) {
  if (s.from) return { since: s.from, until: s.to ?? now }
  return { since: now - RANGE_MS[s.range], until: now }
}

/** `/sources/$name`: a source name as the server accepts it (1–128 chars, no control chars). */
export const sourceParams = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v)),
})

/** `/sources?group=compose:apps&kind=stack`: the Sources page filtered to one group (⌘K Groups). */
export const sourcesSearch = z.object({
  group: z.string().max(300).optional().catch(undefined),
  kind: z.enum(['all', 'standalone', 'stack']).optional().catch(undefined),
})
export type SourcesSearch = z.infer<typeof sourcesSearch>

/** `/sources/$name?tab=` */
export const sourceSearch = z.object({
  tab: z.enum(['rejected', 'malformed', 'settings']).optional().catch(undefined),
})

/** `/guide?tab=&source=` (boards v0.1-11.x). */
export const guideTab = z.enum(['overview', 'agent', 'canonical', 'ids', 'check'])
export type GuideTab = z.infer<typeof guideTab>
export const guideSearch = z.object({
  tab: guideTab.optional().catch(undefined),
  source: z.string().max(300).optional().catch(undefined),
})
export type GuideSearch = z.infer<typeof guideSearch>
