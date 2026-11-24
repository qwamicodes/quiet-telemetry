import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { ExportFormat, GapRange, HistoryCoverage, HistorySearchJob, HistoryTimeline, SearchParams } from '@/gen'
import { fetchJson } from '@/lib/api'
import { historySearchJob } from '@/lib/schemas'
import { BUCKETS, toQuery } from '@/lib/search-api'

// Searching retained history (v0.1.1 Phase 5c): a background job per search
// that reaches past the local window. The search response says what history
// covers; the job downloads the archived hours and finds the matches.

const historyTimeline = z
  .object({
    from: z.number(),
    local_from: z.number().nullable(),
    now: z.number(),
    bars: z.array(z.object({ start: z.number(), end: z.number(), lines: z.number(), local: z.boolean() })),
  })
  .nullable() satisfies z.ZodType<HistoryTimeline | null>

/** What Search can reach, oldest first (`null` until history is enabled; v1.1-22). */
export const useHistoryTimeline = (enabled = true) =>
  useQuery({
    queryKey: ['history-timeline'],
    queryFn: ({ signal }) => fetchJson('/api/search/timeline', historyTimeline, { signal }),
    enabled,
    staleTime: 60_000,
  })

/** Matches fetched per page of a job's results. */
export const JOB_PAGE = 1000

export function startHistorySearch(p: SearchParams): Promise<HistorySearchJob> {
  return fetchJson('/api/search/history', historySearchJob, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: toQuery({ ...p, buckets: BUCKETS }) }),
  })
}

export function cancelHistorySearch(id: string): Promise<HistorySearchJob> {
  return fetchJson(`/api/search/history/${encodeURIComponent(id)}`, historySearchJob, { method: 'DELETE' })
}

export function historyExportUrl(id: string, format: ExportFormat, gzip = false): string {
  return `/api/search/history/${encodeURIComponent(id)}/export?${toQuery({ format, gzip: gzip ? '1' : undefined })}`
}

/** A job's state and matches, polled while it retrieves. */
export const useHistoryJob = (id: string | null) =>
  useQuery({
    queryKey: ['history-search', id],
    queryFn: ({ signal }) =>
      fetchJson(`/api/search/history/${encodeURIComponent(id ?? '')}?limit=${JOB_PAGE}`, historySearchJob, {
        signal,
      }),
    enabled: id != null,
    refetchInterval: (q) => (q.state.data?.state === 'retrieving' ? 500 : false),
  })

/**
 * The history job for one search: started on request (or at once when the
 * range reaches only a few hours back), forgotten when the search changes.
 */
export function useHistorySearch(params: SearchParams, coverage: HistoryCoverage | undefined) {
  const key = JSON.stringify(params)
  const [job, setJob] = useState<{ key: string; id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const current = job?.key === key ? job.id : null
  const q = useHistoryJob(current)
  const latest = useRef(key)
  latest.current = key
  const paramsRef = useRef(params)
  paramsRef.current = params

  const start = useCallback(async () => {
    const k = key
    setStarting(true)
    setError(null)
    try {
      const j = await startHistorySearch(paramsRef.current)
      if (latest.current === k) setJob({ key: k, id: j.id })
    } catch (e) {
      if (latest.current === k) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }, [key])

  const cancel = useCallback(async () => {
    if (current) await cancelHistorySearch(current).catch(() => undefined)
    q.refetch()
  }, [current, q])

  // A few hours back: searched along with the search (05.x).
  const auto = coverage?.auto ?? false
  const tried = useRef<string | null>(null)
  useEffect(() => {
    if (!auto || tried.current === key) return
    tried.current = key
    start()
  }, [auto, key, start])

  return { job: current ? (q.data ?? null) : null, start, cancel, starting, error }
}

/** `Garage` for the Garage quiet set up, else the connector's name. */
export const locationName = (name: string) => (name === 'garage-local' ? 'Garage' : name)

/** `09 Nov`, `21 Nov` (dates in history ranges). */
export function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

/** `09–21 Nov`, or `30 Oct–02 Nov` across months. */
export function fmtDays(from: number, to: number): string {
  const a = fmtDay(from)
  const b = fmtDay(Math.max(from, to - 1))
  if (a === b) return a
  const [da, ma] = a.split(' ')
  const [db, mb] = b.split(' ')
  return ma === mb ? `${da}–${db} ${mb}` : `${a}–${b}`
}

const GAP_REASON: Record<GapRange['reason'], string> = {
  no_destination: 'no destination was connected',
  destination_unavailable: 'the destination was unreachable',
  disk_cap: 'the disk cap dropped it first',
  excluded: 'its sources are excluded from history',
  at_capacity: 'the destination was full',
}

export const gapReasonText = (r: GapRange['reason']) => GAP_REASON[r]
