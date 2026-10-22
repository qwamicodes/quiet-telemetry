import { useMemo } from 'react'
import type { LogLine, MuteRule } from '@/gen'
import { useSettings } from '@/lib/settings-api'

/**
 * Muted lines (board 06.3): per-source rules saved in the source's settings.
 * Matching lines are hidden from the stream and search by default ("N muted ·
 * show"); they are still stored, counted and searchable.
 *
 * A rule with a `field` matches when that field's value, as text, equals
 * `value` (`*` matches any run of characters; case-insensitive). Without a
 * field, `value` appears anywhere in the raw line (case-insensitive).
 */

/** `path:/api/v1/health` → a field rule; anything else → a text rule. */
export function parseMute(input: string): MuteRule | null {
  const s = input.trim()
  if (!s) return null
  const m = /^([A-Za-z_][\w.@-]*):(.+)$/.exec(s)
  if (m && !m[2].startsWith('//')) return { field: m[1], value: m[2].trim() }
  return { field: null, value: s.replace(/^"(.*)"$/, '$1') }
}

/** How a rule reads on its chip. */
export function muteLabel(r: MuteRule): { key: string | null; value: string } {
  return { key: r.field, value: r.value }
}

const cache = new Map<string, RegExp>()
function glob(pattern: string): RegExp {
  let re = cache.get(pattern)
  if (!re) {
    const body = pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    re = new RegExp(`^${body}$`, 'i')
    if (cache.size > 500) cache.clear()
    cache.set(pattern, re)
  }
  return re
}

function fieldText(line: LogLine, path: string): string | undefined {
  if (path === 'msg' || path === 'message') {
    const f = line.fields as Record<string, unknown> | null
    if (!f || !(path in f)) return line.msg
  }
  if (path === 'level') return line.level ?? undefined
  if (path === 'source') return line.source
  let v: unknown = line.fields
  if (v && typeof v === 'object' && path in (v as Record<string, unknown>)) {
    v = (v as Record<string, unknown>)[path]
  } else {
    for (const part of path.split('.')) {
      if (v == null || typeof v !== 'object') return undefined
      v = (v as Record<string, unknown>)[part]
    }
  }
  if (v === undefined || v === null) return undefined
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

export function matchesMute(line: LogLine, r: MuteRule): boolean {
  if (r.field) {
    const t = fieldText(line, r.field)
    return t !== undefined && glob(r.value).test(t)
  }
  return line.raw.toLowerCase().includes(r.value.toLowerCase())
}

export function isMuted(line: LogLine, rules: readonly MuteRule[]): boolean {
  for (const r of rules) if (matchesMute(line, r)) return true
  return false
}

/** Rules per source, from the settings every signed-in user can read. */
export function useMuteRules(): (source: string) => readonly MuteRule[] {
  const sources = useSettings().data?.sources
  return useMemo(() => (source: string) => sources?.[source]?.muted ?? [], [sources])
}

/**
 * Split `lines` into what is shown and how many are muted. With `show`, every
 * line is shown and muted ones are still counted.
 */
export function useMuted(lines: LogLine[], show: boolean) {
  const rulesOf = useMuteRules()
  return useMemo(() => {
    let muted = 0
    const mutedIds = new Set<number>()
    for (const l of lines) {
      const rules = rulesOf(l.source)
      if (rules.length && isMuted(l, rules)) {
        muted++
        mutedIds.add(l.id)
      }
    }
    const visible = show || muted === 0 ? lines : lines.filter((l) => !mutedIds.has(l.id))
    return { visible, muted, mutedIds }
  }, [lines, show, rulesOf])
}
