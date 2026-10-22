import { queryOptions, useQueries, useQuery } from '@tanstack/react-query'
import type { FlowNotFound, FlowResponse, FlowSummary } from '@/gen'
import { ApiError, fetchJson } from '@/lib/api'
import { flowNotFound, flowResponse, flowSummariesResponse } from '@/lib/schemas'

/** What the flow page opens: a correlation id (any key) or one line. */
export type FlowTarget = { id: string } | { line: number }

export type FlowResult = ({ found: true } & FlowResponse) | ({ found: false } & FlowNotFound)

/** `GET /api/flow`: a 404 with close matches is a result, not an error. */
export async function fetchFlow(t: FlowTarget, signal?: AbortSignal): Promise<FlowResult> {
  const qs = 'id' in t ? `id=${encodeURIComponent(t.id)}` : `line=${t.line}`
  const url = `/api/flow?${qs}`
  const res = await fetch(url, { signal })
  const body: unknown = await res.json().catch(() => null)
  if (res.ok) return { found: true, ...flowResponse.parse(body) }
  if (res.status === 404) {
    const nf = flowNotFound.safeParse(body)
    if (nf.success) return { found: false, ...nf.data }
    // `?line=` for an expired line: no close matches to offer.
    return {
      found: false,
      error: (body as { error?: string } | null)?.error ?? 'not found',
      id: 'id' in t ? t.id : `line ${t.line}`,
      close: [],
      since: 0,
      until: 0,
    }
  }
  throw new ApiError(url, res.status, (body as { error?: string } | null)?.error ?? `${url}: ${res.status}`)
}

export const flowQuery = (t: FlowTarget) =>
  queryOptions({
    queryKey: ['flow', t],
    queryFn: ({ signal }) => fetchFlow(t, signal),
    staleTime: 5_000,
  })

export const useFlow = (t: FlowTarget) => useQuery(flowQuery(t))

/** Ids asked for within one tick go out as one `POST /api/flow-summaries`. */
const MAX_BATCH = 100
let pending = new Map<string, { resolve: (f: FlowSummary | null) => void; reject: (e: unknown) => void }[]>()
let scheduled = false

async function send(batch: typeof pending) {
  const ids = [...batch.keys()]
  try {
    const r = await fetchJson('/api/flow-summaries', flowSummariesResponse, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    const by = new Map(r.flows.map((f) => [f.id, f.flow]))
    for (const [id, waiters] of batch) for (const w of waiters) w.resolve(by.get(id) ?? null)
  } catch (e) {
    for (const waiters of batch.values()) for (const w of waiters) w.reject(e)
  }
}

function flushSummaries() {
  scheduled = false
  const all = pending
  pending = new Map()
  const entries = [...all.entries()]
  for (let i = 0; i < entries.length; i += MAX_BATCH) void send(new Map(entries.slice(i, i + MAX_BATCH)))
}

export function loadSummary(id: string): Promise<FlowSummary | null> {
  return new Promise((resolve, reject) => {
    const waiters = pending.get(id) ?? []
    waiters.push({ resolve, reject })
    pending.set(id, waiters)
    if (!scheduled) {
      scheduled = true
      setTimeout(flushSummaries, 30)
    }
  })
}

export const summaryQuery = (id: string) =>
  queryOptions({
    queryKey: ['flow-summary', id],
    queryFn: () => loadSummary(id),
    // A young flow keeps growing (the worker logs after the request): refresh.
    staleTime: 15_000,
  })

/** Summaries for these ids (deduped, batched); a map of what has arrived. */
export function useFlowSummaries(ids: string[]): Map<string, FlowSummary | null> {
  const unique = [...new Set(ids)]
  return useQueries({
    queries: unique.map((id) => summaryQuery(id)),
    combine: (results) => {
      const m = new Map<string, FlowSummary | null>()
      results.forEach((r, i) => {
        if (r.data !== undefined) m.set(unique[i], r.data)
      })
      return m
    },
  })
}
