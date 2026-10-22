import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownIcon } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { LevelBadge } from '@/components/level-badge'
import { Kbd } from '@/components/ui/kbd'
import type { FlowSummary, LogLine } from '@/gen'
import { fmtDuration } from '@/lib/flow'
import { useFlowSummaries } from '@/lib/flow-api'
import { fmtTime } from '@/lib/format'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'

export const ROW = 28
const COLS = 'grid grid-cols-[104px_64px_minmax(0,1fr)_150px_96px_64px] items-center gap-3 px-3'
/** Squares drawn at most; the title says the real count. */
const MAX_SQUARES = 8

/** The line's own duration (canonical lines carry `duration_ms`). */
export function lineDuration(l: LogLine): number | null {
  const f = l.fields
  if (!f) return null
  for (const k of ['duration_ms', 'durationMs', 'elapsed_ms', 'took_ms', 'responseTime']) {
    const v = f[k]
    if (typeof v === 'number') return v
  }
  return null
}

/** One square per step of the line's flow: ok first, then warnings, then errors. */
export function StepSquares({ summary }: { summary: FlowSummary | null | undefined }) {
  if (!summary) return <span className="text-muted-foreground/40">·</span>
  const n = Math.min(summary.steps, MAX_SQUARES)
  const err = Math.min(summary.errors, n)
  const warn = Math.min(summary.warnings, n - err)
  return (
    <span
      className="flex items-center gap-0.5"
      title={`${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'} · ${summary.line_count} ${summary.line_count === 1 ? 'line' : 'lines'}`}
    >
      {Array.from({ length: n }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: squares are positional
          key={i}
          className={cn(
            'size-1.5',
            i >= n - err ? 'bg-status-err' : i >= n - err - warn ? 'bg-status-warn' : 'bg-foreground/70',
          )}
        />
      ))}
      {summary.steps > MAX_SQUARES && <span className="ml-1 text-[11px] text-muted-foreground">+</span>}
    </span>
  )
}

const LogRow = memo(function LogRow({
  line,
  selected,
  top,
  onSelect,
  summary,
}: {
  line: LogLine
  selected: boolean
  top: number
  onSelect: (l: LogLine) => void
  summary: FlowSummary | null | undefined
}) {
  const bad = line.level === 'error' || line.level === 'fatal'
  const dur = lineDuration(line)
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-line-id={line.id}
      tabIndex={-1}
      onClick={() => onSelect(line)}
      style={{ transform: `translateY(${top}px)`, height: ROW }}
      className={cn(
        COLS,
        'absolute inset-x-0 top-0 w-full cursor-default border-b border-border/60 text-left font-mono text-[13px] outline-none hover:bg-row-hover',
        bad && 'bg-row-error',
        selected && 'bg-row-selected shadow-[inset_2px_0_0_var(--brand)]',
      )}
    >
      <span className="text-muted-foreground tabular-nums">{fmtTime(line.ts)}</span>
      <span>
        <LevelBadge level={line.level} />
      </span>
      <span className="truncate">{line.msg}</span>
      <span
        className="truncate text-muted-foreground"
        title={line.display_id ? `${line.display_id.key}: ${line.display_id.value}` : undefined}
      >
        {line.display_id?.value ?? ''}
      </span>
      <StepSquares summary={line.display_id ? summary : undefined} />
      <span
        className={cn(
          'text-right tabular-nums',
          bad ? 'text-status-err' : line.level === 'warn' ? 'text-status-warn' : 'text-muted-foreground',
        )}
      >
        {dur == null ? '' : fmtDuration(dur)}
      </span>
    </button>
  )
})

/**
 * Newest at the bottom, like a terminal tail. Follows the live edge until you
 * scroll up (or pause); then a pill counts what arrived since.
 */
export function LogTable({
  lines,
  selectedId,
  onSelect,
  follow,
  onFollow,
  emptyText,
}: {
  lines: LogLine[]
  selectedId: number | null
  onSelect: (l: LogLine) => void
  follow: boolean
  onFollow: (f: boolean) => void
  emptyText: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const lastSeen = useRef(0)
  const v = useVirtualizer({
    count: lines.length,
    getScrollElement: () => ref.current,
    estimateSize: () => ROW,
    overscan: 20,
    getItemKey: (i) => lines[i].id,
  })

  useLayoutEffect(() => {
    if (follow && lines.length) v.scrollToIndex(lines.length - 1, { align: 'end' })
    if (follow) lastSeen.current = lines.length ? lines[lines.length - 1].id : 0
  }, [lines, follow, v])

  // Keep the keyboard selection on screen.
  useEffect(() => {
    if (selectedId == null) return
    const i = lines.findIndex((l) => l.id === selectedId)
    if (i >= 0 && !follow) v.scrollToIndex(i, { align: 'auto' })
  }, [selectedId, lines, follow, v])

  // Steps column: summaries for the rows on screen, once scrolling settles.
  const items = v.getVirtualItems()
  const visibleIds = items.map((it) => lines[it.index]?.display_id?.value).filter((x): x is string => Boolean(x))
  const settled = useDebounced(visibleIds.join('\n'), 400)
  const summaries = useFlowSummaries(useMemo(() => (settled ? settled.split('\n') : []), [settled]))

  const unseen = useMemo(() => (follow ? 0 : lines.filter((l) => l.id > lastSeen.current).length), [lines, follow])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2
    if (atBottom !== follow) onFollow(atBottom)
  }

  return (
    <section aria-label="Log lines" className="relative flex min-h-0 min-w-0 flex-1 flex-col border">
      <div
        aria-hidden
        className={cn(
          COLS,
          'h-8 shrink-0 border-b font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]',
        )}
      >
        <span>Time</span>
        <span>Lvl</span>
        <span>Message</span>
        <span>Id</span>
        <span>Steps</span>
        <span className="text-right">Duration</span>
      </div>
      <div ref={ref} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {lines.length === 0 && (
          <div className="flex h-full items-center justify-center p-6 text-muted-foreground">{emptyText}</div>
        )}
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const l = lines[item.index]
            return (
              <LogRow
                key={l.id}
                line={l}
                top={item.start}
                selected={l.id === selectedId}
                onSelect={onSelect}
                summary={l.display_id ? summaries.get(l.display_id.value) : undefined}
              />
            )
          })}
        </div>
      </div>
      {!follow && (
        <button
          type="button"
          onClick={() => onFollow(true)}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 border border-brand/40 bg-popover px-3 py-1.5 font-mono text-brand text-xs shadow-lg hover:bg-accent"
        >
          <ArrowDownIcon className="size-3.5" />
          {unseen > 0 ? `${unseen.toLocaleString()} new lines` : 'Jump to latest'}
          <Kbd>G</Kbd>
        </button>
      )}
    </section>
  )
}
