import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query'
import type { ExportFormat, ExportParams, SearchParams } from '@/gen'
import { fetchJson } from '@/lib/api'
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

export const useSearchLines = (p: SearchParams, enabled = true) => useInfiniteQuery({ ...searchQuery(p), enabled })

export type ExportOptions = {
  format: ExportFormat
  gzip: boolean
  mask: boolean
  raw: boolean
  columns: string[]
}

/** The `/api/export` query string for these filters and options. */
export function exportQuery(p: SearchParams, o: ExportOptions): string {
  const e: ExportParams = {
    format: o.format,
    gzip: o.gzip ? '1' : undefined,
    mask: o.mask ? 'pii' : undefined,
    raw: o.raw && o.format !== 'ndjson' ? '1' : undefined,
    columns: o.format === 'csv' ? o.columns.join(',') : undefined,
  }
  return toQuery({ ...p, ...e })
}

export function exportFileName(p: SearchParams, o: ExportOptions, now = new Date()): string {
  const label = p.source && !p.source.includes(',') ? p.source.replace(/[^a-zA-Z0-9_-]/g, '-') : 'search'
  const day = now.toISOString().slice(0, 10)
  return `quiet-${label}-${day}.${o.format}${o.gzip ? '.gz' : ''}`
}

/** Mint a read-only `qx_` token for exactly this export and build the curl. */
export async function copyCurl(query: string, file: string, origin = window.location.origin) {
  const t = await fetchJson('/api/export/token', exportTokenResponse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const curl = `curl -fsS -H "Authorization: Bearer ${t.token}" \\\n  -o ${file} \\\n  "${origin}${t.path}"`
  return { ...t, curl }
}
