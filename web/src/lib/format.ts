import type { Level } from '@/gen'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `14:07:04.120` in the viewer's local time. */
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** Levels a user can filter by, lowest first. `''` means all. */
export const LEVEL_FILTERS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly Level[]
export type LevelFilter = (typeof LEVEL_FILTERS)[number] | ''

const RANK: Record<Level, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }

export function atLeast(level: Level | null, min: LevelFilter): boolean {
  if (!min) return true
  return level != null && RANK[level] >= RANK[min]
}

/** A source is "live" when it logged in the last minute. */
export function isRecent(ts: number | null, now = Date.now()): boolean {
  return ts != null && now - ts < 60_000
}

export function bytes(s: string): number {
  return new TextEncoder().encode(s).length
}
