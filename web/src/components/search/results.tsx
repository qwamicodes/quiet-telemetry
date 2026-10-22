import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, GitForkIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LevelBadge } from '@/components/level-badge'
import { StatusDot } from '@/components/status-dot'
import type { FlowSummary, LogLine } from '@/gen'
import { fmtDuration } from '@/lib/flow'
import { fmtRowTime, fmtTime } from '@/lib/format'
import { type FlowGroup, groupByFlow, highlight, notableFields } from '@/lib/query'
import { cn } from '@/lib/utils'

const HEAD = 52 // 12px gap + 40px header
const ROW = 28

type Item = { kind: 'head'; group: FlowGroup; open: boolean } | { kind: 'line'; line: LogLine; last: boolean }

function Marked({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {highlight(text, words).map((p, i) =>
        p.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string, never reordered
          <mark key={i} className="bg-status-warn/25 text-foreground">
            {p.s}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string, never reordered
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  )
}

function FieldChip({ k, v, words, onPick }: { k: string; v: string; words: string[]; onPick: (f: string) => void }) {
  const hit = words.some((w) => v.toLowerCase().includes(w))
  return (
    <button
      type="button"
      title={`Filter ${k}:${v}`}
      onClick={(e) => {
        e.stopPropagation()
        onPick(`${k}:${/\s/.test(v) ? `"${v}"` : v}`)
      }}
      className={cn(
        'shrink-0 truncate px-1 font-mono text-xs hover:bg-accent hover:text-foreground',
        hit ? 'bg-status-warn/20 text-foreground' : 'text-muted-foreground',
      )}
    >
      {k}:{v}
    </button>
  )
}

function LineRow({
  line,
  words,
  showSource,
  onPick,
  muted = false,
}: {
  line: LogLine
  words: string[]
  showSource: boolean
  onPick: (f: string) => void
  /** Matches its source's muted-lines rules and is shown anyway: dimmed and tagged. */
  muted?: boolean
}) {
  return (
    <div
      className={cn('flex h-full items-center gap-3 px-9 font-mono text-[13px]', muted && 'opacity-50')}
      data-line-id={line.id}
      data-muted={muted || undefined}
    >
      <span className="w-24 shrink-0 text-muted-foreground tabular-nums">{fmtRowTime(line.ts, 'seconds')}</span>
      <span className="w-12 shrink-0">
        <LevelBadge level={line.level} />
      </span>
      {showSource && <span className="w-28 shrink-0 truncate text-muted-foreground text-xs">{line.source}</span>}
      <span className="min-w-0 truncate">
        <Marked text={line.msg} words={words} />
      </span>
      {notableFields(line, words).map(([k, v]) => (
        <FieldChip key={k} k={k} v={v} words={words} onPick={onPick} />
      ))}
      <span className="flex-1" />
      {muted && (
        <span
          title="Matches this source’s muted-lines rules"
          className="shrink-0 border px-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.06em]"
        >
          muted
        </span>
      )}
      <FlowLink line={line} />
    </div>
  )
}

/** Open a line as its flow (by its id), or alone when it carries none. */
function FlowLink({ line }: { line: LogLine }) {
  const cls =
    'shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-brand'
  return line.display_id ? (
    <Link
      to="/flow/$id"
      params={{ id: line.display_id.value }}
      search={{ line: line.id }}
      aria-label="Open as flow"
      className={cls}
    >
      <GitForkIcon className="size-3.5" />
    </Link>
  ) : (
    <Link to="/line/$lineId" params={{ lineId: line.id }} aria-label="Open as flow" className={cls}>
      <GitForkIcon className="size-3.5" />
    </Link>
  )
}

const OUTCOME: Record<FlowSummary['status'], string> = { ok: 'ok', warn: 'warn', error: 'failed' }

function GroupHead({ group, open, onToggle }: { group: FlowGroup; open: boolean; onToggle: () => void }) {
  const f = group.summary
  const worst = f
    ? f.status === 'error'
      ? 'err'
      : f.status === 'warn'
        ? 'warn'
        : 'ok'
    : group.worst === 'error' || group.worst === 'fatal'
      ? 'err'
      : group.worst === 'warn'
        ? 'warn'
        : 'ok'
  const first = group.lines[group.lines.length - 1] ?? group.lines[0]
  const title = f?.title ?? (first.fields?.flow as string | undefined) ?? first.msg
  const sources = f?.sources ?? group.sources
  const n = group.lines.length
  return (
    <div className="mt-3 flex h-10 items-center gap-2.5 border border-b-0 bg-card px-3 data-[closed=true]:border-b">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Collapse' : 'Expand'}
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
      </button>
      <StatusDot status={worst} />
      <span className="min-w-0 truncate font-medium font-mono text-[13px]">{title}</span>
      {group.id && <span className="shrink-0 font-mono text-muted-foreground text-xs">{group.id.value}</span>}
      <span className="shrink-0 border px-1.5 font-mono text-[11px] text-muted-foreground">{sources.join(' → ')}</span>
      <span className="flex-1" />
      <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
        {f
          ? `${OUTCOME[f.status]} · ${n} of ${f.line_count} lines match · ${f.steps} ${f.steps === 1 ? 'step' : 'steps'} · ${fmtDuration(f.duration_ms)} · `
          : `${n} ${n === 1 ? 'line' : 'lines'} match · `}
        {fmtTime(group.last).slice(0, 8)}
      </span>
      {group.id ? (
        <Link
          to="/flow/$id"
          params={{ id: group.id.value }}
          className="flex shrink-0 items-center gap-1 text-xs hover:text-brand"
        >
          Open flow <ArrowRightIcon className="size-3.5" />
        </Link>
      ) : (
        <Link
          to="/line/$lineId"
          params={{ lineId: first.id }}
          className="flex shrink-0 items-center gap-1 text-xs hover:text-brand"
        >
          Open <ArrowRightIcon className="size-3.5" />
        </Link>
      )}
    </div>
  )
}

/**
 * Virtualized search results: grouped by the id each line shows (one card per
 * flow) or a flat list. Asks for the next page as the end comes into view.
 */
export function SearchResults({
  lines,
  view,
  words,
  hasMore,
  loadingMore,
  onMore,
  onPick,
  summaries,
  mutedIds,
}: {
  summaries?: Map<string, FlowSummary | null>
  /** Muted lines being shown (included in search): dimmed and tagged. */
  mutedIds?: ReadonlySet<number>
  lines: LogLine[]
  view: 'flows' | 'lines'
  words: string[]
  hasMore: boolean
  loadingMore: boolean
  onMore: () => void
  onPick: (filter: string) => void
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => groupByFlow(lines, summaries), [lines, summaries])
  const items: Item[] = useMemo(() => {
    if (view === 'lines') return lines.map((line) => ({ kind: 'line', line, last: false }))
    return groups.flatMap((g) => {
      const open = !closed.has(g.key)
      const head: Item = { kind: 'head', group: g, open }
      if (!open) return [head]
      return [head, ...g.lines.map((line, i): Item => ({ kind: 'line', line, last: i === g.lines.length - 1 }))]
    })
  }, [view, lines, groups, closed])

  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => (items[i].kind === 'head' ? HEAD : ROW),
    overscan: 12,
    getItemKey: (i) => {
      const it = items[i]
      return it.kind === 'head' ? `h:${it.group.key}` : `l:${it.line.id}`
    },
  })
  const virtual = v.getVirtualItems()
  const lastIndex = virtual.length ? virtual[virtual.length - 1].index : -1
  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= items.length - 10) onMore()
  }, [lastIndex, items.length, hasMore, loadingMore, onMore])

  const toggle = (key: string) =>
    setClosed((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-y-auto">
      <ul aria-label="Search results" style={{ height: v.getTotalSize(), position: 'relative' }}>
        {virtual.map((row) => {
          const it = items[row.index]
          return (
            <li
              key={row.key}
              style={{ transform: `translateY(${row.start}px)`, height: row.size }}
              className="absolute inset-x-0 top-0 list-none"
            >
              {it.kind === 'head' ? (
                <GroupHead group={it.group} open={it.open} onToggle={() => toggle(it.group.key)} />
              ) : (
                <div
                  className={cn(
                    'group/row h-full border-border/60 border-x hover:bg-row-hover',
                    view === 'lines' ? 'border-b' : 'border-t',
                    it.last && 'border-b',
                    (it.line.level === 'error' || it.line.level === 'fatal') && 'bg-row-error',
                  )}
                >
                  <LineRow
                    line={it.line}
                    words={words}
                    showSource={view === 'lines'}
                    onPick={onPick}
                    muted={mutedIds?.has(it.line.id) ?? false}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {loadingMore && <p className="py-3 text-center font-mono text-muted-foreground text-xs">Loading more…</p>}
    </div>
  )
}
