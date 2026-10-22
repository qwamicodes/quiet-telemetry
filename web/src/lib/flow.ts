import type { DotTone } from '@/components/status-dot'
import type { Flow, FlowNode, FlowSummary, LogLine } from '@/gen'

/** `4ms`, `1.9s`, `2m 05s`. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '–'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

export function nodeTone(n: Pick<FlowNode, 'error' | 'warn'>): DotTone {
  return n.error ? 'err' : n.warn ? 'warn' : 'ok'
}

export function flowTone(s: Pick<FlowSummary, 'status'>): DotTone {
  return s.status === 'error' ? 'err' : s.status === 'warn' ? 'warn' : 'ok'
}

/** The badge next to the title: `201 · ok`, `failed after 2 retries`, `ok · 2 warnings`. */
export function statusLabel(f: FlowSummary, first?: LogLine): string {
  const http = first?.fields?.status
  const code = typeof http === 'number' ? `${http} · ` : ''
  if (f.status === 'error')
    return f.retries > 0 ? `failed after ${f.retries} ${f.retries === 1 ? 'retry' : 'retries'}` : `${code}failed`
  if (f.status === 'warn') {
    const n = f.warnings + f.errors
    return `${code}ok · ${n} ${n === 1 ? 'warning' : 'warnings'}`
  }
  return `${code}ok`
}

/** `request_id → job_id` */
export const stitchedBy = (f: FlowSummary) => f.stitched_by.join(' → ')

/** A run of look-alike steps folded into one row. */
export type FlowItem =
  | { kind: 'node'; node: FlowNode }
  | { kind: 'run'; key: string; nodes: FlowNode[]; name: string; warn: number; duration: number }

/** Runs this long (same source, same name, no problems) fold up. */
export const RUN = 4

/**
 * What the graph draws, in flow order. Consecutive same-named steps of one
 * source fold into a run unless expanded; a problem step always stands alone,
 * so it is never hidden. `problemsOnly` keeps the problems (plus the first and
 * last step, so the shape stays readable).
 */
export function flowItems(
  nodes: FlowNode[],
  opts: { problemsOnly?: boolean; expanded?: ReadonlySet<string>; expandAll?: boolean } = {},
): FlowItem[] {
  const shown = opts.problemsOnly
    ? nodes.filter((n, i) => n.error || n.warn || i === 0 || i === nodes.length - 1)
    : nodes
  const out: FlowItem[] = []
  let i = 0
  while (i < shown.length) {
    const n = shown[i]
    let j = i
    if (!n.error && !n.warn) {
      while (
        j + 1 < shown.length &&
        shown[j + 1].source === n.source &&
        shown[j + 1].name === n.name &&
        !shown[j + 1].error &&
        !shown[j + 1].warn
      )
        j++
    }
    const run = shown.slice(i, j + 1)
    const key = `${n.source}:${n.index}`
    if (run.length >= RUN && !opts.expandAll && !opts.expanded?.has(key)) {
      const last = run[run.length - 1]
      out.push({
        kind: 'run',
        key,
        nodes: run,
        name: n.name,
        warn: run.filter((r) => r.warn).length,
        duration: last.ts - run[0].start,
      })
    } else {
      for (const r of run) out.push({ kind: 'node', node: r })
    }
    i = j + 1
  }
  return out
}

/** The line behind a node. */
export function lineOf(f: Flow, n: FlowNode): LogLine | undefined {
  return f.lines.find((l) => l.id === n.line_id)
}

/** Short lane label for the timeline (`api`, `wkr`). */
export function laneTag(source: string): string {
  const parts = source.split(/[-_.]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? source
  if (last === 'worker') return 'wkr'
  return last.slice(0, 3)
}
