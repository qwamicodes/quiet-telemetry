import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArchiveIcon, ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, EyeOffIcon, GitForkIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LevelBadge } from '@/components/level-badge'
import { StatusDot } from '@/components/status-dot'
import type { FlowSummary, LogLine } from '@/gen'
import { fmtDuration } from '@/lib/flow'
import { fmtRowTime, fmtTime } from '@/lib/format'
import { inSpan, jumpIndex, nearestIndex, type Span } from '@/lib/histogram-jump'
import { type FlowGroup, groupByFlow, highlight, notableFields } from '@/lib/query'
import { lineDuration, type RowParts, rowParts } from '@/lib/row'
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
        'min-w-0 max-w-full truncate px-1 font-mono text-xs hover:bg-accent hover:text-foreground',
        hit ? 'bg-status-warn/20 text-foreground' : 'text-muted-foreground',
      )}
    >
      {k}:{v}
    </button>
  )
}

/** A field `key` read from a line (dotted paths reach into objects). */
function fieldAt(line: LogLine, key: string): unknown {
  const f = line.fields as Record<string, unknown> | undefined
  if (!f) return undefined
  if (key in f) return f[key]
  let cur: unknown = f
  for (const p of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

const TONE: Record<RowParts['tone'], string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  err: 'text-status-err',
  muted: 'text-muted-foreground',
}

/**
 * One result (v0.1.1-05.1, aligned lanes): time · level · summary · the field
 * the search matched · details. The summary reads like the stream's
 * FLOW · RESULT: `fetch_payouts · GET /api/v1/… → 200 · slow`,
 * `settle_dealer_payout · attempt 0 → timeout`.
 */
function LineRow({
  line,
  words,
  matchKeys,
  showSource,
  onPick,
  muted = false,
  mutedBy,
  flash = false,
  location,
}: {
  /** Found in retained history: the destination it came from. */
  location?: string
  line: LogLine
  words: string[]
  /** The search's `key:value` field filters. */
  matchKeys: [string, string][]
  showSource: boolean
  onPick: (f: string) => void
  /** In the histogram bar just jumped to: briefly tinted. */
  flash?: boolean
  /** Matches its source's muted-lines rules and is shown anyway: dimmed and tagged. */
  muted?: boolean
  /** The rule that mutes it (`path:/api/v1/health`). */
  mutedBy?: string
}) {
  const p = rowParts(line)
  const attempt = p.extra.find((x) => x.startsWith('attempt '))
  const extras = p.extra.filter((x) => x !== attempt)
  const head = p.path
    ? `${p.event} · ${p.method} ${p.path}`
    : line.fields
      ? `${p.event}${attempt ? ` · ${attempt}` : ''}`
      : line.msg
  // The field the search matched, else a free-text hit among the fields.
  const matched = matchKeys
    .map(([k]) => [k, fieldAt(line, k)] as const)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => [k, String(v)] as [string, string])
  const match =
    matched[0] ??
    notableFields(line, words, 1).find(([k, v]) =>
      words.some((w) => v.toLowerCase().includes(w) || k.toLowerCase().includes(w)),
    )
  const dur = lineDuration(line)
  const meta = [
    dur != null ? `duration_ms:${dur}` : null,
    ...notableFields(line, [], 2)
      .filter(([k]) => k !== 'duration_ms' && k !== 'status' && k !== 'status_code' && k !== match?.[0])
      .filter(([k]) => !/^(attempt|err\.code|error\.code|outcome)$/.test(k))
      .map(([k, v]) => `${k}:${v}`),
  ].filter(Boolean) as string[]
  return (
    <div
      className={cn(
        'flex h-full items-center gap-4 px-9 font-mono text-[13px] transition-colors',
        muted && 'opacity-50',
        flash && 'bg-brand/10 shadow-[inset_2px_0_0_var(--brand)]',
      )}
      data-line-id={line.id}
      data-flash={flash || undefined}
      data-muted={muted || undefined}
    >
      <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{fmtRowTime(line.ts, 'seconds')}</span>
      <span className="w-12 shrink-0">
        <LevelBadge level={line.level} />
      </span>
      {showSource && <span className="w-28 shrink-0 truncate text-muted-foreground text-xs">{line.source}</span>}
      <span data-lane="summary" className="w-[420px] shrink-0 truncate max-md:w-auto max-md:min-w-0 max-md:flex-1">
        <Marked text={head} words={words} />
        {p.outcome != null && line.fields && (
          <>
            <span className="text-muted-foreground"> → </span>
            <span className={TONE[p.tone]}>{p.outcome}</span>
          </>
        )}
        {extras.map((x, i) => (
          <span key={x} className={i === 0 && p.extraTone ? TONE[p.extraTone] : 'text-muted-foreground'}>
            <span className="text-muted-foreground"> · </span>
            {x}
          </span>
        ))}
      </span>
      <span data-lane="match" className="flex w-[200px] min-w-0 shrink-0 overflow-hidden max-md:hidden">
        {match && <FieldChip k={match[0]} v={match[1]} words={[match[1].toLowerCase()]} onPick={onPick} />}
      </span>
      <span data-lane="meta" className="min-w-0 flex-1 truncate text-muted-foreground text-xs max-md:hidden">
        {meta.join(' · ')}
      </span>
      {muted && mutedBy && (
        <span className="max-w-48 shrink-0 truncate text-muted-foreground text-xs max-md:hidden">rule {mutedBy}</span>
      )}
      {muted && <MutedTag />}
      {location && <LocationTag name={location} />}
      <FlowLink line={line} />
    </div>
  )
}

