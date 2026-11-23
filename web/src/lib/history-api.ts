import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type {
  AtCapacity,
  Destination,
  DestinationKind,
  DestinationSaved,
  DestinationsResponse,
  GapReason,
  HistoryGap,
  HistoryJob,
  HistoryPolicy,
  HistoryPreview,
  HistoryStatus,
  NewDestination,
  RemoveStarted,
  UpdateDestination,
  VerifyResult,
  VerifyStep,
} from '@/gen'
import { ApiError, fetchJson, sendJson } from '@/lib/api'
import { put } from '@/lib/settings-api'

// Retained history (v0.1.1 Phase 5a, 5b): destinations, verify, policy, jobs, status.

export const destinationKind = z.enum(['garage', 'r2', 's3', 's3_compatible']) satisfies z.ZodType<DestinationKind>

const verifyStep = z.object({
  step: z.enum(['write', 'read', 'list', 'delete']),
  ok: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<VerifyStep>

export const verifyResult = z.object({
  ok: z.boolean(),
  cleanup: z.boolean(),
  steps: z.array(verifyStep),
  at: z.number(),
}) satisfies z.ZodType<VerifyResult>

export const destination = z.object({
  id: z.number(),
  name: z.string(),
  kind: destinationKind,
  endpoint: z.string().nullable(),
  region: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  path_style: z.boolean(),
  access_key_preview: z.string(),
  active: z.boolean(),
  state: z.enum(['ok', 'unavailable', 'read_only']),
  verified_at: z.number().nullable(),
  last_verify: verifyResult.nullable(),
  hours: z.number(),
  lines: z.number(),
  bytes_stored: z.number(),
  first: z.number().nullable(),
  last: z.number().nullable(),
  error: z.string().nullable(),
  next_retry: z.number().nullable(),
  created_at: z.number(),
  capacity_bytes: z.number().nullable(),
  capacity_source: z.enum(['owner', 'garage']).nullable(),
  at_capacity: z.boolean(),
  removing: z.boolean(),
  cleanup_error: z.string().nullable(),
  cleanup_retry_at: z.number().nullable(),
  cleanup_blocked_hours: z.number(),
}) satisfies z.ZodType<Destination>

const gapReason = z.enum([
  'no_destination',
  'destination_unavailable',
  'disk_cap',
  'excluded',
  'at_capacity',
]) satisfies z.ZodType<GapReason>

const historyGap = z.object({
  hour: z.number(),
  reason: gapReason,
  at: z.number(),
}) satisfies z.ZodType<HistoryGap>

export const atCapacity = z.enum(['evict', 'stop']) satisfies z.ZodType<AtCapacity>

export const historyPolicy = z.object({
  retention_days: z.number().nullable(),
  at_capacity: atCapacity,
}) satisfies z.ZodType<HistoryPolicy>

export const historyJob = z.object({
  id: z.number(),
  kind: z.enum(['backfill', 'copy', 'delete']),
  state: z.enum(['running', 'blocked', 'done', 'failed', 'cancelled']),
  destination_id: z.number().nullable(),
  destination: z.string().nullable(),
  source_id: z.number().nullable(),
  source: z.string().nullable(),
  total: z.number(),
  done: z.number(),
  bytes: z.number(),
  error: z.string().nullable(),
  next_retry: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
}) satisfies z.ZodType<HistoryJob>

export const historyPreview = z.object({
  retention_days: z.number().nullable(),
  before: z.number().nullable(),
  hours: z.number(),
  lines: z.number(),
  bytes: z.number(),
  destinations: z.array(z.object({ id: z.number(), name: z.string(), hours: z.number(), bytes: z.number() })),
}) satisfies z.ZodType<HistoryPreview>

export const historyStatus = z.object({
  enabled: z.boolean(),
  enabled_at: z.number().nullable(),
  instance_id: z.string(),
  active: z.number().nullable(),
  destinations: z.array(destination),
  gaps: z.array(historyGap),
  gap_hours: z.number(),
  waiting_hours: z.number(),
  policy: historyPolicy,
  retained_from: z.number().nullable(),
  expired_hours: z.number(),
  expired_bytes: z.number(),
  backfill_hours: z.number(),
  jobs: z.array(historyJob),
}) satisfies z.ZodType<HistoryStatus>

const destinations = z.object({ destinations: z.array(destination) }) satisfies z.ZodType<DestinationsResponse>
const saved = z.object({ destination, verify: verifyResult }) satisfies z.ZodType<DestinationSaved>

export const HISTORY_KEY = ['storage', 'history'] as const

export function useHistory() {
  return useQuery({
    queryKey: HISTORY_KEY,
    queryFn: ({ signal }) => fetchJson('/api/storage/history', historyStatus, { signal }),
    // Faster while a job moves hours, so its progress bar moves.
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.state === 'running') ? 2_000 : 15_000),
  })
}

export function useDestinations() {
  return useQuery({
    queryKey: ['storage', 'destinations'],
    queryFn: ({ signal }) => fetchJson('/api/storage/destinations', destinations, { signal }),
  })
}

function useRefreshHistory() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['storage'] })
    qc.invalidateQueries({ queryKey: ['system'] })
  }
}

export function useCreateDestination() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: (n: NewDestination) => fetchJson('/api/storage/destinations', saved, put(n, 'POST')),
    onSuccess: refresh,
  })
}

export function useUpdateDestination() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: ({ id, ...u }: UpdateDestination & { id: number }) =>
      fetchJson(`/api/storage/destinations/${id}`, saved, put(u, 'PATCH')),
    onSuccess: refresh,
  })
}

export function useVerifyDestination() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: (id: number) => fetchJson(`/api/storage/destinations/${id}/verify`, verifyResult, put({}, 'POST')),
    onSuccess: refresh,
  })
}

