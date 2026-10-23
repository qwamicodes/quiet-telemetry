import { useMemo } from 'react'
import type {
  GlobalOff,
  LogLine,
  MuteOrigin,
  MuteRule,
  MuteScope,
  MuteShape,
  SettingsResponse,
  SourceSettings,
} from '@/gen'
import { useSettings } from '@/lib/settings-api'

/**
 * Muted lines (boards 03.15–03.23, 06.13–06.25, 07.12–07.20). Two scopes:
 * global rules (Settings → Muted lines) apply to every source, including new
 * ones; source rules (Sources → edit → Muted lines) to one. A line is hidden
 * when **any** enabled rule that applies to its source matches (union); a
 * source can switch one global rule off for itself ("Don't apply here").
 * Hidden lines are still stored, counted and searchable (Show muted).
 *
 * Rule shapes (same as `server/src/mute.rs`; keep the two in step):
 * - `route`: the line's route, any method. Every field in {@link ROUTE_KEYS}
 *   is tried, reduced to its path (scheme, host, `?query`, `#hash` dropped);
 *   `*` matches within one path segment.
 * - `method_route`: a route rule plus the request method.
 * - `message`: the message (`msg` / `message`, else the row summary) equals it.
 * - `field`: `field = value`, `*` matches any run of characters.
 * - `text`: appears anywhere in the raw line (rules from before the shapes).
 * Comparisons ignore case.
 */

/** Where a line's route can be, in pick order (03.19). */
export const ROUTE_KEYS = ['route', 'path', 'http.route', 'req.url', 'url'] as const
/** Where a line's request method can be. */
export const METHOD_KEYS = ['method', 'http.method', 'req.method', 'request.method', 'http.request.method'] as const

