import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type {
  AddedMuteRule,
  AddMuteRule,
  DeletedMuteRule,
  MutedSearch,
  MutePreview,
  MuteRule,
  MuteStats,
  SettingsResponse,
  SourceSettings,
  UpdateMuteRule,
} from '@/gen'
import { fetchJson } from '@/lib/api'
import { logLine } from '@/lib/schemas'
import { DEFAULT_SOURCE_SETTINGS, mutedSearch, muteRule, put, SETTINGS_KEY, sourceSettings } from '@/lib/settings-api'

/**
 * Muted-lines rules and their counts (`/api/mute/*`). Writes are owner-only;
 * every write patches the cached settings at once (the stream and search
 * re-filter without waiting) and refreshes them and the 24h counts.
 */

export const MUTE_STATS_KEY = ['mute-stats'] as const

const sourceOff = z.object({ source: z.string(), by: z.string().nullable(), at: z.number().nullable() })
export const addedMuteRule = z.object({
  rule: muteRule,
  removed: z.array(z.object({ source: z.string(), rule: muteRule })),
}) satisfies z.ZodType<AddedMuteRule>
export const deletedMuteRule = z.object({
  rule: muteRule,
  source: z.string().nullable(),
  off_on: z.array(sourceOff),
}) satisfies z.ZodType<DeletedMuteRule>
export const muteStats = z.object({
  since: z.number(),
  until: z.number(),
  sources: z.record(z.string(), z.object({ lines: z.number(), scanned: z.number(), estimated: z.boolean() })),
  rules: z.record(z.string(), z.object({ per_source: z.record(z.string(), z.number()) })),
}) satisfies z.ZodType<MuteStats>
export const mutePreview = z.object({
  total: z.number(),
  per_source: z.record(z.string(), z.number()),
  lines: z.number(),
  by_method: z.array(z.object({ method: z.string(), count: z.number() })),
  query_ignored: z.number(),
  already_hidden: z.number(),
  samples: z.array(logLine),
  estimated: z.boolean(),
  invalid: z.string().optional(),
}) satisfies z.ZodType<MutePreview>

/** 24h hits per rule and source (paused and switched-off rules count what they would hide). */
export function useMuteStats(enabled = true) {
  return useQuery({
    queryKey: MUTE_STATS_KEY,
    queryFn: ({ signal }) => fetchJson('/api/mute/stats', muteStats, { signal }),
    staleTime: 60_000,
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** What draft rules would hide on `sources` (empty = every source), live as they change. */
export function useMutePreview(rules: MuteRule[], sources: string[], enabled = true) {
  const key = JSON.stringify([rules.map((r) => [r.shape, r.field, r.value, r.method]), sources])
  return useQuery({
    queryKey: ['mute-preview', key],
    queryFn: ({ signal }) =>
      fetchJson('/api/mute/preview', z.array(mutePreview), { ...put({ rules, sources }, 'POST'), signal }),
    enabled: enabled && rules.some((r) => r.value.trim()),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })
}

/** Lines a rule hides (or would) per source, from the stats. */
export function ruleHits(stats: MuteStats | undefined, id: string): Record<string, number> {
  return stats?.rules[id]?.per_source ?? {}
}

export function sumHits(h: Record<string, number>, only?: (source: string) => boolean): number {
  let n = 0
  for (const [k, v] of Object.entries(h)) if (!only || only(k)) n += v
  return n
}

function useRefreshMute() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: SETTINGS_KEY })
    qc.invalidateQueries({ queryKey: MUTE_STATS_KEY })
    qc.invalidateQueries({ queryKey: ['mute-preview'] })
  }
}

/** Patch the cached settings right away so rows hide without waiting for the refetch. */
function useApplyLocally() {
  const qc = useQueryClient()
  return (f: (s: SettingsResponse) => SettingsResponse) => {
    const cur = qc.getQueryData<SettingsResponse>(SETTINGS_KEY)
    if (cur) qc.setQueryData(SETTINGS_KEY, f(cur))
  }
}

