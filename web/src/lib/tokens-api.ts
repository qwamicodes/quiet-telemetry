import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateIngestToken } from '@/gen'
import { fetchJson } from '@/lib/api'
import { createdIngestToken, ingestToken, ingestTokensResponse } from '@/lib/schemas'

/** Ingest tokens (`qi_…`, send-only). The list never carries a secret. */
export const tokensQuery = queryOptions({
  queryKey: ['ingest-tokens'],
  queryFn: () => fetchJson('/api/ingest-tokens', ingestTokensResponse),
  select: (d) => d.tokens,
  refetchInterval: 10_000,
})

export const useTokens = () => useQuery(tokensQuery)

/** Mint a token; the secret in the result is shown once. */
export function useCreateToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateIngestToken) =>
      fetchJson('/api/ingest-tokens', createdIngestToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ingest-tokens'] }),
  })
}

export function useRevokeToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => fetchJson(`/api/ingest-tokens/${id}`, ingestToken, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ingest-tokens'] }),
  })
}

/** Undo a revoke (the server allows it for a minute; 409 after). */
export function useRestoreToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => fetchJson(`/api/ingest-tokens/${id}/restore`, ingestToken, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ingest-tokens'] }),
  })
}

/** `qi_8d1f…1a77` → `qi_••••••••••••1a77`, for showing a secret without showing it. */
export const maskSecret = (secret: string) => `${secret.slice(0, 3)}${'•'.repeat(12)}${secret.slice(-4)}`
