import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LevelBadge } from '@/components/level-badge'
import { StatusDot } from '@/components/status-dot'
import type { LogLine } from '@/gen'
import { fmtTime } from '@/lib/format'
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
}: {
  line: LogLine
  words: string[]
  showSource: boolean
  onPick: (f: string) => void
}) {
  return (
    <div className="flex h-full items-center gap-3 px-9 font-mono text-[13px]" data-line-id={line.id}>
      <span className="w-24 shrink-0 text-muted-foreground tabular-nums">{fmtTime(line.ts).slice(0, 8)}</span>
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
    </div>
  )
}

function GroupHead({ group, open, onToggle }: { group: FlowGroup; open: boolean; onToggle: () => void }) {
  const worst = group.worst === 'error' || group.worst === 'fatal' ? 'err' : group.worst === 'warn' ? 'warn' : 'ok'
  const first = group.lines[group.lines.length - 1] ?? group.lines[0]
  const title = (first.fields?.flow as string | undefined) ?? first.msg
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
      <span className="shrink-0 border px-1.5 font-mono text-[11px] text-muted-foreground">
        {group.sources.join(' → ')}
      </span>
      <span className="flex-1" />
      <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
        {group.lines.length} {group.lines.length === 1 ? 'line' : 'lines'} match · {fmtTime(group.last).slice(0, 8)}
      </span>
      {group.id && (
        <Link
          to="/flow/$id"
          params={{ id: group.id.value }}
          className="flex shrink-0 items-center gap-1 text-xs hover:text-brand"
        >
          Open flow <ArrowRightIcon className="size-3.5" />
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
}: {
  lines: LogLine[]
  view: 'flows' | 'lines'
  words: string[]
  hasMore: boolean
  loadingMore: boolean
  onMore: () => void
  onPick: (filter: string) => void
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => groupByFlow(lines), [lines])
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
                    'h-full border-border/60 border-x hover:bg-row-hover',
                    view === 'lines' ? 'border-b' : 'border-t',
                    it.last && 'border-b',
                    (it.line.level === 'error' || it.line.level === 'fatal') && 'bg-row-error',
                  )}
                >
                  <LineRow line={it.line} words={words} showSource={view === 'lines'} onPick={onPick} />
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
