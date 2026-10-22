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
 * Whether search includes a source's muted lines by default: the source's own
 * choice (Muted lines → Include in search), else Settings → General, else off.
 */
export function useSearchIncludesMuted(): (source: string) => boolean {
  const data = useSettings().data
  return useMemo(() => {
    const instance = data?.muted_search?.include ?? false
    return (source: string) => data?.sources[source]?.search_include_muted ?? instance
  }, [data])
}

/** `muted=include|hide` on `/search`: a one-off override of the setting. */
export type MutedOverride = 'include' | 'hide'

/**
 * Search's split of `lines`: muted lines are shown (dimmed, tagged) where the
 * setting or the override includes them, else hidden.
 *
 * - `muted`: matched lines in view, shown or not;
 * - `hidden`: those left out right now;
 * - `mutedIds`: matched lines, so shown ones can be dimmed;
 * - `included`: every muted line in view is shown (the note reads "N muted
 *   lines included · Hide"); otherwise "N muted · Show muted".
 */
export function useSearchMuted(lines: LogLine[], override: MutedOverride | undefined) {
  const rulesOf = useMuteRules()
  const includes = useSearchIncludesMuted()
  return useMemo(() => {
    const mutedIds = new Set<number>()
    const hiddenIds = new Set<number>()
    for (const l of lines) {
      const rules = rulesOf(l.source)
      if (rules.length && isMuted(l, rules)) {
        mutedIds.add(l.id)
        const show = override ? override === 'include' : includes(l.source)
        if (!show) hiddenIds.add(l.id)
      }
    }
    const visible = hiddenIds.size === 0 ? lines : lines.filter((l) => !hiddenIds.has(l.id))
    return {
      visible,
      muted: mutedIds.size,
      hidden: hiddenIds.size,
      mutedIds,
      included: mutedIds.size > 0 && hiddenIds.size === 0,
    }
  }, [lines, override, rulesOf, includes])
}

/**
 * Split `lines` into what is shown and how many are muted. With `show`, every
 * line is shown and muted ones are still counted. (The stream: always hidden
 * unless "Show muted".)
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
