import { useQueries, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { LintCheck, LintReport, LintStatus } from '@/gen'
import { fetchJson } from '@/lib/api'

export const lintStatus = z.enum(['pass', 'warn', 'fail', 'review', 'optional', 'na']) satisfies z.ZodType<LintStatus>

export const lintCheck = z.object({
  id: z.string(),
  title: z.string(),
  status: lintStatus,
  share: z.number().nullable(),
  detail: z.string(),
  fix: z.string(),
  // 11.6 Failing fields · excerpt; older servers send none.
  failing: z
    .array(z.object({ line_id: z.number(), ts: z.number(), note: z.string(), excerpt: z.string() }))
    .default([]),
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

/**
 * The Guide nav dot (11.6 A): on while no source passes Check my logs.
 * Reads the newest few sources only, and rarely.
 */
export function useNoSourcePasses(sources: string[]): boolean {
  const results = useQueries({
    queries: sources.slice(0, 6).map((s) => ({
      queryKey: ['lint', s],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchJson(`/api/sources/${encodeURIComponent(s)}/lint`, lintReport, { signal }),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })
  if (results.length === 0 || results.some((r) => !r.data)) return false
  return !results.some((r) => r.data && r.data.applicable > 0 && r.data.passed === r.data.applicable)
}
