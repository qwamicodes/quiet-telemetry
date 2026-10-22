import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type {
  DiskStatus,
  FlowIdSettings,
  GeneralSettings,
  HourUsage,
  IngestHealth,
  Issue,
  PausedSource,
  PiiKind,
  Purged,
  PurgeRequest,
  Rejection,
  SettingsResponse,
  SourceActivity,
  SourceSettings,
  SourceVolume,
  StorageReport,
  StorageSettings,
  StoreStatus,
  SystemStatus,
  UpdateStorage,
} from '@/gen'
import { fetchJson, sendJson } from '@/lib/api'
import { AUTH_KEY } from '@/lib/auth-api'
import { dockerStatus, level } from '@/lib/schemas'

// ---- schemas (each satisfies its generated type) ----------------------------

export const idKey = z.enum(['request_id', 'job_id', 'trace_id', 'correlation_id'])
export const ID_KEYS = idKey.options
export const piiKind = z.enum(['email', 'phone', 'name', 'ip', 'user_agent']) satisfies z.ZodType<PiiKind>
export const PII_KINDS = piiKind.options

const origin = z.enum(['setting', 'flag', 'default'])

export const generalSettings = z.object({
  instance_name: z.string(),
  stream_direction: z.enum(['bottom', 'top']),
  timezone: z.string(),
}) satisfies z.ZodType<GeneralSettings>

export const storageSettings = z.object({
  retention_ms: z.number(),
  retention_origin: origin,
  max_disk: z.number(),
  max_disk_origin: origin,
  flag_retention_ms: z.number(),
  flag_max_disk: z.number(),
  at_cap: z.literal('drop_oldest_hour'),
}) satisfies z.ZodType<StorageSettings>

export const flowIdSettings = z.object({
  order: z.array(idKey),
  match_by: z.enum(['value', 'key']),
}) satisfies z.ZodType<FlowIdSettings>

export const sourceSettings = z.object({
  display_name: z.string().nullable(),
  hidden: z.boolean(),
  paused: z.boolean(),
  retention_ms: z.number().nullable(),
  id_keys: z.array(idKey).nullable(),
  default_level: level.nullable(),
  mask_fields: z.array(z.string()),
  unmasked: z.array(piiKind),
}) satisfies z.ZodType<SourceSettings>

export const settingsResponse = z.object({
  general: generalSettings,
  storage: storageSettings,
  flow_ids: flowIdSettings,
  sources: z.record(z.string(), sourceSettings),
}) satisfies z.ZodType<SettingsResponse>

const hourUsage = z.object({ start: z.number(), lines: z.number(), bytes: z.number() }) satisfies z.ZodType<HourUsage>
const sourceVolume = z.object({
  source: z.string(),
  lines: z.number(),
  bytes: z.number(),
  disk: z.number(),
  share: z.number(),
}) satisfies z.ZodType<SourceVolume>

export const storageReport = z.object({
  settings: storageSettings,
  store: z.string(),
  path: z.string().nullable(),
  used: z.number(),
  ratio: z.number(),
  lines: z.number(),
  oldest: z.number().nullable(),
  fs_free: z.number().nullable(),
  hours: z.array(hourUsage),
  sources: z.array(sourceVolume),
  bytes_per_hour: z.number().nullable(),
  steady_bytes: z.number().nullable(),
  cap_in_ms: z.number().nullable(),
  now: z.number(),
}) satisfies z.ZodType<StorageReport>

const rejection = z.object({
  minute: z.number(),
  endpoint: z.string(),
  status: z.number(),
  reason: z.string(),
  source: z.string().nullable(),
  token: z.string().nullable(),
  count: z.number(),
}) satisfies z.ZodType<Rejection>

const issue = z.object({
  kind: z.enum(['docker_unavailable', 'disk_near_cap', 'disk_at_cap', 'disk_low', 'store_errors', 'ingest_rejected']),
  severity: z.enum(['warn', 'error']),
  title: z.string(),
  detail: z.string(),
}) satisfies z.ZodType<Issue>

const diskStatus = z.object({
  state: z.enum(['ok', 'near', 'full']),
  used: z.number(),
  cap: z.number(),
  ratio: z.number(),
  fs_free: z.number().nullable(),
  fs_total: z.number().nullable(),
  fs_low: z.boolean(),
  window_ms: z.number(),
  reaches_ms: z.number().nullable(),
  capped_lines: z.number(),
  capped_at: z.number().nullable(),
}) satisfies z.ZodType<DiskStatus>

const pausedSource = z.object({ source: z.string(), dropped: z.number() }) satisfies z.ZodType<PausedSource>
const ingestHealth = z.object({
  rejected_15m: z.number(),
  rejected_24h: z.number(),
  recent: z.array(rejection),
  paused: z.array(pausedSource),
}) satisfies z.ZodType<IngestHealth>

const storeStatus = z.object({
  kind: z.string(),
  write_errors: z.number(),
  last_error: z.string().nullable(),
  last_error_at: z.number().nullable(),
  disk_full: z.boolean(),
}) satisfies z.ZodType<StoreStatus>

