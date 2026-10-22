import { queryOptions, useQuery } from '@tanstack/react-query'
import type { Health, SourcesResponse } from '@/gen'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return (await res.json()) as T
}

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => getJson<Health>('/api/health'),
  refetchInterval: 5_000,
})

export const sourcesQuery = queryOptions({
  queryKey: ['sources'],
  queryFn: () => getJson<SourcesResponse>('/api/sources'),
  select: (d) => d.sources,
  refetchInterval: 3_000,
})

export const useHealth = () => useQuery(healthQuery)
export const useSources = () => useQuery(sourcesQuery)
