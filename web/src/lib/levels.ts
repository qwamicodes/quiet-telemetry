import type { Level } from '@/gen'
import { LEVEL_FILTERS } from '@/lib/format'

/** The four level chips; `debug` covers trace and `error` covers fatal. */
export type LevelChip = (typeof LEVEL_FILTERS)[number]

export function chipOf(l: Level | null): LevelChip | null {
  if (!l) return null
  if (l === 'trace') return 'debug'
  if (l === 'fatal') return 'error'
  return l
}

/**
 * The URL's `level`: a comma list (`warn,error`) or `all`. Normalized to the
 * chips' order; anything unknown is dropped, so `level=warn,nope` → `warn`.
 */
export function normalizeLevelParam(v: string): string | undefined {
  if (v === 'all') return 'all'
  const set = new Set(v.split(',').map((s) => s.trim()))
  const chips = LEVEL_FILTERS.filter((c) => set.has(c))
  return chips.length ? chips.join(',') : undefined
}

/**
 * Chips on. Empty means every level (no filter). With no `level` in the URL a
 * source's default level (a minimum, Settings → source) turns on that level
 * and everything above it.
 */
export function levelsFromParam(param: string | undefined, sourceDefault?: string | null): LevelChip[] {
  if (param === 'all') return []
  if (param) {
    const set = new Set(param.split(','))
    const chips = LEVEL_FILTERS.filter((c) => set.has(c))
    return chips.length === LEVEL_FILTERS.length ? [] : chips
  }
  const min = chipOf((sourceDefault as Level | null | undefined) ?? null)
  if (!min || min === 'debug') return []
  return LEVEL_FILTERS.slice(LEVEL_FILTERS.indexOf(min))
}

/** Back to the URL: `undefined` when it equals what the page would pick anyway. */
export function levelsToParam(chips: LevelChip[], sourceDefault?: string | null): string | undefined {
  const all = chips.length === 0 || chips.length === LEVEL_FILTERS.length
  const fallback = levelsFromParam(undefined, sourceDefault)
  if (all) return fallback.length ? 'all' : undefined
  const param = LEVEL_FILTERS.filter((c) => chips.includes(c)).join(',')
  return fallback.join(',') === param ? undefined : param
}

/** Click a chip: on → off, off → on. Turning off the last one shows everything again. */
export function toggleChip(chips: LevelChip[], c: LevelChip): LevelChip[] {
  const on = chips.length === 0 ? [...LEVEL_FILTERS] : chips
  const next = on.includes(c) ? on.filter((x) => x !== c) : [...on, c]
  return next.length === 0 || next.length === LEVEL_FILTERS.length ? [] : LEVEL_FILTERS.filter((x) => next.includes(x))
}

export function isOn(chips: LevelChip[], c: LevelChip) {
  return chips.length === 0 || chips.includes(c)
}
