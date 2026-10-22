import type { CorrId, FlowSummary, Level, LogLine } from '@/gen'

/** `key:value` / `-key:value` (not a URL like `/a:b`), same rule as the server. */
const KV = /^-?[^\s:/"]+:\S+$/

/** Split `q` into filter chips and the free text around them. */
export function splitQuery(q: string): { chips: string[]; text: string } {
  const chips: string[] = []
  const text: string[] = []
  for (const tok of q.match(/"[^"]*"|\S+/g) ?? []) {
    if (KV.test(tok)) chips.push(tok)
    else text.push(tok)
  }
  return { chips, text: text.join(' ') }
}

export function joinQuery(chips: string[], text: string): string {
  return [...chips, text.trim()].filter(Boolean).join(' ')
}

/** Words to highlight: free text, not negated, unquoted. */
export function terms(q: string): string[] {
  const { text } = splitQuery(q)
  return (text.match(/"[^"]*"|\S+/g) ?? [])
    .filter((t) => !t.startsWith('-'))
    .map((t) => t.replace(/"/g, '').toLowerCase())
    .filter((t) => t.length > 1)
}

const RANK: Record<Level, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }

export interface FlowGroup {
  key: string
  id: CorrId | null
  lines: LogLine[]
  sources: string[]
  worst: Level | null
  first: number
  last: number
  /** The stitched flow the group belongs to, once its summary has arrived. */
  summary?: FlowSummary | null
}

/**
 * Group matches by the flow they belong to. With `summaries` (from
 * `/api/flow-summaries`, keyed by display id) lines whose ids stitch into
 * one flow (a request line and its job's retry lines) share one group;
 * until a summary arrives, a group is one id's matches. Groups keep the
 * order of their first match.
 */
export function groupByFlow(lines: LogLine[], summaries?: Map<string, FlowSummary | null>): FlowGroup[] {
  const groups = new Map<string, FlowGroup>()
  for (const l of lines) {
    const s = l.display_id ? summaries?.get(l.display_id.value) : undefined
    const key = s ? `flow:${s.key}` : l.display_id ? `${l.display_id.key}:${l.display_id.value}` : `line:${l.id}`
    let g = groups.get(key)
    if (!g) {
      g = { key, id: l.display_id, lines: [], sources: [], worst: null, first: l.ts, last: l.ts, summary: s }
      groups.set(key, g)
    }
    g.lines.push(l)
    if (!g.sources.includes(l.source)) g.sources.push(l.source)
    if (l.level && (!g.worst || RANK[l.level] > RANK[g.worst])) g.worst = l.level
    g.first = Math.min(g.first, l.ts)
    g.last = Math.max(g.last, l.ts)
  }
  return [...groups.values()]
}

/** The display ids a result page needs summaries for. */
export function displayIds(lines: LogLine[]): string[] {
  return [...new Set(lines.flatMap((l) => (l.display_id ? [l.display_id.value] : [])))]
}

const NOTABLE = ['status', 'duration_ms', 'attempt', 'err.code', 'error.code', 'outcome']
const SKIP = new Set(['msg', 'message', 'level', 'time', 'timestamp', 'ts', 'request_id', 'job_id', 'pid', 'hostname'])

function flat(v: unknown, prefix = '', out: [string, string][] = [], depth = 0): [string, string][] {
  if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
    for (const [k, x] of Object.entries(v)) flat(x, prefix ? `${prefix}.${k}` : k, out, depth + 1)
  } else if (prefix && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
    out.push([prefix, String(v)])
  }
  return out
}

/** Up to `max` fields worth showing on a result row: those matching the search first. */
export function notableFields(line: LogLine, words: string[], max = 3): [string, string][] {
  const all = flat(line.fields).filter(([k, v]) => !SKIP.has(k) && v.length <= 60)
  const hit = all.filter(([k, v]) => words.some((w) => v.toLowerCase().includes(w) || k.toLowerCase().includes(w)))
  const rest = NOTABLE.flatMap((n) => all.filter(([k]) => k === n))
  const out: [string, string][] = []
  for (const f of [...hit, ...rest]) {
    if (out.length >= max) break
    if (!out.some(([k]) => k === f[0])) out.push(f)
  }
  return out
}

/** Split `text` into plain and highlighted parts for these words. */
export function highlight(text: string, words: string[]): { s: string; hit: boolean }[] {
  if (!words.length) return [{ s: text, hit: false }]
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${esc.join('|')})`, 'gi')
  return text
    .split(re)
    .filter(Boolean)
    .map((s) => ({ s, hit: words.includes(s.toLowerCase()) }))
}
