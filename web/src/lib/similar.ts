import { useQuery } from '@tanstack/react-query'
import type { LogLine } from '@/gen'
import { fetchJson } from '@/lib/api'
import { chip } from '@/lib/row'
import { searchResponse } from '@/lib/schemas'
import { toQuery } from '@/lib/search-api'

/**
 * Stems of the query's words, for "Similar values seen" (design 05.3):
 * `payout_reversed` → `payout`, `rever`. Short words and `key:value` chips
 * are left out; at most three stems.
 */
export function stems(text: string): string[] {
  const out: string[] = []
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4) continue
    const s = w.length > 6 ? w.slice(0, Math.max(4, w.length - 3)) : w
    if (!out.includes(s)) out.push(s)
  }
  return out.slice(0, 3)
}

type Fields = Record<string, unknown>

function walk(f: Fields, prefix: string, visit: (k: string, v: string) => void, depth = 0) {
  for (const [k, v] of Object.entries(f)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') visit(key, v)
    else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) walk(v as Fields, key, visit, depth + 1)
  }
}

const SKIP = new Set(['msg', 'message', 'time', 'timestamp', '@timestamp', 'ts', 'hostname', 'stack', 'raw'])

/**
 * Field values in `lines` that share a stem with what was searched, most
 * frequent first, as `key:value` chips. Long values (ids, messages) and the
 * exact text searched are skipped.
 */
export function similarValues(lines: LogLine[], text: string, max = 4): string[] {
  const st = stems(text)
  if (!st.length) return []
  const exact = text.trim().toLowerCase()
  const seen = new Map<string, number>()
  for (const l of lines) {
    if (!l.fields) continue
    walk(l.fields as Fields, '', (k, v) => {
      if (SKIP.has(k) || v.length > 40 || v.toLowerCase() === exact) return
      const lv = v.toLowerCase()
      if (!st.some((s) => lv.includes(s))) return
      const c = chip(k, v)
      seen.set(c, (seen.get(c) ?? 0) + 1)
    })
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([c]) => c)
}

/** Look for those values in the whole window of the same sources (one small search per stem). */
export function useSimilarValues(text: string, source: string | undefined, since: number, enabled: boolean) {
  const st = stems(text)
  return useQuery({
    queryKey: ['similar', text, source, Math.floor(since / 60_000)],
    enabled: enabled && st.length > 0,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        st.map((s) =>
          fetchJson(`/api/search?${toQuery({ q: s, source, since, limit: 250 })}`, searchResponse, { signal }),
        ),
      )
      return similarValues(
        pages.flatMap((p) => p.lines),
        text,
      )
    },
  })
}
