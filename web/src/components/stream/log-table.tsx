import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, CornerDownLeftIcon, FilterIcon, GitForkIcon } from 'lucide-react'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { LevelBadge } from '@/components/level-badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import type { FlowSummary, LogLine } from '@/gen'
import { fmtDuration } from '@/lib/flow'
import { useFlowSummaries } from '@/lib/flow-api'
import { fmtTime } from '@/lib/format'
import { chip, lineDuration, previewFields, type RowParts, rowParts } from '@/lib/row'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'

export { lineDuration }

export const ROW = 28
/** time 88 · lvl 56 · flow 236 · summary flex · id 128 · steps 64 · duration 64 (design F.1). */
export const COLS =
  'grid grid-cols-[96px_56px_minmax(0,236px)_minmax(0,1fr)_128px_64px_72px] items-center gap-3 pr-3 pl-4'
/** Squares drawn at most; the title says the real count. */
const MAX_SQUARES = 8

const TONE: Record<RowParts['tone'], string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  err: 'text-status-err',
  muted: 'text-muted-foreground',
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
            i >= n - err ? 'bg-status-err' : i >= n - err - warn ? 'bg-status-warn' : 'bg-foreground/60',
          )}
        />
      ))}
      {summary.steps > MAX_SQUARES && <span className="ml-1 text-[11px] text-muted-foreground">+</span>}
    </span>
  )
}

export interface RowActions {
  onSelect: (l: LogLine) => void
  onOpenFlow: (l: LogLine) => void
  onCopy: (l: LogLine) => void
  /** Add a `key:value` chip to the stream filter. */
  onFilter: (chip: string) => void
}

/** A value you can click to filter by it (the design's "click any value in a row"). */
function Pick({
  k,
  v,
  onFilter,
  className,
  children,
}: {
  k: string | undefined
  v: unknown
  onFilter: (c: string) => void
  className?: string
  children: ReactNode
}) {
  if (!k) return <span className={className}>{children}</span>
  return (
    <button
      type="button"
      tabIndex={-1}
      title={`Filter ${chip(k, v)}`}
      onClick={(e) => {
        e.stopPropagation()
        onFilter(chip(k, v))
      }}
      className={cn('cursor-pointer truncate text-left hover:underline hover:decoration-dotted', className)}
    >
      {children}
    </button>
  )
}

function HoverAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex h-6 items-center gap-1 border bg-popover px-1.5 text-muted-foreground text-xs hover:text-foreground [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

const LogRow = memo(function LogRow({
  line,
  selected,
  expanded,
  summary,
  actions,
  wrap,
}: {
  line: LogLine
  selected: boolean
  expanded: boolean
  summary: FlowSummary | null | undefined
  actions: RowActions
  wrap: boolean
}) {
  const bad = line.level === 'error' || line.level === 'fatal'
  const dur = lineDuration(line)
  const p = useMemo(() => rowParts(line), [line])
  const f = line.fields ?? {}
  const slow = dur != null && dur >= 1000
  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualised div grid; a <tr> cannot be absolutely positioned
    <div
      data-line-id={line.id}
      aria-selected={selected}
      role="row"
      tabIndex={-1}
      onClick={() => actions.onSelect(line)}
      onKeyDown={undefined}
      className={cn(
        COLS,
        'group/row relative w-full cursor-default border-border/60 border-b font-mono text-[13px] outline-none hover:bg-row-hover',
        wrap ? 'min-h-7 py-1' : 'h-7',
        bad && 'bg-row-error shadow-[inset_2px_0_0_var(--status-err)]',
        selected && 'bg-row-selected shadow-[inset_2px_0_0_var(--brand)]',
        expanded && 'border-b-0',
      )}
    >
      <span className="text-muted-foreground tabular-nums">{fmtTime(line.ts)}</span>
      <span>
        <LevelBadge level={line.level} />
      </span>
      <span className={cn('flex min-w-0 gap-1.5', !wrap && 'truncate')}>
        {p.path ? (
          <>
            <span className="shrink-0 text-muted-foreground">{p.method}</span>
            <Pick k="path" v={f.path ?? p.path} onFilter={actions.onFilter} className="min-w-0">
              {p.path}
            </Pick>
          </>
        ) : p.name ? (
          <Pick k={'queue' in f ? 'queue' : undefined} v={p.name} onFilter={actions.onFilter} className="min-w-0">
            {p.name}
          </Pick>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </span>
      <span className={cn('flex min-w-0 items-baseline gap-1.5', wrap ? 'flex-wrap break-all' : 'truncate')}>
        <span className={cn(!wrap && 'truncate', !line.fields && 'text-foreground/90')}>{p.event}</span>
        {p.outcome != null && (
          <>
            <span className="shrink-0 text-muted-foreground">→</span>
            <Pick
              k={p.outcomeKey}
              v={p.outcomeKey ? f[p.outcomeKey] : p.outcome}
              onFilter={actions.onFilter}
              className={cn('shrink-0', TONE[p.tone])}
            >
              {p.outcome}
            </Pick>
          </>
        )}
        {p.extra.map((x) => (
          <span key={x} className="shrink-0 text-muted-foreground">
            · {x}
          </span>
        ))}
      </span>
      <Pick
        k={line.display_id?.key}
        v={line.display_id?.value}
        onFilter={actions.onFilter}
        className="text-muted-foreground"
      >
        {line.display_id?.value ?? ''}
      </Pick>
      <StepSquares summary={line.display_id ? summary : undefined} />
      <span
        className={cn(
          'text-right tabular-nums',
          bad ? 'text-status-err' : line.level === 'warn' || slow ? 'text-status-warn' : 'text-muted-foreground',
        )}
      >
        {dur == null ? '' : fmtDuration(dur)}
      </span>
      {/* Hover: copy, filter by its id, open its flow (design 03.2 / 03.5). */}
      <span className="pointer-events-none absolute inset-y-0 right-2 hidden items-center gap-1 group-hover/row:flex">
        <span className="pointer-events-auto flex gap-1">
          <HoverAction label="Copy line as JSON" onClick={() => actions.onCopy(line)}>
            <CopyIcon />
          </HoverAction>
          {line.display_id && (
            <HoverAction
              label={`Filter ${line.display_id.key}`}
              onClick={() => line.display_id && actions.onFilter(chip(line.display_id.key, line.display_id.value))}
            >
              <FilterIcon />
            </HoverAction>
          )}
          <HoverAction label="Open flow" onClick={() => actions.onOpenFlow(line)}>
            <GitForkIcon />
            Open flow
          </HoverAction>
        </span>
      </span>
    </div>
  )
})

/** The inline preview under a row: a 3-column field grid and the line's actions (design 03.5). */
export function RowPreview({
  line,
  summary,
  actions,
}: {
  line: LogLine
  summary: FlowSummary | null | undefined
  actions: RowActions
}) {
  const fields = previewFields(line)
  const id = line.display_id
  return (
    <div
      data-testid="row-preview"
      className="border-border/60 border-b bg-row-selected/60 py-3 pr-3 pl-[192px] shadow-[inset_2px_0_0_var(--brand)]"
    >
      {fields.length > 0 ? (
        <dl className="grid grid-cols-3 gap-x-6 gap-y-1 font-mono text-xs">
          {fields.map(([k, v]) => (
            <div key={k} className="flex min-w-0 gap-2">
              <dt className="w-28 shrink-0 truncate text-syntax-key">
                {k}
                {Array.isArray(v) || (v && typeof v === 'object') ? (
                  <span className="text-muted-foreground">
                    {' '}
                    [{Array.isArray(v) ? v.length : Object.keys(v).length}]
                  </span>
                ) : null}
              </dt>
              <dd className="min-w-0 truncate">
                {v === null ? (
                  <span className="text-syntax-literal">null</span>
                ) : typeof v === 'number' ? (
                  <span className="text-syntax-number">{v}</span>
                ) : typeof v === 'boolean' ? (
                  <span className="text-syntax-literal">{String(v)}</span>
                ) : typeof v === 'string' ? (
                  <span className="text-syntax-string">{v}</span>
                ) : (
                  <span className="text-muted-foreground">{Array.isArray(v) ? `${v.length} items` : '{…}'}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs">{line.raw}</pre>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button size="xs" onClick={() => actions.onOpenFlow(line)}>
          <GitForkIcon />
          Open flow
          <CornerDownLeftIcon className="opacity-60" />
        </Button>
        <Button size="xs" variant="outline" onClick={() => actions.onCopy(line)}>
          <CopyIcon />
          Copy JSON
        </Button>
        {id && (
          <Button size="xs" variant="outline" onClick={() => actions.onFilter(chip(id.key, id.value))}>
            <FilterIcon />
            Filter {id.key}
          </Button>
        )}
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
          {summary
            ? `${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'} across ${summary.sources.join(', ')} · `
            : ''}
          press space to collapse
        </span>
      </div>
    </div>
  )
}

/** Skeleton rows while the first backlog loads (design 08.4). */
function SkeletonRows() {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: 14 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
        <div key={i} className={cn(COLS, 'h-7 border-border/60 border-b')}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-9" />
          <Skeleton className="h-3" style={{ width: `${50 + ((i * 29) % 45)}%` }} />
          <Skeleton className="h-3" style={{ width: `${30 + ((i * 17) % 50)}%` }} />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-8" />
          <Skeleton className="ml-auto h-3 w-10" />
        </div>
      ))}
    </div>
  )
}

/**
 * Newest at the bottom like a terminal tail (default), or at the top. Follows
 * the live edge until you scroll away from it (or pause); then a pill counts
 * what arrived since. Clicking a row (or `space` on the selected one) opens
 * its preview in place.
 */
export function LogTable({
  lines,
  selectedId,
  expandedId,
  follow,
  onFollow,
  empty,
  loading,
  dim,
  wrap = false,
  direction = 'bottom',
  actions,
  onUnseen,
}: {
  /** Oldest first, as the stream keeps them. */
  lines: LogLine[]
  selectedId: number | null
  expandedId: number | null
  follow: boolean
  onFollow: (f: boolean) => void
  /** Shown instead of rows when there are none. */
  empty: ReactNode
  loading?: boolean
  /** Rows faded (offline: what you see is not live). */
  dim?: boolean
  wrap?: boolean
  direction?: 'bottom' | 'top'
  actions: RowActions
  /** How many lines arrived since you stopped following, and how far up you are. */
  onUnseen?: (unseen: number, scrolledUp: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const lastSeen = useRef(0)
  const top = direction === 'top'
  const rows = useMemo(() => (top ? [...lines].reverse() : lines), [lines, top])
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => (rows[i]?.id === expandedId ? ROW + 120 : ROW),
    overscan: 20,
    getItemKey: (i) => rows[i].id,
  })

  useLayoutEffect(() => {
    if (follow && rows.length) {
      if (top) v.scrollToIndex(0, { align: 'start' })
      else v.scrollToIndex(rows.length - 1, { align: 'end' })
    }
    if (follow) lastSeen.current = lines.length ? lines[lines.length - 1].id : 0
  }, [rows, lines, follow, top, v])

  // Keep the keyboard selection on screen.
  useEffect(() => {
    if (selectedId == null) return
    const i = rows.findIndex((l) => l.id === selectedId)
    if (i >= 0 && !follow) v.scrollToIndex(i, { align: 'auto' })
  }, [selectedId, rows, follow, v])

  // Steps column: summaries for the rows on screen, once scrolling settles.
  const items = v.getVirtualItems()
  const visibleIds = items.map((it) => rows[it.index]?.display_id?.value).filter((x): x is string => Boolean(x))
  const settled = useDebounced(visibleIds.join('\n'), 400)
  const summaries = useFlowSummaries(useMemo(() => (settled ? settled.split('\n') : []), [settled]))

  const unseen = useMemo(() => (follow ? 0 : lines.filter((l) => l.id > lastSeen.current).length), [lines, follow])
  const scrolledUp = useMemo(() => {
    if (follow || !items.length) return 0
    const edge = top ? items[0].index : rows.length - 1 - items[items.length - 1].index
    return Math.max(0, edge)
  }, [follow, items, rows.length, top])
  useEffect(() => onUnseen?.(unseen, scrolledUp), [unseen, scrolledUp, onUnseen])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const atEdge = top ? el.scrollTop < ROW * 2 : el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2
    if (atEdge !== follow) onFollow(atEdge)
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
        <span>Flow</span>
        <span>Summary</span>
        <span>Id</span>
        <span>Steps</span>
        <span className="text-right">Duration</span>
      </div>
      <div ref={ref} onScroll={onScroll} className={cn('relative min-h-0 flex-1 overflow-y-auto', dim && 'opacity-55')}>
        {loading && lines.length === 0 ? (
          <SkeletonRows />
        ) : lines.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">{empty}</div>
        ) : null}
        {/* biome-ignore lint/a11y/useSemanticElements: virtualised div grid, not a <tbody> */}
        <div role="rowgroup" style={{ height: v.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const l = rows[item.index]
            const summary = l.display_id ? summaries.get(l.display_id.value) : undefined
            return (
              <div
                key={l.id}
                data-index={item.index}
                ref={v.measureElement}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <LogRow
                  line={l}
                  selected={l.id === selectedId}
                  expanded={l.id === expandedId}
                  summary={summary}
                  actions={actions}
                  wrap={wrap}
                />
                {l.id === expandedId && <RowPreview line={l} summary={summary} actions={actions} />}
              </div>
            )
          })}
        </div>
      </div>
      {!follow && lines.length > 0 && (
        <>
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-px h-16 from-background to-transparent',
              top ? 'top-8 bg-gradient-to-b' : 'bottom-px bg-gradient-to-t',
            )}
          />
          <button
            type="button"
            onClick={() => onFollow(true)}
            className={cn(
              'absolute left-1/2 flex -translate-x-1/2 items-center gap-2 border border-brand/40 bg-popover px-3 py-1.5 font-mono text-brand text-xs shadow-lg hover:bg-accent',
              top ? 'top-11' : 'bottom-3',
            )}
          >
            {unseen > 0 ? `${unseen.toLocaleString()} new ${unseen === 1 ? 'line' : 'lines'}` : 'Jump to latest'}
            {top ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
            <Kbd>G</Kbd>
          </button>
        </>
      )}
    </section>
  )
}
