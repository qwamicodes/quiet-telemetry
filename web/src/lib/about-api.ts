import { queryOptions, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { About } from '@/gen'
import { fetchJson } from '@/lib/api'
import { dockerStatus } from '@/lib/schemas'

export const about = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  built: z.string().nullable(),
  started: z.number(),
  now: z.number(),
  store: z.string(),
  sqlite_version: z.string(),
  db_bytes: z.number(),
  data_dir: z.string().nullable(),
  live_clients: z.number(),
  members: z.number(),
  docker: dockerStatus,
}) satisfies z.ZodType<About>

export const aboutQuery = queryOptions({
  queryKey: ['about'],
  queryFn: ({ signal }) => fetchJson('/api/about', about, { signal }),
  refetchInterval: 30_000,
})

export const useAbout = () => useQuery(aboutQuery)

// ---- update check (browser → GitHub releases, only when switched on) ----------------

export const REPO = 'qwamicodes/quiet-telemetry'
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
export const REPO_URL = `https://github.com/${REPO}`
/** What the About page tells owners to run on the host. */
export const UPDATE_COMMAND = 'docker compose pull quiet && docker compose up -d quiet'

export const release = z.object({
  tag_name: z.string(),
  name: z.string().nullable().catch(null),
  html_url: z.string(),
  published_at: z.string().nullable().catch(null),
  body: z.string().nullable().catch(null),
})
export type Release = z.infer<typeof release>

/** `v0.1.10` → [0, 1, 10]; pre-release suffixes are ignored. */
export function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
}

/** > 0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** `patch` / `minor` / `major` for the callout. */
export function bumpKind(latest: string, running: string): 'major' | 'minor' | 'patch' {
  const [a, b] = [parseVersion(latest), parseVersion(running)]
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return 'major'
  if ((a[1] ?? 0) !== (b[1] ?? 0)) return 'minor'
  return 'patch'
}

/** The first few `- ` / `* ` bullets of release notes. */
export function releaseBullets(body: string | null, max = 5): string[] {
  return (body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*] /.test(l))
    .map((l) =>
      l
        .slice(2)
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim(),
    )
    .slice(0, max)
}

const CACHE = 'quiet.update-check'
const DAY = 86_400_000

/** Latest release, at most one GitHub request per browser per day. */
async function latestRelease(signal?: AbortSignal): Promise<Release> {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) ?? 'null')
    if (c && Date.now() - c.at < DAY) return release.parse(c.release)
  } catch {
    // no cache
  }
  const res = await fetch(RELEASES_API, { signal, headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(res.status === 404 ? 'No releases published yet' : `GitHub said ${res.status}`)
  const r = release.parse(await res.json())
  try {
    localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), release: r }))
  } catch {
    // storage blocked: check again next time
  }
  return r
}

/** Nothing leaves the browser unless `enabled` (Settings → About → Check for updates). */
export function useLatestRelease(enabled: boolean) {
  return useQuery({
    queryKey: ['latest-release'],
    queryFn: ({ signal }) => latestRelease(signal),
    enabled,
    staleTime: DAY,
    retry: false,
  })
}

export function clearUpdateCache() {
  try {
    localStorage.removeItem(CACHE)
  } catch {
    // ignore
  }
}