const withSource = (s: SettingsResponse, name: string, f: (x: SourceSettings) => SourceSettings): SettingsResponse => ({
  ...s,
  sources: { ...s.sources, [name]: f(s.sources[name] ?? DEFAULT_SOURCE_SETTINGS) },
})

/** Add a rule (or put a deleted one back: the rule keeps its id). */
export function useAddMuteRule() {
  const refresh = useRefreshMute()
  const local = useApplyLocally()
  return useMutation({
    mutationFn: (a: AddMuteRule) => fetchJson('/api/mute/rules', addedMuteRule, put(a, 'POST')),
    onSuccess: (res, a) => {
      local((s) => {
        let next = s
        if (res.rule.scope === 'global') {
          next = { ...next, muted_global: [...(next.muted_global ?? []), res.rule] }
          for (const r of res.removed)
            next = withSource(next, r.source, (x) => ({ ...x, muted: x.muted.filter((m) => m.id !== r.rule.id) }))
          for (const o of a.off_on ?? [])
            next = withSource(next, o.source, (x) => ({
              ...x,
              muted_global_off: [...(x.muted_global_off ?? []), { id: res.rule.id, by: o.by, at: o.at }],
            }))
        } else if (a.source) {
          next = withSource(next, a.source, (x) => ({ ...x, muted: [...x.muted, res.rule] }))
        }
        return next
      })
      refresh()
    },
  })
}

export function useUpdateMuteRule() {
  const refresh = useRefreshMute()
  const local = useApplyLocally()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateMuteRule }) =>
      fetchJson(`/api/mute/rules/${encodeURIComponent(id)}`, muteRule, put(patch, 'PATCH')),
    onSuccess: (r) => {
      local((s) => {
        const swap = (xs: MuteRule[]) => xs.map((x) => (x.id === r.id ? r : x))
        const sources = Object.fromEntries(
          Object.entries(s.sources).map(([k, v]) => [k, { ...v, muted: swap(v.muted) }]),
        )
        return { ...s, muted_global: swap(s.muted_global ?? []), sources }
      })
      refresh()
    },
  })
}

export function useDeleteMuteRule() {
  const refresh = useRefreshMute()
  const local = useApplyLocally()
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/mute/rules/${encodeURIComponent(id)}`, deletedMuteRule, { method: 'DELETE' }),
    onSuccess: (d) => {
      local((s) => {
        const sources = Object.fromEntries(
          Object.entries(s.sources).map(([k, v]) => [
            k,
            {
              ...v,
              muted: v.muted.filter((x) => x.id !== d.rule.id),
              muted_global_off: (v.muted_global_off ?? []).filter((o) => o.id !== d.rule.id),
            },
          ]),
        )
        return { ...s, muted_global: (s.muted_global ?? []).filter((x) => x.id !== d.rule.id), sources }
      })
      refresh()
    },
  })
}

/** Put a deleted rule back exactly as it was (Undo). */
export function restoreOf(d: DeletedMuteRule): AddMuteRule {
  return { rule: d.rule, source: d.source ?? undefined, off_on: d.off_on }
}

/** "Don't apply here" (`apply: false`) or back on, for one source and one global rule. */
export function useSetGlobalApply() {
  const refresh = useRefreshMute()
  const local = useApplyLocally()
  return useMutation({
    mutationFn: ({ source, id, apply }: { source: string; id: string; apply: boolean }) =>
      fetchJson(
        `/api/mute/sources/${encodeURIComponent(source)}/global/${encodeURIComponent(id)}`,
        sourceSettings,
        put({ apply }),
      ),
    onSuccess: (src, v) => {
      local((s) => withSource(s, v.source, () => src))
      refresh()
    },
  })
}

/** Settings → Muted lines → Include muted lines in search (`null` = the server flag). */
export function useSaveMutedSearch() {
  const refresh = useRefreshMute()
  return useMutation({
    mutationFn: (include: boolean | null): Promise<MutedSearch> =>
      fetchJson('/api/mute/search', mutedSearch, put({ include })),
    onSuccess: () => refresh(),
  })
}
