import { z } from 'zod'
import type {
  Bucket,
  ChildStep,
  CloseMatch,
  CorrId,
  CreatedIngestToken,
  DockerStatus,
  ExportTokenResponse,
  Flow,
  FlowEdge,
  FlowNode,
  FlowNotFound,
  FlowResponse,
  FlowSummariesResponse,
  FlowSummary,
  Health,
  IngestInfo,
  IngestToken,
  IngestTokensResponse,
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

export const ingestInfo = z.object({
  auth: z.enum(['token', 'open']),
  loopback: z.boolean(),
  max_body: z.number(),
  rate: z.number(),
  tokens: z.number(),
}) satisfies z.ZodType<IngestInfo>

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
  ingest: ingestInfo,
}) satisfies z.ZodType<Health>

export const sourceInfo = z.object({
  name: z.string(),
  kind: z.enum(['docker', 'http', 'vector', 'fluentbit', 'otlp']),
  containers: z.array(z.string()),
  group: z.string().nullable(),
  group_kind: z.enum(['compose', 'stack', 'standalone', 'ingest']).nullable().catch(null),
  lines: z.number(),
  last_ts: z.number().nullable(),
  display_name: z.string().nullable(),
  hidden: z.boolean(),
  paused: z.boolean(),
}) satisfies z.ZodType<SourceInfo>

export const sourcesResponse = z.object({ sources: z.array(sourceInfo) }) satisfies z.ZodType<SourcesResponse>

export const bucket = z.object({
  start: z.number(),
  count: z.number(),
  debug: z.number(),
  info: z.number(),
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

export const childStep = z.object({
  name: z.string(),
  summary: z.string(),
  at_ms: z.number().nullable(),
  duration_ms: z.number().nullable(),
  error: z.boolean(),
}) satisfies z.ZodType<ChildStep>

export const flowNode = z.object({
  index: z.number(),
  line_id: z.number(),
  source: z.string(),
  level: level.nullable(),
  ts: z.number(),
  start: z.number(),
  duration_ms: z.number().nullable(),
  offset_ms: z.number(),
  name: z.string(),
  summary: z.string(),
  error: z.boolean(),
  warn: z.boolean(),
  attempt: z.number().nullable(),
  children: z.array(childStep),
  span_id: z.string().nullable(),
  parent: z.number().nullable(),
  depth: z.number(),
}) satisfies z.ZodType<FlowNode>

export const flowEdge = z.object({
  from: z.number(),
  to: z.number(),
  kind: z.enum(['next', 'retry', 'handoff', 'child']),
  via: corrId.nullable(),
  gap_ms: z.number(),
}) satisfies z.ZodType<FlowEdge>

export const flowSummary = z.object({
  key: z.string(),
  title: z.string(),
  status: z.enum(['ok', 'warn', 'error']),
  line_count: z.number(),
  steps: z.number(),
  sources: z.array(z.string()),
  started: z.number(),
  ended: z.number(),
  duration_ms: z.number(),
  retries: z.number(),
  errors: z.number(),
  warnings: z.number(),
  ids: z.array(corrId),
  stitched_by: z.array(corrId.shape.key),
  truncated: z.boolean(),
}) satisfies z.ZodType<FlowSummary>

export const flow = flowSummary.extend({
  opened: corrId.nullable(),
  nodes: z.array(flowNode),
  edges: z.array(flowEdge),
  lines: z.array(logLine),
  missing_parent: corrId.nullable(),
  partial: z.boolean(),
  span_tree: z.boolean(),
}) satisfies z.ZodType<Flow>

export const flowResponse = z.object({
  flow,
  since: z.number(),
  until: z.number(),
  took_ms: z.number(),
}) satisfies z.ZodType<FlowResponse>

export const closeMatch = z.object({
  key: corrId.shape.key,
  value: z.string(),
  msg: z.string(),
  ts: z.number(),
  source: z.string(),
}) satisfies z.ZodType<CloseMatch>

export const flowNotFound = z.object({
  error: z.string(),
  id: z.string(),
  close: z.array(closeMatch),
  since: z.number(),
  until: z.number(),
}) satisfies z.ZodType<FlowNotFound>

export const flowSummariesResponse = z.object({
  flows: z.array(z.object({ id: z.string(), flow: flowSummary.nullable() })),
}) satisfies z.ZodType<FlowSummariesResponse>

export const ingestToken = z.object({
  id: z.number(),
  name: z.string(),
  preview: z.string(),
  source: z.string().nullable(),
  created: z.number(),
  last_used: z.number().nullable(),
  revoked: z.number().nullable(),
}) satisfies z.ZodType<IngestToken>

export const ingestTokensResponse = z.object({ tokens: z.array(ingestToken) }) satisfies z.ZodType<IngestTokensResponse>

export const createdIngestToken = z.object({
  token: ingestToken,
  secret: z.string().startsWith('qi_'),
}) satisfies z.ZodType<CreatedIngestToken>
