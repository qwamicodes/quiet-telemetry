import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { LintCheck, LintReport, LintStatus } from '@/gen'
import { fetchJson } from '@/lib/api'

export const lintStatus = z.enum(['pass', 'warn', 'fail', 'na']) satisfies z.ZodType<LintStatus>

export const lintCheck = z.object({
  id: z.string(),
  title: z.string(),
  status: lintStatus,
  share: z.number().nullable(),
  detail: z.string(),
  fix: z.string(),
}) satisfies z.ZodType<LintCheck>

export const lintReport = z.object({
  source: z.string(),
  sampled: z.number(),
  passed: z.number(),
  applicable: z.number(),
  checks: z.array(lintCheck),
}) satisfies z.ZodType<LintReport>

/** Guide → Check my logs: the scorecard for one source's newest lines. */
export function useLint(source: string | null) {
  return useQuery({
    queryKey: ['lint', source],
    queryFn: ({ signal }) => fetchJson(`/api/sources/${encodeURIComponent(source ?? '')}/lint`, lintReport, { signal }),
    enabled: !!source,
    staleTime: 15_000,
  })
}
