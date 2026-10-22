import { queryOptions, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { health, sourcesResponse } from '@/lib/schemas'
import { apiFetch } from '@/lib/session'

export class ApiError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
    /** The server's machine-readable reason (`owner_only`, `csrf`, `last_owner`, …). */
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

/** GET (or POST) JSON and check its shape; a mismatch is a loud error, not a silent undefined. */
export async function fetchJson<S extends z.ZodType>(url: string, schema: S, init?: RequestInit): Promise<z.output<S>> {
  const res = await apiFetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
    throw new ApiError(url, res.status, body?.error ?? `${url}: ${res.status}`, body?.code, body)
  }
  return schema.parse(await res.json())
}

/** A write that answers 204 No Content (sign out, reset accept, …). */
export async function sendJson(url: string, init: RequestInit): Promise<void> {
  const res = await apiFetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
    throw new ApiError(url, res.status, body?.error ?? `${url}: ${res.status}`, body?.code, body)
  }
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
