/**
 * The Diagram tab's thresholds and the one-line size summary the field card
 * shows beside its tabs. Kept apart from `diagram.ts` (layout, search) so the
 * card can show "17 keys · 4 objects · depth 2 · 812 B" without loading the
 * lazy Diagram chunk.
 */

/** Branches deeper than this start collapsed (root is depth 0). */
export const COLLAPSE_DEPTH = 3
/** Arrays show this many items, then "+ N more · showing 5 of 14". */
export const ARRAY_CAP = 5
/** A line with more keys than this, or more bytes, gets the large-line notice and the minimap. */
export const LARGE_KEYS = 200
export const LARGE_BYTES = 32 * 1024

/** Why JSON and Diagram are greyed out on a plain-text line (board 04.12). */
export const STRUCTURED_ONLY = 'Diagram needs a structured line (JSON, logfmt or OTLP).'

export type LineStats = {
  /** Keys across every object in the line. */
  keys: number
  /** Objects, the root included (array items that are objects count). */
  objects: number
  /** Deepest nesting: a flat line is depth 0, `{ a: { b: 1 } }` is 1. */
  depth: number
  bytes: number
  large: boolean
}

export const byteLength = (s: string) => new TextEncoder().encode(s).length

export function lineStats(fields: Record<string, unknown>, raw?: string): LineStats {
  let keys = 0
  let objects = 0
  let depth = 0
  const walk = (v: unknown, d: number) => {
    if (v === null || typeof v !== 'object') return
    if (d > depth) depth = d
    if (Array.isArray(v)) {
      for (const x of v) walk(x, d + 1)
      return
    }
    objects++
    const entries = Object.entries(v)
    keys += entries.length
    for (const [, x] of entries) walk(x, d + 1)
  }
  walk(fields, 0)
  const bytes = byteLength(raw ?? JSON.stringify(fields))
  return { keys, objects, depth, bytes, large: keys > LARGE_KEYS || bytes > LARGE_BYTES }
}

export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** `17 keys · 4 objects · depth 2 · 812 B` */
export const statsLabel = (s: LineStats) =>
  `${s.keys} ${s.keys === 1 ? 'key' : 'keys'} · ${s.objects} ${s.objects === 1 ? 'object' : 'objects'} · depth ${s.depth} · ${fmtSize(s.bytes)}`
