import { z } from 'zod'
import type {
  Bucket,
  CorrId,
  DockerStatus,
  ExportTokenResponse,
  Health,
  Level,
  LogLine,
  SearchResponse,
  SourceInfo,
  SourcesResponse,
} from '@/gen'

/**
 * Runtime checks for what the server sends over REST. The TypeScript types are
 * generated from Rust (src/gen); each schema `satisfies z.ZodType<T>`, so tsc
 * fails when a schema and its generated type drift apart.
 *
 * The WebSocket stream is not parsed with zod: at thousands of lines a second
 * a full parse per frame costs more than it protects (see use-stream.ts).
 */
export const level = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']) satisfies z.ZodType<Level>

export const corrId = z.object({
  key: z.enum(['request_id', 'job_id', 'trace_id', 'correlation_id']),
  value: z.string(),
}) satisfies z.ZodType<CorrId>

export const logLine = z.object({
  id: z.number(),
  ts: z.number(),
  received: z.number(),
  source: z.string(),
  level: level.nullable(),
  display_id: corrId.nullable(),
  ids: z.array(corrId),
  msg: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
  raw: z.string(),
  flags: z.array(z.string()).optional(),
}) satisfies z.ZodType<LogLine>

export const dockerStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disabled') }),
  z.object({ state: z.literal('connecting') }),
  z.object({ state: z.literal('connected'), containers: z.number() }),
  z.object({ state: z.literal('unavailable'), error: z.string() }),
]) satisfies z.ZodType<DockerStatus>

export const health = z.object({
  ok: z.boolean(),
  version: z.string(),
  started: z.number(),
  docker: dockerStatus,
  store: z.string(),
  retention_ms: z.number(),
  disk_bytes: z.number(),
  stored_lines: z.number(),
  oldest: z.number().nullable(),
}) satisfies z.ZodType<Health>

export const sourceInfo = z.object({
  name: z.string(),
  kind: z.enum(['docker', 'http']),
  containers: z.array(z.string()),
  group: z.string().nullable(),
  lines: z.number(),
  last_ts: z.number().nullable(),
}) satisfies z.ZodType<SourceInfo>

export const sourcesResponse = z.object({ sources: z.array(sourceInfo) }) satisfies z.ZodType<SourcesResponse>

export const bucket = z.object({
  start: z.number(),
  count: z.number(),
  warn: z.number(),
  error: z.number(),
}) satisfies z.ZodType<Bucket>

export const searchResponse = z.object({
  lines: z.array(logLine),
  next_cursor: z.string().nullable(),
  total: z.number().nullable(),
  bytes: z.number().nullable(),
  histogram: z.array(bucket).nullable(),
  searched: z.number(),
  took_ms: z.number(),
  since: z.number(),
  until: z.number(),
}) satisfies z.ZodType<SearchResponse>

export const exportTokenResponse = z.object({
  token: z.string().startsWith('qx_'),
  expires_at: z.number(),
  path: z.string().startsWith('/api/export?'),
}) satisfies z.ZodType<ExportTokenResponse>
