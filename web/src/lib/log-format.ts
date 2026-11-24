import { queryOptions, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { FormatReport } from '@/gen'
import { fetchJson } from '@/lib/api'

/** Which logging contract a source writes (v0.1.1-00.3). */
export const logFormat = z.enum(['v0.1.0', 'v0.1.1'])

export const formatReport = z.object({
  source: z.string(),
  sample: z.number(),
  old: z.number(),
  new: z.number(),
  other: z.number(),
  tag: logFormat.nullable(),
  last_old: z.number().nullable(),
  last_new: z.number().nullable(),
  changes: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      count: z.number(),
      old_format: z.boolean(),
    }),
  ),
  rollout: z.array(z.object({ start: z.number(), old: z.number(), new: z.number() })),
  now: z.number(),
}) satisfies z.ZodType<FormatReport>

export const formatQuery = (source: string) =>
  queryOptions({
    queryKey: ['source-format', source],
    queryFn: ({ signal }) => fetchJson(`/api/sources/${encodeURIComponent(source)}/format`, formatReport, { signal }),
    refetchInterval: 30_000,
  })

export const useSourceFormat = (source: string) => useQuery(formatQuery(source))

/**
 * Per change: what v0.1.1 expects (mono), why (one sentence) and the prompt
 * step, in the words of the v0.1.1 prompt (00.3).
 */
export const CHANGE_COPY: Record<string, { writes: string; expects: string; why: string; step: string }> = {
  outcome: {
    writes: '"outcome": "failed"',
    expects: '"level": "error" + "error": { … }',
    why: 'No outcome field. The level and the error say what happened.',
    step: 'Drop outcome; set level from the error.',
  },
  wide_events_calls: {
    writes: '"wideEvents.calls": [ … ]',
    expects: 'business fields straight on the event',
    why: 'Put business fields straight on the event. No calls list or wrapper.',
    step: 'Move wideEvents.calls data onto the event.',
  },
  msg_without_flow: {
    writes: '"msg" without "flow"',
    expects: '"flow": "<operation_name>"',
    why: 'The business name labels the row in Stream and Flow.',
    step: 'msg → flow with the business name.',
  },
  status: {
    writes: '"status": 201',
    expects: '"status_code": 201',
    why: 'A number, so Search can filter status_code>=500.',
    step: 'status → status_code, a number.',
  },
  err: {
    writes: '"err": { … }',
    expects: '"error": { code, message, reason, details }',
    why: 'Keep reason and details as their own JSON types.',
    step: 'Make error an object; keep reason and details types.',
  },
  job_scope: {
    writes: '"job_id" without "queue"',
    expects: '"job_id" + "queue" + "attempt"',
    why: "Jobs keep the queue's own id plus its queue.",
    step: "Add queue and attempt next to the queue's own job_id.",
  },
}

/**
 * A changes-only prompt for a v0.1.0 codebase: only what this source still
 * writes the old way, nothing it already does right.
 */
export function upgradePrompt(source: string, r: FormatReport): string {
  return [
    `Update ${source}'s existing logging to the quiet v0.1.1 format. Keep the current logger, job wrapper and handlers; change only what each event contains.`,
    ...r.changes.map((c, i) => `${i + 1}. ${CHANGE_COPY[c.id]?.step ?? `${c.from} → ${c.to}.`}`),
    "Keep the queue's job_id and queue. Run the existing tests and report anything unverified.",
  ].join('\n')
}
