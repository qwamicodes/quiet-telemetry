import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type {
  Destination,
  DestinationKind,
  DestinationSaved,
  DestinationsResponse,
  GapReason,
  HistoryGap,
  HistoryStatus,
  NewDestination,
  UpdateDestination,
  VerifyResult,
  VerifyStep,
} from '@/gen'
import { fetchJson, sendJson } from '@/lib/api'
import { put } from '@/lib/settings-api'

// Retained history (v0.1.1 Phase 5a): destinations, verify, status.

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
}) satisfies z.ZodType<Destination>

const gapReason = z.enum([
  'no_destination',
  'destination_unavailable',
  'disk_cap',
  'excluded',
]) satisfies z.ZodType<GapReason>

const historyGap = z.object({
  hour: z.number(),
  reason: gapReason,
  at: z.number(),
}) satisfies z.ZodType<HistoryGap>

export const historyStatus = z.object({
  enabled: z.boolean(),
  enabled_at: z.number().nullable(),
  instance_id: z.string(),
  active: z.number().nullable(),
  destinations: z.array(destination),
  gaps: z.array(historyGap),
  gap_hours: z.number(),
  waiting_hours: z.number(),
}) satisfies z.ZodType<HistoryStatus>

const destinations = z.object({ destinations: z.array(destination) }) satisfies z.ZodType<DestinationsResponse>
const saved = z.object({ destination, verify: verifyResult }) satisfies z.ZodType<DestinationSaved>

export const HISTORY_KEY = ['storage', 'history'] as const

export function useHistory() {
  return useQuery({
    queryKey: HISTORY_KEY,
    queryFn: ({ signal }) => fetchJson('/api/storage/history', historyStatus, { signal }),
    refetchInterval: 15_000,
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
    mutationFn: (id: number) =>
      fetchJson(`/api/storage/destinations/${id}/activate`, destination, put({ copy_history: false }, 'POST')),
    onSuccess: refresh,
  })
}

export function useRemoveDestination() {
  const refresh = useRefreshHistory()
  return useMutation({
    mutationFn: (id: number) => sendJson(`/api/storage/destinations/${id}`, put({ delete_history: false }, 'DELETE')),
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
}