export function useActivateDestination() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: (a: number | { id: number; copyHistory: boolean }) => {
      const { id, copyHistory } = typeof a === 'number' ? { id: a, copyHistory: false } : a
      return fetchJson(
        `/api/storage/destinations/${id}/activate`,
        destination,
        put({ copy_history: copyHistory }, 'POST'),
      )
    },
    onSuccess: refresh,
  })
}

const removeStarted = z.object({ job: historyJob }) satisfies z.ZodType<RemoveStarted>

/** Remove a destination: keep its data (204) or delete it first (202, a job). */
export function useRemoveDestination() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: async (a: number | { id: number; deleteHistory: boolean }): Promise<HistoryJob | null> => {
      const { id, deleteHistory } = typeof a === 'number' ? { id: a, deleteHistory: false } : a
      if (!deleteHistory) {
        await sendJson(`/api/storage/destinations/${id}`, put({ delete_history: false }, 'DELETE'))
        return null
      }
      const r = await fetchJson(
        `/api/storage/destinations/${id}`,
        removeStarted,
        put({ delete_history: true }, 'DELETE'),
      )
      return r.job
    },
    onSuccess: refresh,
  })
}

export function usePolicyPreview() {
  return useMutation({
    mutationFn: (retentionDays: number | null) =>
      fetchJson('/api/settings/history/preview', historyPreview, put({ retention_days: retentionDays }, 'POST')),
  })
}

/** A shorter window that deletes archived hours answers 409 with its preview: confirm and send again. */
export class ConfirmRequired extends Error {
  constructor(readonly preview: HistoryPreview) {
    super('confirm_required')
  }
}

export function useSetPolicy() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: async (p: HistoryPolicy & { confirm?: boolean }) => {
      try {
        return await fetchJson('/api/settings/history', historyPolicy, put(p))
      } catch (err) {
        if (err instanceof ApiError && err.code === 'confirm_required') {
          const preview = historyPreview.safeParse((err.body as { preview?: unknown } | undefined)?.preview)
          if (preview.success) throw new ConfirmRequired(preview.data)
        }
        throw err
      }
    },
    onSuccess: refresh,
  })
}

export function useBackfill() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: () => fetchJson('/api/storage/history/backfill', historyJob, put({}, 'POST')),
    onSuccess: refresh,
  })
}

export function useTurnOffHistory() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: () => sendJson('/api/storage/history/off', put({}, 'POST')),
    onSuccess: refresh,
  })
}

export function useSetCapacity() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: ({ id, bytes }: { id: number; bytes: number | null }) =>
      fetchJson(`/api/storage/destinations/${id}/capacity`, destination, put({ capacity_bytes: bytes })),
    onSuccess: refresh,
  })
}

export function useRetryCleanup() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: (id: number) =>
      fetchJson(`/api/storage/destinations/${id}/retry-cleanup`, destination, put({}, 'POST')),
    onSuccess: refresh,
  })
}

export function useJobAction() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'cancel' | 'retry' }) =>
      fetchJson(`/api/storage/jobs/${id}/${action}`, historyJob, put({}, 'POST')),
    onSuccess: refresh,
  })
}

export const KIND_LABEL: Record<DestinationKind, string> = {
  garage: 'Garage',
  r2: 'Cloudflare R2',
  s3: 'Amazon S3',
  s3_compatible: 'S3-compatible',
}

/** What each kind needs, with the placeholders the Connect storage dialog shows. */
export const KIND_HINT: Record<
  DestinationKind,
  { blurb: string; endpoint: string; region: string; needsEndpoint: boolean; pathStyle: boolean }
> = {
  garage: {
    blurb: 'In-house, next to quiet. make up-history starts it and connects it for you.',
    endpoint: 'http://garage:3900',
    region: 'garage',
    needsEndpoint: true,
    pathStyle: true,
  },
  r2: {
    blurb: 'Your Cloudflare account. Use an R2 API token with Object Read & Write on the bucket.',
    endpoint: 'https://<account id>.r2.cloudflarestorage.com',
    region: 'auto',
    needsEndpoint: true,
    pathStyle: false,
  },
  s3: {
    blurb: 'Your AWS account. The key needs s3:PutObject, GetObject, ListBucket and DeleteObject.',
    endpoint: 'leave empty for AWS',
    region: 'eu-west-1',
    needsEndpoint: false,
    pathStyle: false,
  },
  s3_compatible: {
    blurb: 'MinIO, Backblaze B2, Wasabi, Ceph or any S3 API.',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    needsEndpoint: true,
    pathStyle: true,
  },
}

export const GAP_LABEL: Record<GapReason, string> = {
  no_destination: 'no destination was active',
  destination_unavailable: 'the destination was unreachable until the disk cap dropped it',
  disk_cap: 'the disk cap dropped it before it left the window',
  excluded: 'only excluded sources',
  at_capacity: 'the destination was full (stop archiving) until the disk cap dropped it',
}

/** Settings → Storage → Retained history → Keep history for. */
export const RETENTION_CHOICES: { value: string; label: string; days: number | null }[] = [
  { value: '30', label: '30d', days: 30 },
  { value: '90', label: '90d', days: 90 },
  { value: '365', label: '1y', days: 365 },
  { value: 'custom', label: 'Custom', days: null },
  { value: 'forever', label: 'Indefinitely', days: null },
]

/** `30d`, `1y`, `45 days`, `indefinitely`. */
export function retentionLabel(days: number | null): string {
  if (days == null) return 'indefinitely'
  if (days === 365) return '1 year'
  return `${days} day${days === 1 ? '' : 's'}`
}
