import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ExportFormat, ExportParams, MutedMode, SearchParams } from '@/gen'
import { fetchJson } from '@/lib/api'
import { publicOrigin } from '@/lib/format'
import { exportTokenResponse, searchResponse } from '@/lib/schemas'

/** Lines per search page; the first page also brings the histogram. */
export const PAGE = 200
export const BUCKETS = 60

/** `SearchParams` → a query string (empty values dropped, keys sorted like the server's). */
export function toQuery(p: Record<string, string | number | undefined | null>): string {
  return Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

export const searchQuery = (p: SearchParams) =>
  infiniteQueryOptions({
    queryKey: ['search', p],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchJson(
        `/api/search?${toQuery({
          ...p,
          limit: PAGE,
          cursor: pageParam,
          buckets: pageParam ? undefined : BUCKETS,
        })}`,
        searchResponse,
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 10_000,
  })

/**
 * A changed query keeps the previous results as placeholder data
 * (`isPlaceholderData`) until the new first page lands: the page dims them
 * instead of flashing "no lines match" or skeletons over a populated list.
 */
export const useSearchLines = (p: SearchParams, enabled = true) =>
  useInfiniteQuery({ ...searchQuery(p), enabled, placeholderData: keepPreviousData })

/**
 * The whole range's total and histogram while the results are re-anchored at
 * a histogram bar (`at=`): one line, `buckets` bars, cached like a search.
 */
export const useSearchOverview = (p: SearchParams, enabled: boolean) =>
  useQuery({
    queryKey: ['search-overview', p],
    queryFn: ({ signal }) =>
      fetchJson(`/api/search?${toQuery({ ...p, limit: 1, buckets: BUCKETS })}`, searchResponse, { signal }),
    enabled,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  })

export type ExportOptions = {
  format: ExportFormat
  gzip: boolean
  mask: boolean
  raw: boolean
  columns: string[]
}

/**
 * The `/api/export` query string for these filters and options. `muted`
 * (search's current state) leaves muted lines out (`hide`) or follows each
 * source's setting (`auto`); `include` is the server's default, so omitted.
 */
export function exportQuery(p: SearchParams, o: ExportOptions, muted?: MutedMode): string {
  const e: ExportParams = {
    format: o.format,
    gzip: o.gzip ? '1' : undefined,
    mask: o.mask ? 'pii' : undefined,
    raw: o.raw && o.format !== 'ndjson' ? '1' : undefined,
    columns: o.format === 'csv' ? o.columns.join(',') : undefined,
    muted: muted && muted !== 'include' ? muted : undefined,
  }
  return toQuery({ ...p, ...e })
}

export function exportFileName(p: SearchParams, o: ExportOptions, now = new Date()): string {
  const label = p.source && !p.source.includes(',') ? p.source.replace(/[^a-zA-Z0-9_-]/g, '-') : 'search'
  const day = now.toISOString().slice(0, 10)
  return `quiet-${label}-${day}.${o.format}${o.gzip ? '.gz' : ''}`
}

/** Mint a read-only `qx_` token for exactly this export and build the curl. */
export async function copyCurl(query: string, file: string, origin = publicOrigin()) {
  const t = await fetchJson('/api/export/token', exportTokenResponse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const curl = `curl -fsS -H "Authorization: Bearer ${t.token}" \\\n  -o ${file} \\\n  "${origin}${t.path}"`
  return { ...t, curl }
}
