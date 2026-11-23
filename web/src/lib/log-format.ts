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

/** What to tell the agent for each change, in the words of the v0.1.1 prompt. */
const HOW: Record<string, string> = {
  outcome:
    'Remove `outcome`. Set `level` instead (error for a recorded error or HTTP ≥ 400, warn for a slow success, info otherwise), keep `status_code`, and add a typed `error { name, code, message, reason }` when the work failed.',
  wide_events_calls:
    'Remove `wideEvents.calls`. Write one canonical completion event per request or job attempt; when a dependency call failed, put that call in `error.details`.',
  msg_without_flow:
    'Add `flow`, the operation name in snake_case (`create_payout`), to every completion event. `msg` may stay for humans but is not read.',
  status: 'Rename `status` (the HTTP status) to `status_code`, a number.',
  err: 'Rename `err` to `error` with `name`, `code`, `message` and, when you know it, `reason`.',
  job_scope:
    'Keep the queue’s own job id as `job_id` and add `queue` and `attempt` (the attempt number the queue gives) to every job event.',
}

/**
 * A changes-only prompt for a v0.1.0 codebase: only what this source still
 * writes the old way, nothing it already does right.
 */
export function upgradePrompt(source: string, r: FormatReport): string {
  const lines = [
    `# Upgrade ${source} to the quiet v0.1.1 logging contract`,
    '',
    `quiet read the newest ${r.sample.toLocaleString('en-US')} records from ${source}. Make only these changes; keep everything else your logger does today.`,
    '',
    '## Changes',
    '',
    ...r.changes.map((c, i) =>
      `${i + 1}. \`${c.from}\` → ${c.to} (${c.count.toLocaleString('en-US')} records). ${HOW[c.id] ?? ''}`.trimEnd(),
    ),
    '',
    '## Keep',
    '',
    '- `request_id` on every request, passed into the jobs it enqueues.',
    '- Credentials written as `[REDACTED]` before the log is written (quiet redacts them again on arrival).',
    '- Records already sent: quiet keeps reading them, nothing to migrate.',
    '',
    '## Verify',
    '',
    `Deploy, then open quiet → Sources → ${source} → Upgrade. New records count as v0.1.1 as they arrive; the \`v0.1.0\` tag clears 24 hours after the last old-format record.`,
    '',
    'The full contract is in quiet → Guide → Instrument with an agent.',
  ]
  return lines.join('\n')
}
