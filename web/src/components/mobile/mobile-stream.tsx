import { Link } from '@tanstack/react-router'
import { ChevronDownIcon, PauseIcon, PlayIcon, SearchIcon } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { LevelBadge } from '@/components/level-badge'
import type { LiveState } from '@/components/stream/top-bar'
import type { Bucket, LogLine, SourceInfo } from '@/gen'
import { fmtDuration } from '@/lib/flow'
import { fmtRowTime } from '@/lib/format'
import { isOn, type LevelChip } from '@/lib/levels'
import { lineDuration, type RowParts, rowParts } from '@/lib/row'
import { cn } from '@/lib/utils'

const TONE: Record<RowParts['tone'], string> = {
  ok: 'text-syntax-literal',
  warn: 'text-level-warn',
  err: 'text-level-error',
  muted: 'text-muted-foreground',
}

/** Rows kept on a phone: the newest few hundred; older ones are a scroll in Search. */
const MAX_ROWS = 300
/** Minutes in the compact histogram (5 px bars across the phone). */
const BARS = 48

const fmtRate = (r: number) => (r < 10 ? r.toFixed(1).replace(/\.0$/, '') : String(Math.round(r)))

/** `warn+ · 2 filters`: the level floor and how many filters are on. */
export function filterSummary(levels: LevelChip[], filters: number): string {
  const order: LevelChip[] = ['debug', 'info', 'warn', 'error']
  const on = order.filter((l) => isOn(levels, l))
  const floor = order.findIndex((l) => on.includes(l))
  const level =
    levels.length === 0 || on.length === order.length
      ? ''
      : on.length === order.length - floor && floor >= 0
        ? on.length === 1
          ? on[0]
          : `${on[0]}+`
        : on.join(', ')
  const f = filters ? `${filters} ${filters === 1 ? 'filter' : 'filters'}` : ''
  return [level, f].filter(Boolean).join(' · ')
}

function LivePill({ state, rate }: { state: LiveState; rate: number | null }) {
  const live = state === 'live'
  const label = live ? 'Live' : state === 'paused' ? 'Paused' : state === 'offline' ? 'Offline' : 'Connecting'
  return (
    <span
      className={cn(
        'flex h-7 shrink-0 items-center gap-2 border px-2.5 text-xs',
        live && 'border-status-ok/30 bg-status-ok/10',
        state === 'paused' && 'border-status-warn/30 bg-status-warn/10',
        (state === 'offline' || state === 'connecting') && 'border-input bg-secondary',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          live && 'bg-status-ok shadow-[0_0_0_3px_color-mix(in_oklab,var(--status-ok)_22%,transparent)]',
          state === 'paused' && 'bg-status-warn',
          (state === 'offline' || state === 'connecting') && 'bg-status-idle',
        )}
      />
      <span
        className={cn(
          'font-semibold',
          live && 'text-status-ok',
          state === 'paused' && 'text-status-warn',
          !live && state !== 'paused' && 'text-muted-foreground',
        )}
      >
        {label}
      </span>
      {live && rate != null && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono text-muted-foreground">{fmtRate(rate)}/s</span>
        </>
      )}
    </span>
  )
}

/** The last 48 minutes, stacked info / warn / error, in a 32 px card (10.1). */
function MiniHistogram({ buckets, levels }: { buckets: Bucket[]; levels: LevelChip[] }) {
  const last = buckets.slice(-BARS)
  const parts = last.map((b) => ({
    info: (isOn(levels, 'info') ? b.info : 0) + (isOn(levels, 'debug') ? b.debug : 0),
    warn: isOn(levels, 'warn') ? b.warn : 0,
    error: isOn(levels, 'error') ? b.error : 0,
  }))
  const max = Math.max(1, ...parts.map((p) => p.info + p.warn + p.error))
  const h = (n: number) => (n ? Math.max(2, Math.round((n / max) * 16)) : 0)
  return (
    <div aria-hidden className="flex h-8 items-end justify-between gap-px overflow-hidden border bg-card px-2.5 py-2">
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one bar per minute slot
        <span key={i} className="flex w-[5px] shrink-0 flex-col justify-end self-stretch">
          {p.error > 0 && <span className="shrink-0 bg-chart-2" style={{ height: h(p.error) }} />}
          {p.warn > 0 && <span className="shrink-0 bg-chart-3" style={{ height: h(p.warn) }} />}
          {p.info > 0 && <span className="shrink-0 bg-chart-1" style={{ height: h(p.info) }} />}
        </span>
      ))}
    </div>
  )
}

