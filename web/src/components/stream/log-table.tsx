import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  CornerDownLeftIcon,
  FilterIcon,
  GitForkIcon,
  LoaderCircleIcon,
  WaypointsIcon,
} from 'lucide-react'
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { LevelBadge } from '@/components/level-badge'
import { MutedTag, previewHits, RowToolbar, useMuteCtx } from '@/components/stream/row-mute'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { FlowSummary, LogLine } from '@/gen'
import { DENSITY_ROW, readAppearance } from '@/lib/appearance'
import { STRUCTURED_ONLY } from '@/lib/diagram-stats'
import { fmtDuration } from '@/lib/flow'
import { useFlowSummaries } from '@/lib/flow-api'
import { fmtRowTime } from '@/lib/format'
import { inSpan, jumpIndex, nearestIndex, type Span } from '@/lib/histogram-jump'
import { parseJsonString } from '@/lib/json-string'
import { matchesMute } from '@/lib/mute'
import { chip, lineDuration, previewFields, type RowParts, redactedCount, rowParts } from '@/lib/row'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'

export { lineDuration }

export const ROW = 28
/**
 * time 88 · lvl 56 · request (resizable, `--col-request`, default 236) · flow ·
 * result flex · id 204 · duration 64 (v0.1.1-03.x: no STEPS column; the row
 * preview says how many events the flow has).
 */
export const COLS =
  'grid grid-cols-[88px_56px_minmax(0,var(--col-request,236px))_minmax(0,1fr)_204px_64px] items-center gap-3 px-3'
/** The REQUEST column's width: default, limits and where it is remembered (resize review board). */
export const REQUEST_COL = { def: 236, min: 140, max: 560, key: 'quiet.stream.col.request' } as const
const TONE: Record<RowParts['tone'], string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  err: 'text-status-err',
  muted: 'text-muted-foreground',
}

