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

/** `14:07` in the viewer's local time. */
export function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 412000 → `412k`, 1_500_000 → `1.5M`. */
export function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Bytes for humans: `~4 KB`, `29 MB`. */
export function fmtBytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`
  return `${(n / 1e9).toFixed(1)} GB`
}

/** `24h`, `3d` from milliseconds. */
export function fmtWindow(ms: number): string {
  const h = Math.round(ms / 3_600_000)
  return h % 24 === 0 ? `${h / 24 === 1 ? 24 : h / 24}${h / 24 === 1 ? 'h' : 'd'}` : `${h}h`
}

/** `just now`, `42s ago`, `3m ago`, `18h ago`, `2d ago`. */
export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** `Oct 22` in the viewer's locale. */
export function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** `00:42` elapsed. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}