/** One event as a two-line card: time · level · duration, then the request → result (10.1). */
function MobileRow({ line, onOpen }: { line: LogLine; onOpen: (l: LogLine) => void }) {
  const p = rowParts(line)
  const bad = line.level === 'error' || line.level === 'fatal'
  const dur = lineDuration(line)
  return (
    <button
      type="button"
      data-line-id={line.id}
      onClick={() => onOpen(line)}
      className={cn(
        'relative flex w-full shrink-0 flex-col gap-1 border-b px-4 py-2 text-left font-mono outline-none focus-visible:bg-row-hover',
        bad && 'bg-row-error before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-status-err',
      )}
    >
      <span className="flex items-center gap-2 text-xs leading-4">
        <span className="text-muted-foreground tabular-nums">{fmtRowTime(line.ts)}</span>
        <LevelBadge level={line.level} className="h-5 font-medium" />
        <span className="flex-1" />
        <span className={cn('tabular-nums', bad ? 'text-level-error' : 'text-muted-foreground')}>
          {dur == null ? '' : fmtDuration(dur)}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] leading-[18px]">
        {p.path ? (
          <>
            <span className="shrink-0 text-muted-foreground">{p.method}</span>
            <span className="truncate">{p.path}</span>
          </>
        ) : (
          <span className="truncate">{p.name ?? p.event}</span>
        )}
        {p.outcome != null && (
          <>
            <span className={cn('shrink-0', TONE[p.tone])}>→</span>
            <span className={cn('shrink-0', TONE[p.tone])}>{p.outcome}</span>
          </>
        )}
      </span>
    </button>
  )
}

/**
 * The stream on a phone (board 10.1): source name with a picker, pause and
 * search; the live pill with the filter summary; a compact histogram; then
 * two-line cards, newest at the bottom. Tapping a card opens its flow.
 */
export function MobileStream({
  name,
  sources,
  onSource,
  state,
  rate,
  levels,
  filters,
  buckets,
  lines,
  follow,
  onFollow,
  direction,
  onOpen,
  empty,
}: {
  name: string
  sources: SourceInfo[]
  onSource: (name: string) => void
  state: LiveState
  rate: number | null
  levels: LevelChip[]
  /** Chips plus free text. */
  filters: number
  buckets: Bucket[]
  lines: LogLine[]
  follow: boolean
  onFollow: (f: boolean) => void
  direction: 'bottom' | 'top'
  onOpen: (l: LogLine) => void
  empty: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const top = direction === 'top'
  const shown = lines.slice(-MAX_ROWS)
  const rows = top ? [...shown].reverse() : shown
  const summary = filterSummary(levels, filters)
  const current = sources.find((s) => s.name === name)

  // Following: keep the newest card in view.
  const newest = lines[lines.length - 1]?.id
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !follow || newest == null) return
    el.scrollTop = top ? 0 : el.scrollHeight
  }, [follow, newest, top])
  // Scrolled away from the newest end pauses, like the desktop table.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const atEnd = top ? el.scrollTop < 8 : el.scrollHeight - el.scrollTop - el.clientHeight < 8
      if (atEnd !== follow) onFollow(atEnd)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [follow, onFollow, top])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-2.5 border-b px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              state === 'live' ? 'bg-status-ok' : state === 'paused' ? 'bg-status-warn' : 'bg-status-idle',
            )}
          />
          <label className="relative flex min-w-0 items-center gap-2.5">
            <span className="truncate font-semibold text-[17px] leading-[22px]">{current?.display_name ?? name}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {/* The native picker: the phone's own list, one tap. */}
            <select
              aria-label="Source"
              value={name}
              onChange={(e) => onSource(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {sources.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.display_name ?? s.name}
                </option>
              ))}
            </select>
          </label>
          <span className="flex-1" />
          <button
            type="button"
            aria-label={follow ? 'Pause' : 'Resume'}
            onClick={() => onFollow(!follow)}
            className="flex size-7 shrink-0 items-center justify-center border bg-background outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {follow ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          </button>
          <Link
            to="/search"
            search={{ source: name || undefined }}
            aria-label="Search"
            className="flex size-7 shrink-0 items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <SearchIcon className="size-3.5" />
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <LivePill state={state} rate={rate} />
          <span className="flex-1" />
          {summary && <span className="truncate font-mono text-muted-foreground text-xs">{summary}</span>}
        </div>
        <MiniHistogram buckets={buckets} levels={levels} />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Older cards fade under the header. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 bg-gradient-to-b from-30% from-background to-transparent" />
        <div ref={ref} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {rows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm">{empty}</div>
          ) : (
            <>
              {!top && <div className="flex-1" />}
              {rows.map((l) => (
                <MobileRow key={l.id} line={l} onOpen={onOpen} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