export interface RowActions {
  onSelect: (l: LogLine) => void
  onOpenFlow: (l: LogLine) => void
  /** The line's card on its Diagram tab, wide (04.14, `D`). */
  onOpenDiagram: (l: LogLine) => void
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

const LogRow = memo(function LogRow({
  line,
  selected,
  expanded,
  actions,
  wrap,
  flash = false,
}: {
  line: LogLine
  selected: boolean
  expanded: boolean
  actions: RowActions
  wrap: boolean
  /** In the histogram minute just jumped to: briefly tinted. */
  flash?: boolean
}) {
  const bad = line.level === 'error' || line.level === 'fatal'
  const dur = lineDuration(line)
  const p = useMemo(() => rowParts(line), [line])
  const f = line.fields ?? {}
  const slow = dur != null && dur >= 1000
  // Muted lines show only with Show muted: dimmed and tagged (03.18); rows a
  // new rule matches fade while it is saved (03.17).
  const mute = useMuteCtx()
  const mutedBy = mute?.stateOf(line).mutedBy
  const hiding = mute?.hiding != null && !mutedBy && matchesMute(line, mute.hiding)
  const previewed = !mutedBy && !hiding && previewHits(mute?.previewing, line)
  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualised div grid; a <tr> cannot be absolutely positioned
    <div
      data-line-id={line.id}
      aria-selected={selected}
      data-flash={flash || undefined}
      data-muted={mutedBy ? true : undefined}
      data-hiding={hiding || undefined}
      data-previewed={previewed || undefined}
      role="row"
      tabIndex={-1}
      onClick={() => actions.onSelect(line)}
      onKeyDown={undefined}
      className={cn(
        COLS,
        'group/row relative w-full cursor-default border-border/60 border-b font-mono text-[13px] outline-none hover:bg-row-hover',
        wrap ? 'min-h-(--row-h) py-1' : 'h-(--row-h)',
        bad && 'bg-row-error shadow-[inset_2px_0_0_var(--status-err)]',
        selected && 'bg-row-selected shadow-[inset_2px_0_0_var(--brand)]',
        flash && !selected && 'bg-brand/10 shadow-[inset_2px_0_0_var(--brand)]',
        expanded && 'border-b-0',
        mutedBy && 'text-muted-foreground [&>*:not(:last-child)]:opacity-55',
        hiding && 'opacity-35 transition-opacity duration-150',
        previewed && 'bg-status-warn/10 shadow-[inset_2px_0_0_var(--status-warn)]',
      )}
    >
      <span className="text-muted-foreground tabular-nums">{fmtRowTime(line.ts)}</span>
      <span>
        <LevelBadge level={line.level} />
      </span>
      <span className={cn('flex min-w-0 gap-2', !wrap && 'truncate')}>
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
      <span className={cn('flex min-w-0 items-baseline gap-2', wrap ? 'flex-wrap break-all' : 'truncate')}>
        <span className={cn(!wrap && 'truncate', !line.fields && 'text-foreground/90')}>{p.event}</span>
        {p.outcome != null && (
          <>
            <span className={cn('shrink-0', TONE[p.tone])}>→</span>
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
        {p.extra.map((x, i) => (
          <span
            key={x}
            className={cn('shrink-0', i === 0 && p.extraTone ? TONE[p.extraTone] : 'text-muted-foreground')}
          >
            <span className="text-muted-foreground">·</span> {x}
          </span>
        ))}
        {mutedBy && <MutedTag rule={mutedBy} />}
        {hiding && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">hiding</span>}
      </span>
      <Pick
        k={line.display_id?.key}
        v={line.display_id?.value}
        onFilter={actions.onFilter}
        className="text-muted-foreground text-xs"
      >
        {line.display_id?.value ?? ''}
      </Pick>
      <span
        className={cn(
          'text-right tabular-nums',
          bad ? 'text-status-err' : line.level === 'warn' || slow ? 'text-status-warn' : 'text-muted-foreground',
        )}
      >
        {dur == null ? '' : fmtDuration(dur)}
      </span>
      {/* Hover / focus: Mute · Copy line · Open flow (03.15; replaces 03.5's cluster). */}
      <RowToolbar
        line={line}
        selected={selected}
        onCopy={() => actions.onCopy(line)}
        onOpenFlow={() => actions.onOpenFlow(line)}
      />
    </div>
  )
})

/** `request.headers` in the preview: how many were removed, else how many there are. */
function HeadersSummary({ headers }: { headers: Record<string, unknown> }) {
  const n = Object.keys(headers).length
  const redacted = redactedCount(headers)
  if (redacted > 0) return <span className="text-foreground">{redacted} redacted</span>
  return <span className="text-muted-foreground">{n === 0 ? 'none' : `${n} ${n === 1 ? 'header' : 'headers'}`}</span>
}

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
        <dl
          className="grid grid-flow-col grid-cols-3 gap-x-6 font-mono text-xs"
          style={{ gridTemplateRows: `repeat(${Math.ceil(fields.length / 3)}, auto)` }}
        >
          {fields.map(([k, sent]) => {
            // A string holding JSON previews as the structure it holds.
            const json = typeof sent === 'string' ? parseJsonString(sent) : undefined
            const v = json ?? sent
            return (
              <div
                key={k}
                className="flex h-7 min-w-0 items-center gap-2 border-border/60 border-b"
                title={json ? `${k}: JSON sent as a string` : undefined}
              >
                <dt className="w-44 shrink-0 truncate text-syntax-key">
                  {k}
                  {json && <span className="text-muted-foreground"> json</span>}
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
                  ) : k.endsWith('.headers') && v && typeof v === 'object' ? (
                    <HeadersSummary headers={v as Record<string, unknown>} />
                  ) : (
                    <span className="text-muted-foreground">{Array.isArray(v) ? `${v.length} items` : '{…}'}</span>
                  )}
                </dd>
              </div>
            )
          })}
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
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button size="xs" variant="outline" disabled={!line.fields} onClick={() => actions.onOpenDiagram(line)}>
                  <WaypointsIcon />
                  Diagram
                  <Kbd className="h-4 min-w-4 text-[10px]">D</Kbd>
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {line.fields ? (
              <>
                Open this line as a diagram, wide <Kbd>D</Kbd>
              </>
            ) : (
              STRUCTURED_ONLY
            )}
          </TooltipContent>
        </Tooltip>
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
            ? `${summary.line_count} ${summary.line_count === 1 ? 'event' : 'events'}${summary.sources.length > 1 ? ` across ${summary.sources.join(', ')}` : ''} · `
            : ''}
          press space to collapse
        </span>
      </div>
    </div>
  )
}