/** `https://x.io/a/b?c=1#d` → `/a/b`: the path as written. */
export function routePath(v: string): string {
  let s = v.trim()
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(s)
  if (m) s = s.slice(m[0].length) || '/'
  const end = s.search(/[?#]/)
  return end >= 0 ? s.slice(0, end) : s
}

/** A draft rule: what the editor and the row menu send. */
export function draftRule(
  shape: MuteShape,
  value: string,
  o: { field?: string | null; method?: string | null; scope?: MuteScope; origin?: MuteOrigin } = {},
): MuteRule {
  return {
    id: '',
    scope: o.scope ?? 'source',
    enabled: true,
    shape,
    field: o.field ?? null,
    value,
    method: o.method ?? null,
    created_by: null,
    created_at: null,
    origin: o.origin ?? 'manual',
  }
}

/** `path:/api/v1/health` → a field rule; `"x"` or anything else → a text rule (the old editor's input). */
export function parseMute(input: string): MuteRule | null {
  const s = input.trim()
  if (!s) return null
  const m = /^([A-Za-z_][\w.@-]*):(.+)$/.exec(s)
  if (m && !m[2].startsWith('//')) {
    const value = m[2].trim()
    return m[1] === 'msg' || m[1] === 'message'
      ? draftRule('message', value.replace(/^"(.*)"$/, '$1'), { field: m[1] })
      : draftRule('field', value, { field: m[1] })
  }
  return draftRule('text', s.replace(/^"(.*)"$/, '$1'))
}

const cache = new Map<string, RegExp>()
function glob(pattern: string): RegExp {
  let re = cache.get(pattern)
  if (!re) {
    const body = pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    re = new RegExp(`^${body}$`, 'is')
    if (cache.size > 500) cache.clear()
    cache.set(pattern, re)
  }
  return re
}

/** `*` stays inside one path segment: same number of `/`, then segment by segment. */
function globSegments(pattern: string, path: string): boolean {
  const p = pattern.split('/')
  const t = path.split('/')
  return p.length === t.length && p.every((seg, i) => glob(seg).test(t[i]))
}

export function fieldText(line: LogLine, path: string): string | undefined {
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

/** The line's route (03.19): the first route field, as sent and as a path. */
export function pickRoute(line: LogLine): { key: string; raw: string; path: string } | null {
  for (const key of ROUTE_KEYS) {
    const raw = fieldText(line, key)
    if (raw) return { key, raw, path: routePath(raw) }
  }
  return null
}

export function methodOf(line: LogLine): string | null {
  for (const k of METHOD_KEYS) {
    const v = fieldText(line, k)
    if (v) return v.toUpperCase()
  }
  return null
}

function routeMatches(line: LogLine, pattern: string): boolean {
  for (const k of ROUTE_KEYS) {
    const v = fieldText(line, k)
    if (v !== undefined && globSegments(pattern, routePath(v))) return true
  }
  return false
}

/** Whether `line` matches `r` (on or off: callers pick the rules). */
export function matchesMute(line: LogLine, r: MuteRule): boolean {
  switch (r.shape) {
    case 'route':
      return routeMatches(line, r.value)
    case 'method_route':
      return routeMatches(line, r.value) && r.method != null && methodOf(line) === r.method.toUpperCase()
    case 'message': {
      const t = fieldText(line, r.field ?? 'msg')
      return t !== undefined && glob(r.value).test(t)
    }
    case 'field':
      if (r.field) {
        const t = fieldText(line, r.field)
        return t !== undefined && glob(r.value).test(t)
      }
      return line.raw.toLowerCase().includes(r.value.toLowerCase())
    default:
      return line.raw.toLowerCase().includes(r.value.toLowerCase())
  }
}

export function isMuted(line: LogLine, rules: readonly MuteRule[]): boolean {
  for (const r of rules) if (matchesMute(line, r)) return true
  return false
}

/** The first rule hiding `line` (the "muted" tag names it). */
export function mutingRule(line: LogLine, rules: readonly MuteRule[]): MuteRule | undefined {
  for (const r of rules) if (matchesMute(line, r)) return r
  return undefined
}

/** Same rule, whatever its id or history (server `same_as`). */
export function sameRule(a: MuteRule, b: MuteRule): boolean {
  const pathLike = a.shape === 'route' || a.shape === 'method_route' || a.shape === 'message'
  return (
    a.shape === b.shape &&
    a.value.toLowerCase() === b.value.toLowerCase() &&
    (a.method ?? '').toUpperCase() === (b.method ?? '').toUpperCase() &&
    (pathLike || a.field === b.field)
  )
}

/** The "Don't apply here" switch a source holds for a global rule. */
export function globalOff(s: SourceSettings | undefined, id: string): GlobalOff | undefined {
  return s?.muted_global_off?.find((o) => o.id === id)
}

/** The rules hiding `source`'s lines now: enabled global rules it kept on, plus its own enabled rules. */
export function effectiveRules(data: SettingsResponse | undefined, source: string): MuteRule[] {
  if (!data) return []
  const own = data.sources?.[source]
  return [
    ...(data.muted_global ?? []).filter((r) => r.enabled && !globalOff(own, r.id)),
    ...(own?.muted ?? []).filter((r) => r.enabled !== false),
  ]
}

// ---- how a rule reads -------------------------------------------------------------

export const SHAPE_LABEL: Record<MuteShape, string> = {
  route: 'route',
  method_route: 'method + route',
  message: 'message',
  field: 'field',
  text: 'text',
}

/** A rule as its row shows it: a muted prefix and the pattern (`path:` `/api/v1/health`). */
export function rulePattern(r: MuteRule): { prefix: string; value: string } {
  switch (r.shape) {
    case 'route':
      return { prefix: `${r.field && r.field !== 'route' ? r.field : 'path'}:`, value: r.value }
    case 'method_route':
      return { prefix: `${r.method ?? ''} `, value: r.value }
    case 'message':
      return { prefix: 'msg:', value: `"${r.value}"` }
    case 'field':
      return r.field ? { prefix: `${r.field}=`, value: r.value } : { prefix: 'text:', value: `"${r.value}"` }
    default:
      return { prefix: 'text:', value: `"${r.value}"` }
  }
}

/** One line: `path:/api/v1/health`, `GET /api/v1/ping`, `msg:"x"`. */
export function ruleText(r: MuteRule): string {
  const p = rulePattern(r)
  return `${p.prefix}${p.value}`
}

/** What a toast or tooltip names: `/api/v1/health`, `GET /api/v1/ping`, `msg:"x"`. */
export function ruleTarget(r: MuteRule): string {
  if (r.shape === 'route') return r.value
  if (r.shape === 'method_route') return `${r.method} ${r.value}`
  return ruleText(r)
}

/** How the server stores a draft (`stored as path:/api/v1/status`). */
export function storedAs(r: MuteRule): string {
  if (r.shape === 'method_route') return `path:${r.value} method:${r.method ?? ''}`
  if (r.shape === 'route') return `path:${r.value}`
  return ruleText(r)
}

// ---- the row menu (03.16, 03.20) --------------------------------------------------------

export type MuteOptionKey = 'route' | 'method_route' | 'message'
export interface MuteOption {
  key: MuteOptionKey
  label: string
  rule: MuteRule
  /** Greyed out (no route field on this line). */
  disabled?: string
}

/** A line's message: its `msg` / `message`, else the row summary. */
export function messageOf(line: LogLine): string {
  const f = line.fields as Record<string, unknown> | undefined
  const m = f?.msg ?? f?.message
  return typeof m === 'string' && m ? m : line.msg
}

/**
 * The three options for a line (03.16): route any method (default), method +
 * route, this exact message. Without a route field the route options stay,
 * greyed out ("no route field on this line"), and the message is the default.
 */
export function muteOptions(line: LogLine, scope: MuteScope = 'source'): MuteOption[] {
  const route = pickRoute(line)
  const method = methodOf(line)
  const msg = messageOf(line)
  const o = { scope, origin: 'hover' as const }
  const none = 'no route field on this line'
  return [
    {
      key: 'route',
      label: route ? 'Mute route · any method' : 'Mute route',
      rule: draftRule('route', route?.path ?? '', { ...o, field: route?.key ?? null }),
      disabled: route ? undefined : none,
    },
    {
      key: 'method_route',
      label: route && method ? `Mute ${method} ${route.path} only` : 'Mute method + route',
      rule: draftRule('method_route', route?.path ?? '', { ...o, field: route?.key ?? null, method }),
      disabled: !route ? none : !method ? 'no method field on this line' : undefined,
    },
    {
      key: 'message',
      label: 'Mute this exact message',
      rule: draftRule('message', msg, o),
      disabled: msg ? undefined : 'this line has no message',
    },
  ]
}

/** The option `M` (and the button) uses: the route when there is one, else the message. */
export function defaultOption(options: MuteOption[]): MuteOption {
  return options.find((o) => !o.disabled) ?? options[options.length - 1]
}

/** Effective rules per source, from the settings every signed-in user can read. */
export function useMuteRules(): (source: string) => readonly MuteRule[] {
  const data = useSettings().data
  return useMemo(() => {
    const memo = new Map<string, MuteRule[]>()
    return (source: string) => {
      let r = memo.get(source)
      if (!r) {
        r = effectiveRules(data, source)
        memo.set(source, r)
      }
      return r
    }
  }, [data])
}

/**
 * Whether search includes a source's muted lines by default: the source's own
 * choice (Muted lines → Include in search), else Settings → Muted lines, else off.
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