/** 05.9: an eye-off "muted" tag on muted rows and their group. */
function MutedTag() {
  return (
    <span
      title="Matches this source’s muted-lines rules"
      className="flex shrink-0 items-center gap-1 border px-1 font-mono text-[10px] text-muted-foreground"
    >
      <EyeOffIcon className="size-3" />
      muted
    </span>
  )
}

/** Found in retained history: where (v1.1-19 … 23). */
function LocationTag({ name }: { name: string }) {
  return (
    <span
      title={`From retained history in ${name}`}
      className="flex max-w-36 shrink-0 items-center gap-1 border border-brand/40 px-1 font-mono text-[10px] text-muted-foreground"
    >
      <ArchiveIcon className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
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

function GroupHead({
  group,
  open,
  onToggle,
  muted = false,
  location,
}: {
  location?: string
  group: FlowGroup
  open: boolean
  onToggle: () => void
  muted?: boolean
}) {
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
  // 05.1: "1 request · 1.9s", "3 attempts · 9.6s", "1 job · 412ms".
  const reqs = group.lines.filter((l) => {
    const p = rowParts(l)
    return Boolean(p.path)
  }).length
  const attempts = group.lines.filter((l) => {
    const f = l.fields as Record<string, unknown> | undefined
    return Boolean(f && (f.job_id ?? f.jobId) && f.attempt != null)
  }).length
  const jobs = new Set(
    group.lines.map((l) => (l.fields as Record<string, unknown> | undefined)?.job_id).filter(Boolean),
  ).size
  const kind = [
    reqs && `${reqs} ${reqs === 1 ? 'request' : 'requests'}`,
    attempts > 1 ? `${attempts} attempts` : jobs ? `${jobs} ${jobs === 1 ? 'job' : 'jobs'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
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
      {muted && <MutedTag />}
      {location && <LocationTag name={location} />}
      <span className="flex-1" />
      <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
        <span className="text-[11px]">
          {f ? `${OUTCOME[f.status]} · ` : ''}
          {n} {n === 1 ? 'event matches' : 'events match'}
        </span>
        {kind && <span className="ml-3">{kind}</span>}
        {f && ` · ${fmtDuration(f.duration_ms)}`}
        <span className="ml-3">{fmtTime(group.last).slice(0, 8)}</span>
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
  matchKeys = [],
  hasMore,
  loadingMore,
  onMore,
  onPick,
  summaries,
  mutedIds,
  mutedRule,
  locationOf,
  refreshing = false,
  jump = null,
  flash = null,
}: {
  /**
   * Histogram jump: scroll so the first result in `span` sits at the top. A
   * new `n` asks again; it waits for results that aren't placeholders.
   */
  jump?: { span: Span; n: number } | null
  /** Results in this span are tinted (the bar just jumped to). */
  flash?: Span | null
  /** These are the previous search's results; the new search is in flight. Dimmed. */
  refreshing?: boolean
  summaries?: Map<string, FlowSummary | null>
  /** Muted lines being shown (included in search): dimmed and tagged. */
  mutedIds?: ReadonlySet<number>
  /** The rule text behind each muted line. */
  mutedRule?: (lineId: number) => string | undefined
  /** Lines found in retained history: their destination. */
  locationOf?: (lineId: number) => string | undefined
  lines: LogLine[]
  view: 'flows' | 'lines'
  words: string[]
  /** The search's `key:value` field filters: each row shows the one it matched. */
  matchKeys?: [string, string][]
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

  const jumped = useRef(0)
  useEffect(() => {
    if (!jump || jumped.current === jump.n || refreshing || !items.length) return
    const at = items.map((it) => ({ ts: it.kind === 'line' ? it.line.ts : Number.NaN }))
    let i = jumpIndex(at, jump.span)
    if (i < 0) i = nearestIndex(at, jump.span)
    if (i < 0) return
    // A line that opens its group: show the group's header with it.
    if (i > 0 && items[i - 1].kind === 'head') i--
    jumped.current = jump.n
    v.scrollToIndex(i, { align: 'start' })
  }, [jump, items, refreshing, v])

  const toggle = (key: string) =>
    setClosed((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  return (
    <div
      ref={ref}
      aria-busy={refreshing || undefined}
      className={cn('relative min-h-0 flex-1 overflow-y-auto transition-opacity', refreshing && 'opacity-55')}
    >
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
                <GroupHead
                  group={it.group}
                  open={it.open}
                  onToggle={() => toggle(it.group.key)}
                  muted={it.group.lines.some((l) => mutedIds?.has(l.id))}
                  location={it.group.lines.map((l) => locationOf?.(l.id)).find(Boolean)}
                />
              ) : (
                <div
                  className={cn(
                    'group/row h-full border-border/60 border-x hover:bg-row-hover',
                    view === 'lines' ? 'border-b' : 'border-t',
                    it.last && 'border-b',
                  )}
                >
                  <LineRow
                    line={it.line}
                    words={words}
                    matchKeys={matchKeys}
                    showSource={view === 'lines'}
                    onPick={onPick}
                    muted={mutedIds?.has(it.line.id) ?? false}
                    mutedBy={mutedRule?.(it.line.id)}
                    flash={flash != null && inSpan(it.line.ts, flash)}
                    location={locationOf?.(it.line.id)}
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