const clampCol = (w: number) => Math.round(Math.min(REQUEST_COL.max, Math.max(REQUEST_COL.min, w)))

/** The REQUEST column's width, remembered in this browser. */
export function useColumnWidth(): [number, (w: number) => void] {
  const [w, setW] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(REQUEST_COL.key))
      return v ? clampCol(v) : REQUEST_COL.def
    } catch {
      return REQUEST_COL.def
    }
  })
  const set = useCallback((next: number) => {
    const c = clampCol(next)
    setW(c)
    try {
      localStorage.setItem(REQUEST_COL.key, String(c))
    } catch {
      // private mode: the width just isn't remembered
    }
  }, [])
  return [w, set]
}

/** Double-click to fit: the widest `METHOD /path` (or job name) among the rows, in 13px Geist Mono. */
export function fitWidth(rows: LogLine[]): number {
  let chars = 0
  for (const l of rows.slice(-500)) {
    const p = rowParts(l)
    const n = p.path ? `${p.method ?? ''}  ${p.path}`.length : (p.name ?? '').length
    if (n > chars) chars = n
  }
  return chars ? clampCol(chars * 7.9 + 12) : REQUEST_COL.def
}

/**
 * Drag handle on the REQUEST column's right edge (resize review board): drag,
 * ←/→ 16 px (Shift 64), double-click or Enter to fit, Home resets.
 */
function ColumnResize({
  label,
  width,
  onWidth,
  onFit,
  onDrag,
}: {
  label: string
  width: number
  onWidth: (w: number) => void
  onFit: () => void
  onDrag?: (dragging: boolean) => void
}) {
  const [drag, setDragState] = useState(false)
  const setDrag = (d: boolean) => {
    setDragState(d)
    onDrag?.(d)
  }
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter; <hr> can't take pointer or key handlers
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={width}
      aria-valuemin={REQUEST_COL.min}
      aria-valuemax={REQUEST_COL.max}
      tabIndex={0}
      data-dragging={drag || undefined}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        setDrag(true)
      }}
      onPointerMove={(e) => {
        if (start.current) onWidth(start.current.w + e.clientX - start.current.x)
      }}
      onPointerUp={() => {
        start.current = null
        setDrag(false)
      }}
      onDoubleClick={onFit}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16
        if (e.key === 'ArrowLeft') onWidth(width - step)
        else if (e.key === 'ArrowRight') onWidth(width + step)
        else if (e.key === 'Enter') onFit()
        else if (e.key === 'Home') onWidth(REQUEST_COL.def)
        else return
        e.preventDefault()
      }}
      className="group/resize absolute top-0 -right-2.5 z-10 flex h-7 w-2 cursor-col-resize touch-none justify-center outline-none"
    >
      <span
        className={cn(
          'h-full w-px bg-transparent group-hover/resize:bg-brand group-focus-visible/resize:bg-brand',
          drag && 'w-0.5 bg-brand',
        )}
      />
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute bottom-8 left-1/2 hidden -translate-x-1/2 whitespace-nowrap border bg-popover px-2 py-1 font-mono text-[11px] text-foreground normal-case tracking-normal shadow-sm',
          'group-hover/resize:block group-focus-visible/resize:block',
          drag && 'block',
        )}
      >
        {width} px · double-click to fit
      </span>
    </span>
  )
}

