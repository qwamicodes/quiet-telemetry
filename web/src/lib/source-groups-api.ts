import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type { CreatedSourceGroup, CustomGroup, CustomGroups } from '@/gen'
import { fetchJson, sourcesQuery } from '@/lib/api'
import { customGroup } from '@/lib/schemas'

/** Custom group names: 1–48 characters, same rule as the server. */
export const MAX_GROUP_NAME = 48

export const customGroups = z.object({
  groups: z.array(customGroup),
  assigned: z.record(z.string(), z.string()),
}) satisfies z.ZodType<CustomGroups>

const createdSourceGroup = z.object({
  group: customGroup,
  groups: customGroups,
}) satisfies z.ZodType<CreatedSourceGroup>

/**
 * The custom groups, in display order (read from `/api/sources`, the same
 * poll the sidebar and the Sources page already make). Kept when grouping is
 * off.
 */
export function useCustomGroups(): CustomGroup[] {
  return useQuery({ ...sourcesQuery, select: (d) => d.custom_groups }).data ?? []
}

const body = (b: unknown, method: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
})

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['sources'] })
    qc.invalidateQueries({ queryKey: ['grouping-preview'] })
  }
}

/** Sources → New group (with the sources picked in the dialog). Owners and admins. */
export function useCreateGroup() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (b: { name: string; sources?: string[] }) =>
      fetchJson('/api/source-groups', createdSourceGroup, body(b, 'POST')),
    onSuccess: refresh,
  })
}

/** Rename and/or move a custom group (`order`: 0 = first). */
export function useUpdateGroup() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ id, ...b }: { id: string; name?: string; order?: number }) =>
      fetchJson(`/api/source-groups/${encodeURIComponent(id)}`, customGroups, body(b, 'PATCH')),
    onSuccess: refresh,
  })
}

/** Delete a custom group: its sources go back to automatic grouping. No lines are deleted. */
export function useDeleteGroup() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/source-groups/${encodeURIComponent(id)}`, customGroups, { method: 'DELETE' }),
    onSuccess: refresh,
  })
}

/** Move sources into a custom group, or back to automatic grouping with `group: null`. */
export function useAssignSources() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (b: { sources: string[]; group: string | null }) =>
      fetchJson('/api/source-groups/assign', customGroups, body(b, 'PUT')),
    onSuccess: refresh,
  })
}
