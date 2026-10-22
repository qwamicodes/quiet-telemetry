import { queryOptions, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { health, sourcesResponse } from '@/lib/schemas'

export class ApiError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** GET (or POST) JSON and check its shape; a mismatch is a loud error, not a silent undefined. */
export async function fetchJson<S extends z.ZodType>(url: string, schema: S, init?: RequestInit): Promise<z.output<S>> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(url, res.status, body?.error ?? `${url}: ${res.status}`)
  }
  return schema.parse(await res.json())
}

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => fetchJson('/api/health', health),
  refetchInterval: 5_000,
})

export const sourcesQuery = queryOptions({
  queryKey: ['sources'],
  queryFn: () => fetchJson('/api/sources', sourcesResponse),
  select: (d) => d.sources,
  refetchInterval: 3_000,
})

export const useHealth = () => useQuery(healthQuery)
export const useSources = () => useQuery(sourcesQuery)