export const systemStatus = z.object({
  ok: z.boolean(),
  issues: z.array(issue),
  docker: dockerStatus,
  disk: diskStatus,
  ingest: ingestHealth,
  store: storeStatus,
  now: z.number(),
}) satisfies z.ZodType<SystemStatus>

export const sourceActivity = z.object({
  source: z.string(),
  rejections: z.array(rejection),
  rejected_15m: z.number(),
  paused_dropped: z.number(),
}) satisfies z.ZodType<SourceActivity>

const purged = z.object({ lines: z.number(), source: z.string().nullable() }) satisfies z.ZodType<Purged>

// ---- queries --------------------------------------------------------------------

export const SETTINGS_KEY = ['settings'] as const

export const settingsQuery = queryOptions({
  queryKey: SETTINGS_KEY,
  queryFn: () => fetchJson('/api/settings', settingsResponse),
  staleTime: 30_000,
})

export const storageQuery = queryOptions({
  queryKey: ['storage'],
  queryFn: () => fetchJson('/api/storage', storageReport),
  refetchInterval: 15_000,
})

/** What the banners show. Polled gently; a failure shows nothing (the server-unreachable page covers that). */
export const systemQuery = queryOptions({
  queryKey: ['system'],
  queryFn: () => fetchJson('/api/system', systemStatus),
  refetchInterval: 15_000,
  retry: false,
})

export const activityQuery = (source: string) =>
  queryOptions({
    queryKey: ['activity', source],
    queryFn: () => fetchJson(`/api/sources/${encodeURIComponent(source)}/activity`, sourceActivity),
    refetchInterval: 15_000,
  })

export const useSettings = () => useQuery(settingsQuery)
export const useStorage = () => useQuery(storageQuery)
export const useSystem = () => useQuery(systemQuery)
export const useActivity = (source: string) => useQuery(activityQuery(source))

/** The settings of one source, all-default when it has none. */
export const DEFAULT_SOURCE_SETTINGS: SourceSettings = {
  display_name: null,
  hidden: false,
  paused: false,
  retention_ms: null,
  id_keys: null,
  default_level: null,
  mask_fields: [],
  unmasked: [],
}

export function useSourceSettings(name: string | null): SourceSettings {
  const all = useSettings().data
  return (name && all?.sources[name]) || DEFAULT_SOURCE_SETTINGS
}

// ---- mutations ------------------------------------------------------------------

const put = (body: unknown, method = 'PUT'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** After a write: settings and everything derived from them. */
function useRefresh() {
  const qc = useQueryClient()
  return (also: readonly (readonly string[])[] = []) => {
    qc.invalidateQueries({ queryKey: SETTINGS_KEY })
    for (const k of also) qc.invalidateQueries({ queryKey: k })
  }
}

export function useSaveGeneral() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (g: GeneralSettings) => fetchJson('/api/settings/general', generalSettings, put(g)),
    // The name shows signed out too (auth state carries it).
    onSuccess: () => refresh([AUTH_KEY]),
  })
}

export function useSaveStorage() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (u: UpdateStorage) => fetchJson('/api/settings/storage', storageSettings, put(u)),
    onSuccess: () => refresh([['storage'], ['health'], ['system']]),
  })
}

export function useSaveFlowIds() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (f: FlowIdSettings) => fetchJson('/api/settings/flow-ids', flowIdSettings, put(f)),
    onSuccess: () => refresh(),
  })
}

export function useSaveSource(name: string) {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (s: SourceSettings) =>
      fetchJson(`/api/settings/sources/${encodeURIComponent(name)}`, sourceSettings, put(s)),
    onSuccess: () => refresh([['sources'], ['storage']]),
  })
}

export function useResetSource(name: string) {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: () => sendJson(`/api/settings/sources/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => refresh([['sources']]),
  })
}

export function usePurge() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (r: PurgeRequest) => fetchJson('/api/storage/purge', purged, put(r, 'POST')),
    onSuccess: () => refresh([['storage'], ['health'], ['sources'], ['system']]),
  })
}

// ---- helpers --------------------------------------------------------------------

export const HOUR = 3_600_000
/** The searchable window choices (Settings → Storage). */
export const WINDOWS = [
  { label: '1h', ms: HOUR },
  { label: '24h', ms: 24 * HOUR },
  { label: '3d', ms: 72 * HOUR },
  { label: '7d', ms: 168 * HOUR },
] as const

export const ORIGIN_LABEL = { setting: 'set here', flag: 'from flag', default: 'default' } as const

export const PII_LABEL: Record<PiiKind, { label: string; keys: string; sample: string }> = {
  email: { label: 'email', keys: 'email · customer.email · user.email', sample: 'k•••••@legivent.com' },
  phone: { label: 'phone', keys: 'phone · mobile · msisdn', sample: '+233 •• ••• 4417' },
  name: { label: 'name', keys: 'first_name · last_name · customer_name', sample: 'K••••• O•••••' },
  ip: { label: 'ip', keys: 'ip_address · x-forwarded-for', sample: '102.176.•••.•••' },
  user_agent: { label: 'user_agent', keys: 'user_agent', sample: 'okhttp/•••' },
}