/** Over the dimmed rows of the previous filters while the new ones load. */
function Refreshing() {
  return (
    <span
      role="status"
      data-testid="table-refreshing"
      className="absolute top-10 right-3 z-10 flex items-center gap-1.5 border bg-popover px-2 py-1 font-mono text-[11px] text-muted-foreground shadow-sm"
    >
      <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
      Updating…
    </span>
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
  onRowHover,
  empty,
  loading,
  refreshing = false,
  dim,
  wrap = false,
  direction = 'bottom',
  actions,
  onUnseen,
  jump = null,
  flash = null,
  banner,
  footer,
  onResizing,
}: {
  /** A row under the column titles (filtered: "98 of 1,284 lines match · Clear filters", 03.3). */
  banner?: ReactNode
  /** The status line at the bottom of the table card (03.x). */
  footer?: ReactNode
  /** The column being resized and its width, for the footer; `null` when done. */
  onResizing?: (r: { label: string; width: number } | null) => void
  /** Oldest first, as the stream keeps them. */
  lines: LogLine[]
  selectedId: number | null
  expandedId: number | null
  follow: boolean
  onFollow: (f: boolean) => void
  /** A row is under the pointer (the footer shows the row keys, 03.15). */
  onRowHover?: (hovering: boolean) => void
  /** Shown instead of rows when there are none. */
  empty: ReactNode
  /** No rows for the current filters yet: skeletons instead of `empty`. */
  loading?: boolean
  /** The rows belong to the previous filters; the new ones are loading. Dimmed, with a spinner. */
  refreshing?: boolean
  /** Rows faded (offline: what you see is not live). */
  dim?: boolean
  wrap?: boolean
  direction?: 'bottom' | 'top'
  actions: RowActions
  /** How many lines arrived since you stopped following, and how far up you are. */
  onUnseen?: (unseen: number, scrolledUp: number) => void
  /**
   * Histogram jump: put the first row of `span` (in display order) at the top.
   * A new `n` asks again; it waits until a row of the span is here.
   */
  jump?: { span: Span; n: number } | null
  /** Rows in this span are tinted (the minute just jumped to). */
  flash?: Span | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const lastSeen = useRef(0)
  const top = direction === 'top'
  const rows = useMemo(() => (top ? [...lines].reverse() : lines), [lines, top])
  const [colWidth, setColWidth] = useColumnWidth()
  // A worker source reads JOB: most recent rows have a job name and no HTTP request.
  const jobs = useMemo(() => {
    let job = 0
    let req = 0
    for (const l of lines.slice(-200)) {
      const p = rowParts(l)
      if (p.path) req++
      else if (p.name) job++
    }
    return job > req
  }, [lines])
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    onResizing?.(resizing ? { label: jobs ? 'Job' : 'Request', width: colWidth } : null)
  }, [resizing, colWidth, jobs, onResizing])
  // Row density from Appearance (07.9): 32 / 28 / 24 px.
  const rowH = DENSITY_ROW[readAppearance().density]
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => (rows[i]?.id === expandedId ? rowH + 120 : rowH),
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

  // Histogram jump (once per request): the minute's first row at the top. The
  // scroll it causes must not read as "back at the live edge".
  const jumped = useRef(0)
  const quietUntil = useRef(0)
  useLayoutEffect(() => {
    if (!jump || jumped.current === jump.n || follow) return
    let i = jumpIndex(rows, jump.span)
    if (i < 0) i = nearestIndex(rows, jump.span)
    if (i < 0) return
    jumped.current = jump.n
    quietUntil.current = Date.now() + 400
    v.scrollToIndex(i, { align: 'start' })
  }, [jump, rows, follow, v])

  // Keep the keyboard selection on screen.
  useEffect(() => {
    if (selectedId == null) return
    const i = rows.findIndex((l) => l.id === selectedId)
    if (i >= 0 && !follow) v.scrollToIndex(i, { align: 'auto' })
  }, [selectedId, rows, follow, v])

  // The open preview says how many events its flow has.
  const items = v.getVirtualItems()
  const expandedFlow = rows.find((l) => l.id === expandedId)?.display_id?.value
  const settled = useDebounced(expandedFlow ?? '', 150)
  const summaries = useFlowSummaries(useMemo(() => (settled ? [settled] : []), [settled]))

  const unseen = useMemo(() => (follow ? 0 : lines.filter((l) => l.id > lastSeen.current).length), [lines, follow])
  const scrolledUp = useMemo(() => {
    if (follow || !items.length) return 0
    const edge = top ? items[0].index : rows.length - 1 - items[items.length - 1].index
    return Math.max(0, edge)
  }, [follow, items, rows.length, top])
  useEffect(() => onUnseen?.(unseen, scrolledUp), [unseen, scrolledUp, onUnseen])

  // Only the user resumes live by scrolling to the edge. Rows leaving the
  // list (a new mute rule, the ring dropping old lines) can land the view on
  // the edge too; that must not unpause (03.19: "Pause and scroll position
  // are untouched by mute").
  const hovering = useRef(false)
  const hover = (on: boolean) => {
    if (hovering.current === on) return
    hovering.current = on
    onRowHover?.(on)
  }
  const userScrolled = useRef(0)
  const markUser = () => {
    userScrolled.current = Date.now()
  }
  const onScroll = () => {
    const el = ref.current
    if (!el || Date.now() < quietUntil.current) return
    const atEdge = top ? el.scrollTop < ROW * 2 : el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2
    if (atEdge === follow) return
    if (atEdge && Date.now() - userScrolled.current > 1000) return
    onFollow(atEdge)
  }

  return (
    <section
      aria-label="Log lines"
      aria-busy={loading || refreshing || undefined}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col border bg-card"
      style={{ '--col-request': `${colWidth}px` } as CSSProperties}
    >
      <div
        className={cn(
          COLS,
          'h-7 shrink-0 border-b font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]',
          // 1×12px dividers between the column titles (03.x).
          '[&>*:not(:first-child)]:relative [&>*:not(:first-child)]:before:absolute [&>*:not(:first-child)]:before:top-1/2 [&>*:not(:first-child)]:before:-left-1.5 [&>*:not(:first-child)]:before:h-3 [&>*:not(:first-child)]:before:w-px [&>*:not(:first-child)]:before:-translate-y-1/2 [&>*:not(:first-child)]:before:bg-input',
        )}
      >
        <span aria-hidden>Time</span>
        <span aria-hidden>Lvl</span>
        <span className="relative" aria-hidden={false}>
          <span aria-hidden>{jobs ? 'Job' : 'Request'}</span>
          <ColumnResize
            label={jobs ? 'Job' : 'Request'}
            width={colWidth}
            onWidth={setColWidth}
            onFit={() => setColWidth(fitWidth(rows))}
            onDrag={setResizing}
          />
        </span>
        <span aria-hidden>Flow · Result</span>
        <span aria-hidden>Id</span>
        <span aria-hidden className="text-right">
          Duration
        </span>
      </div>
      {/* While dragging, the divider runs the full table height (03 resize review). */}
      {resizing && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-brand"
          style={{ left: colWidth + 185 }}
        />
      )}
      {banner}
      {refreshing && lines.length > 0 && <Refreshing />}
      <div
        ref={ref}
        onScroll={onScroll}
        onWheel={markUser}
        onTouchMove={markUser}
        onPointerDown={markUser}
        onKeyDown={markUser}
        onMouseOver={(e) => hover((e.target as HTMLElement).closest('[data-line-id]') != null)}
        onMouseLeave={() => hover(false)}
        className={cn(
          'relative min-h-0 flex-1 overflow-y-auto transition-opacity',
          (dim || refreshing) && 'opacity-55',
        )}
      >
        {(loading || refreshing) && lines.length === 0 ? (
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
                  actions={actions}
                  wrap={wrap}
                  flash={flash != null && inSpan(l.ts, flash)}
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
              'pointer-events-none absolute inset-x-px h-16 from-card to-transparent',
              top ? 'top-7 bg-gradient-to-b' : footer ? 'bottom-8 bg-gradient-to-t' : 'bottom-px bg-gradient-to-t',
            )}
          />
          <button
            type="button"
            onClick={() => onFollow(true)}
            className={cn(
              'absolute left-1/2 flex -translate-x-1/2 items-center gap-2 bg-foreground px-3 py-1.5 font-medium text-background text-xs shadow-lg hover:bg-foreground/90',
              top ? 'top-10' : footer ? 'bottom-11' : 'bottom-3',
            )}
          >
            {unseen > 0 ? `${unseen.toLocaleString()} new ${unseen === 1 ? 'line' : 'lines'}` : 'Jump to latest'}
            {top ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
            <Kbd>G</Kbd>
          </button>
        </>
      )}
      {footer}
    </section>
  )
}
