import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { DetectedField, IdCoverage, LevelTally, MalformedLine, SourceFields, StreamStats } from '@/gen'
import { fetchJson } from '@/lib/api'
import { bucket, corrId } from '@/lib/schemas'

export const levelTally = z.object({
  debug: z.number(),
  info: z.number(),
  warn: z.number(),
  error: z.number(),
  none: z.number(),
}) satisfies z.ZodType<LevelTally>

export const streamStats = z.object({
  total: z.number(),
  levels: levelTally,
  histogram: z.array(bucket),
  since: z.number(),
  until: z.number(),
  hist_since: z.number(),
  hist_width: z.number(),
}) satisfies z.ZodType<StreamStats>

export const detectedField = z.object({
  key: z.string(),
  kind: z.string(),
  coverage: z.number(),
  sample: z.string(),
}) satisfies z.ZodType<DetectedField>

export const idCoverage = z.object({
  key: corrId.shape.key,
  coverage: z.number(),
  shown: z.number(),
}) satisfies z.ZodType<IdCoverage>

export const malformedLine = z.object({
  id: z.number(),
  ts: z.number(),
  reason: z.string(),
  raw: z.string(),
}) satisfies z.ZodType<MalformedLine>

export const sourceFields = z.object({
  sampled: z.number(),
  json: z.number(),
  fields: z.array(detectedField),
  ids: z.array(idCoverage),
  malformed_total: z.number(),
  malformed: z.array(malformedLine),
}) satisfies z.ZodType<SourceFields>

/**
 * Level counts (24h window) and the last hour's volume for the stream. Counted
 * on the server; refreshed every 15s, and the page adds live lines in between.
 */
export function useStreamStats(source: string | null, q: string | undefined) {
  return useQuery({
    queryKey: ['stream-stats', source, q ?? ''],
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ source: source ?? '' })
      if (q) p.set('q', q)
      return fetchJson(`/api/stream/stats?${p}`, streamStats, { signal })
    },
    enabled: Boolean(source),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  })
}

export function useSourceFields(name: string) {
  return useQuery({
    queryKey: ['source-fields', name],
    queryFn: ({ signal }) =>
      fetchJson(`/api/sources/${encodeURIComponent(name)}/fields?sample=1000`, sourceFields, { signal }),
    refetchInterval: 30_000,
  })
}
