/**
 * Field values that are JSON sent as a string (`"payload": "{\"user\":…}"`).
 *
 * A string that, trimmed, starts with `{` or `[` (or is a double-encoded
 * `"{…}"`) is parsed; when that yields an object or array the UI shows it as
 * structure, marked "parsed from a string", with a toggle back to the string
 * as sent. Anything else (plain text, invalid JSON, a primitive) stays exactly
 * as it was. Pure, capped and memoized.
 */

/** Strings longer than this are never parsed (bytes ≈ UTF-16 units here). */
export const PARSE_MAX = 256 * 1024
/** Parsed values nested deeper than this are left as strings. */
export const PARSE_DEPTH = 32
/** At most this many strings are expanded per line (nested ones included). */
export const EXPAND_MAX = 200
/** Strings inside parsed strings are looked into this many times over. */
const NEST_MAX = 4

type Json = Record<string, unknown> | unknown[]

const cache = new Map<string, Json | null>()
const CACHE_MAX = 500

function depthOk(v: unknown, d = 0): boolean {
  if (v === null || typeof v !== 'object') return true
  if (d >= PARSE_DEPTH) return false
  const xs = Array.isArray(v) ? v : Object.values(v)
  return xs.every((x) => depthOk(x, d + 1))
}

function parse(s: string): Json | null {
  let t = s.trim()
  if (t.length < 2 || t.length > PARSE_MAX) return null
  // Double-encoded: `"{\"a\":1}"` → `{"a":1}` (one level).
  if (t[0] === '"') {
    try {
      const inner: unknown = JSON.parse(t)
      if (typeof inner !== 'string') return null
      t = inner.trim()
    } catch {
      return null
    }
  }
  const open = t[0]
  const close = t[t.length - 1]
  if (!((open === '{' && close === '}') || (open === '[' && close === ']'))) return null
  try {
    const v: unknown = JSON.parse(t)
    if (v === null || typeof v !== 'object' || !depthOk(v)) return null
    return v as Json
  } catch {
    return null
  }
}

/** The object or array a string holds as JSON, else `undefined` (memoized). */
export function parseJsonString(s: string): Json | undefined {
  const t = s.trimStart()
  if (t[0] !== '{' && t[0] !== '[' && t[0] !== '"') return undefined
  let hit = cache.get(s)
  if (hit === undefined) {
    hit = parse(s)
    if (cache.size >= CACHE_MAX) {
      const first = cache.keys().next()
      if (!first.done) cache.delete(first.value)
    }
    cache.set(s, hit)
  }
  return hit ?? undefined
}

/**
 * A free-text query for a value found inside a JSON string: search filters
 * (`key:value`) only see real fields, so these search the line text instead.
 */
export function textQuery(value: unknown, exclude = false): string {
  const v = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/"/g, '')
  return `${exclude ? '-' : ''}${/\s/.test(v) || !exclude ? `"${v}"` : v}`
}

/** Whether `segs` sits inside (or is) a value parsed from a JSON string. */
export function insideParsed(segs: readonly Seg[], parsed: ReadonlyMap<string, string> | undefined): boolean {
  if (!parsed || parsed.size === 0) return false
  for (let i = 1; i <= segs.length; i++) if (parsed.has(segId(segs.slice(0, i)))) return true
  return false
}

/** A place in the line, as path segments (`['payload', 'items', 0]`). */
export type Seg = string | number
/** Same format as the Diagram's ids: `.payload.items[0]` (root is ``). */
export const segId = (segs: readonly Seg[]) => segs.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('')

export type Expanded = {
  /** The fields with every JSON string replaced by what it holds. */
  fields: Record<string, unknown>
  /** Ids (`segId`) of the values that were strings, with the string as sent. */
  parsed: Map<string, string>
}

const memo = new WeakMap<object, Expanded>()

/**
 * The line's fields with JSON strings parsed, and where they were. Returns
 * the same object (and an empty map) when nothing parsed, so callers can
 * compare by identity. Memoized per fields object.
 */
export function expandJsonStrings(fields: Record<string, unknown>): Expanded {
  const hit = memo.get(fields)
  if (hit) return hit
  const parsed = new Map<string, string>()
  const walk = (v: unknown, segs: Seg[], nest: number): unknown => {
    if (typeof v === 'string') {
      if (nest >= NEST_MAX || parsed.size >= EXPAND_MAX) return v
      const p = parseJsonString(v)
      if (!p) return v
      parsed.set(segId(segs), v)
      return walk(p, segs, nest + 1)
    }
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((x, i) => {
        const y = walk(x, [...segs, i], nest)
        if (y !== x) changed = true
        return y
      })
      return changed ? out : v
    }
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const y = walk(x, [...segs, k], nest)
      if (y !== x) changed = true
      out[k] = y
    }
    return changed ? out : v
  }
  const out = walk(fields, [], 0) as Record<string, unknown>
  const res: Expanded = { fields: out, parsed }
  memo.set(fields, res)
  return res
}

/**
 * For a dotted key from the Fields tab (`payload.user.id`), the dotted key of
 * the string it was parsed out of (`payload`), or `undefined` when the key is
 * a real field. The key itself counts when it is the parsed value.
 */
export function parsedRoot(key: string, parsed: ReadonlyMap<string, string>): string | undefined {
  if (parsed.size === 0) return undefined
  const parts = key.split('.')
  for (let i = 1; i <= parts.length; i++) {
    const head = parts.slice(0, i)
    if (parsed.has(segId(head))) return head.join('.')
  }
  return undefined
}
