import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { ClockIcon, FilterXIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TOGGLE_PAUSE } from '@/components/command-palette'
import { ExportDialog } from '@/components/export-dialog'
import { MutedNote } from '@/components/muted-note'
import { ErrorRateBanner, GapBanner, SourceLostBanner } from '@/components/stream/connection-banner'
import { FilterBar, FilterChip } from '@/components/stream/filter-bar'
import { LogTable, type RowActions } from '@/components/stream/log-table'
import { StreamFooter } from '@/components/stream/stream-footer'
import { StreamHistogram, withLive } from '@/components/stream/stream-histogram'
import { liveState, TopBar } from '@/components/stream/top-bar'
import { Button } from '@/components/ui/button'
import type { LevelTally, LogLine } from '@/gen'
import { useHealth, useSources } from '@/lib/api'
import { useConnection } from '@/lib/connection'
import { fmtTime, fmtWindow } from '@/lib/format'
import { chipOf, isOn, type LevelChip, levelsFromParam, levelsToParam, toggleChip } from '@/lib/levels'
import { useMuted } from '@/lib/mute'
import { joinQuery, splitQuery } from '@/lib/query'
import { rowParts } from '@/lib/row'
import { useSettings } from '@/lib/settings-api'
import { useStreamStats } from '@/lib/stream-api'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounced'
import { useHotkeys } from '@/lib/use-hotkeys'
import { useRates } from '@/lib/use-rates'
import { useStream } from '@/lib/use-stream'
import { Welcome } from '@/routes/connect'

const route = getRouteApi('/')
const FIVE_MIN = 5 * 60_000

async function copyText(text: string, title: string, description?: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(title, description ? { description } : undefined)
  } catch {
    toast.error('Clipboard is not available here')
  }
}

/** The id key most rows show: what this source's flows are stitched by. */
function stitchedBy(lines: LogLine[]): string | null | undefined {
  if (!lines.length) return undefined
  const n = new Map<string, number>()
  for (const l of lines.slice(-500)) if (l.display_id) n.set(l.display_id.key, (n.get(l.display_id.key) ?? 0) + 1)
  let best: string | null = null
  let max = 0
  for (const [k, c] of n) if (c > max) [best, max] = [k, c]
  return best
}

/** Errors in the last 5 minutes against the window's usual share (design 03.4). */
function errorSpike(lines: LogLine[], stats: LevelTally | null, total: number) {
  const now = Date.now()
  const recent = lines.filter((l) => now - l.ts < FIVE_MIN)
  const errors = recent.filter((l) => l.level === 'error' || l.level === 'fatal')
  if (recent.length < 20 || errors.length < 10) return null
  const share = (errors.length / recent.length) * 100
  const usual = stats && total ? (stats.error / total) * 100 : 0
  if (share < 20 || share < usual * 3) return null
  const by = new Map<string, number>()
  for (const l of errors) {
    const p = rowParts(l)
    const label = [p.name ?? (p.path ? `${p.method} ${p.path}` : ''), p.event, p.outcome].filter(Boolean).join(' ')
    by.set(label, (by.get(label) ?? 0) + 1)
  }
  let top: { label: string; count: number } | null = null
  for (const [label, count] of by) if (!top || count > top.count) top = { label, count }
  return { share, usual, top }
}

export function StreamPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const go = useNavigate()
  const { data: sources } = useSources()
  const health = useHealth().data
  const rates = useRates(sources)
  const source = search.source ?? null
  const settings = useSettings().data
  const conn = useConnection()
  // A source's default level (a minimum) applies until the URL says otherwise (`all` = every level).
  const sourceDefault = settings?.sources[source ?? '']?.default_level ?? null
  const levels = useMemo(() => levelsFromParam(search.level, sourceDefault), [search.level, sourceDefault])
  const levelsCsv = levels.join(',')
  const setLevels = (next: LevelChip[]) =>
    navigate({ search: (s) => ({ ...s, level: levelsToParam(next, sourceDefault) }), replace: true })
  const [direction, setDirection] = useStreamDirection(settings?.general.stream_direction)
  const [wrap, setWrap] = useState(false)

  // Pick the first source when none is in the URL.
  useEffect(() => {
    if (!source && sources?.length) navigate({ search: (s) => ({ ...s, source: sources[0].name }), replace: true })
  }, [source, sources, navigate])

  // Chips are `key:value` filters; free text is typed and follows 250ms later.
  const { chips } = splitQuery(search.q ?? '')
  const [text, setText] = useState(() => splitQuery(search.q ?? '').text)
  const debounced = useDebounced(text, 250)
  const setQ = useCallback(
    (nextChips: string[], nextText: string) =>
      navigate({ search: (s) => ({ ...s, q: joinQuery(nextChips, nextText) || undefined }), replace: true }),
    [navigate],
  )
  useEffect(() => {
    const cur = splitQuery(search.q ?? '')
    if (cur.text !== debounced.trim()) setQ(cur.chips, debounced)
  }, [debounced, search.q, setQ])
  const addChip = (c: string) => {
    const key = c.replace(/^-/, '').split(':')[0]
    // One chip per key and sign: clicking another status replaces the old one.
    setQ(
      [...chips.filter((x) => x.replace(/^-/, '').split(':')[0] !== key || x.startsWith('-') !== c.startsWith('-')), c],
      text,
    )
  }
  const removeChip = (c: string) =>
    setQ(
      chips.filter((x) => x !== c),
      text,
    )
  const clearFilters = () => {
    setText('')
    navigate({ search: (s) => ({ ...s, q: undefined, level: levelsToParam([], sourceDefault) }), replace: true })
  }

  const {
    lines: received,
    state,
    dropped,
    retryNow,
    everConnected,
  } = useStream({ source, levels: levelsCsv, q: search.q })
  // Muted lines (06.3): hidden unless "show"; the count stays visible.
  const [showMuted, setShowMuted] = useState(false)
  const { visible: lines, muted } = useMuted(received, showMuted)
  const stats = useStreamStats(source, search.q)
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [unseen, setUnseen] = useState(0)
  const [scrolledUp, setScrolledUp] = useState(0)
  const [showOld, setShowOld] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)

  // A new source starts fresh: nothing selected, following the live edge.
  const [shownSource, setShownSource] = useState(source)
  if (shownSource !== source) {
    setShownSource(source)
    setSelectedId(null)
    setExpandedId(null)
    setFollow(true)
    setShowOld(false)
  }

  // "Pause stream" in ⌘K.
  useEffect(() => {
    const t = () => setFollow((f) => !f)
    window.addEventListener(TOGGLE_PAUSE, t)
    return () => window.removeEventListener(TOGGLE_PAUSE, t)
  }, [])

  // A short "back online" note after a drop, nothing on first connect.
  const wasDown = useRef(false)
  const unseenAtDrop = useRef(0)
  useEffect(() => {
    if (state === 'reconnecting') wasDown.current = true
    if (state === 'live' && wasDown.current) {
      wasDown.current = false
      toast.info(`${source ?? 'The stream'} reconnected`, {
        description: unseenAtDrop.current
          ? `${unseenAtDrop.current} buffered lines replayed in order.`
          : 'Lines that arrived meanwhile were replayed in order.',
      })
    }
  }, [state, source])
  useEffect(() => {
    unseenAtDrop.current = unseen
  }, [unseen])

  const selectedIndex = selectedId == null ? -1 : lines.findIndex((l) => l.id === selectedId)
  const selected = selectedIndex >= 0 ? lines[selectedIndex] : null
  const move = (by: number) => {
    if (!lines.length) return
    const from = selectedIndex >= 0 ? selectedIndex : by > 0 ? -1 : lines.length
    const next = Math.min(lines.length - 1, Math.max(0, from + by))
    setFollow(false)
    setSelectedId(lines[next].id)
    if (expandedId != null) setExpandedId(lines[next].id)
  }

  // Any line opens as a flow: by its id when it has one, else by itself (one node).
  const openFlow = useCallback(
    (l: LogLine) =>
      l.display_id
        ? go({ to: '/flow/$id', params: { id: l.display_id.value }, search: { line: l.id } })
        : go({ to: '/line/$lineId', params: { lineId: l.id } }),
    [go],
  )

  const actionsRef = useRef<RowActions | null>(null)
  actionsRef.current = {
    onSelect: (l) => {
      setFollow(false)
      setSelectedId(l.id)
      setExpandedId((e) => (e === l.id ? null : l.id))
    },
    onOpenFlow: openFlow,
    onCopy: (l) =>
      copyText(
        l.fields ? JSON.stringify(l.fields, null, 2) : JSON.stringify({ raw: l.raw }),
        'Copied line as JSON',
        `${l.display_id?.value ?? `line ${l.id}`} · ${new TextEncoder().encode(l.raw).length} bytes`,
      ),
    onFilter: addChip,
  }
  // Stable identity so memoized rows don't re-render on every frame.
  const actions = useMemo<RowActions>(
    () => ({
      onSelect: (l) => actionsRef.current?.onSelect(l),
      onOpenFlow: (l) => actionsRef.current?.onOpenFlow(l),
      onCopy: (l) => actionsRef.current?.onCopy(l),
      onFilter: (c) => actionsRef.current?.onFilter(c),
    }),
    [],
  )

  // Counts: the server's 24h window, plus what streamed in after that snapshot.
  const snap = stats.data
  const liveAfter = useMemo(() => (snap ? lines.filter((l) => l.ts > snap.until) : []), [lines, snap])
  const tally: LevelTally | null = useMemo(() => {
    if (!snap) return null
    const t = { ...snap.levels }
    for (const l of liveAfter) {
      const c = chipOf(l.level)
      if (c) t[c]++
      else t.none++
    }
    return t
  }, [snap, liveAfter])
  const total = (snap?.total ?? 0) + (search.q ? 0 : liveAfter.length)
  const matched = tally
    ? (['debug', 'info', 'warn', 'error'] as const).reduce((n, c) => n + (isOn(levels, c) ? tally[c] : 0), 0) +
      (levels.length === 0 ? tally.none : 0)
    : null
  const buckets = useMemo(
    () => (snap ? withLive(snap.histogram, snap.hist_since, snap.hist_width, snap.until, liveAfter) : []),
    [snap, liveAfter],
  )

  const live = liveState(state, !follow, everConnected)
  const filtered = levels.length > 0 || Boolean(search.q)
  const windowLabel = fmtWindow(health?.retention_ms ?? 86_400_000)
  const info = sources?.find((s) => s.name === source)
  const rate = source ? (rates[source] ?? null) : null
  const matchRate = useMemo(() => {
    if (!filtered) return null
    const recent = lines.filter((l) => Date.now() - l.ts < 30_000).length
    return recent / 30
  }, [filtered, lines])

  // Docker source whose log stream dropped while the server is fine (03.7).
  const sourceLost =
    info?.kind === 'docker' && (health?.docker.state === 'connecting' || health?.docker.state === 'unavailable')
  const offline = live === 'offline' || sourceLost
  // Healthy but nothing for 5 minutes (08.5).
  const newest = lines.length ? lines[lines.length - 1].ts : (info?.last_ts ?? null)
  const quiet = live === 'live' && !filtered && !showOld && newest != null && Date.now() - newest > FIVE_MIN
  const spike = !filtered && live !== 'offline' ? errorSpike(lines, tally, total) : null
  const shown = quiet ? [] : lines

  useHotkeys({
    '/': () => filterRef.current?.focus(),
    j: () => move(direction === 'top' ? -1 : 1),
    k: () => move(direction === 'top' ? 1 : -1),
    space: () => {
      // A selected row opens/closes its preview; otherwise space pauses.
      if (selected) setExpandedId((e) => (e === selected.id ? null : selected.id))
      else if (state === 'live') setFollow((f) => !f)
    },
    g: (e) => {
      if (e.shiftKey || e.key === 'G') {
        setFollow(true)
        setSelectedId(null)
        setExpandedId(null)
      }
    },
    escape: () => {
      setSelectedId(null)
      setExpandedId(null)
    },
    enter: () => selected && openFlow(selected),
    e: () => setLevels(['error']),
    x: clearFilters,
    '1': () => setLevels(toggleChip(levels, 'debug')),
    '2': () => setLevels(toggleChip(levels, 'info')),
    '3': () => setLevels(toggleChip(levels, 'warn')),
    '4': () => setLevels(toggleChip(levels, 'error')),
  })

  const filterWords = [
    levels.length > 0 && levels.join(', '),
    ...chips.map((c) => c.replace(/^(-?[^:]+):>=/, '$1 ≥').replace(/^(-?[^:]+):<=/, '$1 ≤')),
    splitQuery(search.q ?? '').text && `“${splitQuery(search.q ?? '').text}”`,
  ].filter(Boolean)
  const footer = (() => {
    if (conn.down)
      return `disconnected · showing ${lines.length.toLocaleString()} lines received before ${conn.since ? fmtTime(conn.since).slice(0, 8) : 'the drop'}`
    if (live === 'connecting') return 'loading recent lines · then streaming live'
    if (offline) return `offline · showing the last ${lines.length.toLocaleString()} lines`
    if (live === 'paused')
      return `paused · ${scrolledUp ? `scrolled ${scrolledUp.toLocaleString()} ${scrolledUp === 1 ? 'line' : 'lines'} up · ` : ''}${unseen.toLocaleString()} new lines buffered`
    if (filtered && matched === 0) return `filtered · 0 of ${total.toLocaleString()} lines · still listening`
    if (filtered) return `filtered · ${filterWords.join(' · ')}`
    if (quiet) return `listening · 0 lines in 5 min`
    if (spike) {
      const errs = lines.filter((l) => (l.level === 'error' || l.level === 'fatal') && Date.now() - l.ts < 15 * 60_000)
      return `streaming · ${errs.length.toLocaleString()} errors in the last 15 min`
    }
    return `streaming · newest at ${direction} · ${total.toLocaleString()} lines in ${windowLabel} window`
  })()

  const onUnseen = useCallback((u: number, up: number) => {
    setUnseen(u)
    setScrolledUp(up)
  }, [])

  // First run: nothing has sent a line yet.
  if (sources?.length === 0 && !source) return <Welcome />
  const sourceName = info?.display_name ?? source ?? ''
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        source={info}
        name={source}
        state={sourceLost && live === 'live' ? 'offline' : live}
        rate={conn.down ? null : rate}
        matchRate={matchRate}
        buffered={unseen}
        stitchedBy={lines.length ? stitchedBy(lines) : undefined}
        offlineReason={conn.down ? 'server unreachable' : 'reconnecting'}
        onTogglePause={() => setFollow((f) => !f)}
        onExport={source ? () => setExporting(true) : undefined}
      />
      <FilterBar
        chips={chips}
        text={text}
        onText={setText}
        onRemoveChip={removeChip}
        onSubmitChip={addChip}
        levels={levels}
        onToggleLevel={(l) => setLevels(toggleChip(levels, l))}
        counts={tally}
        inputRef={filterRef}
        direction={direction}
        onDirection={setDirection}
        wrap={wrap}
        onWrap={setWrap}
      />
      {sourceLost && source && <SourceLostBanner source={sourceName} lastTs={newest} onRetry={retryNow} />}
      {spike && (
        <ErrorRateBanner
          share={spike.share}
          usual={spike.usual}
          top={spike.top}
          onErrorsOnly={() => setLevels(['error'])}
          onGroup={() =>
            go({
              to: '/search',
              search: { q: 'level:error', source: source ?? undefined, range: '15m', view: 'flows' },
            })
          }
        />
      )}
      {dropped > 0 && <GapBanner dropped={dropped} />}
      <StreamHistogram
        buckets={buckets}
        since={snap?.hist_since ?? Date.now() - 3_600_000}
        width={snap?.hist_width ?? 60_000}
        levels={levels}
        loading={!snap}
        dim={offline || conn.down}
      />
      {filtered && matched != null && matched > 0 && (
        <div className="mx-6 mb-2 flex items-center gap-2 font-mono text-muted-foreground text-xs">
          <span>
            <span className="text-foreground">{matched.toLocaleString()}</span> of {total.toLocaleString()} lines match
            · still streaming, matches appear live
          </span>
          <Button variant="ghost" size="xs" onClick={clearFilters}>
            <FilterXIcon />
            Clear filters
          </Button>
        </div>
      )}
      {muted > 0 && source && (
        <MutedNote count={muted} shown={showMuted} onToggle={() => setShowMuted((v) => !v)} source={source} />
      )}
      <div className="flex min-h-0 flex-1 gap-3 px-6 pb-3">
        <LogTable
          lines={shown}
          selectedId={selectedId}
          expandedId={expandedId}
          follow={follow}
          onFollow={setFollow}
          direction={direction}
          wrap={wrap}
          loading={live === 'connecting'}
          dim={offline || conn.down}
          actions={actions}
          onUnseen={onUnseen}
          empty={
            !source ? (
              <span className="text-muted-foreground">Waiting for the first source…</span>
            ) : quiet ? (
              <QuietState
                name={sourceName}
                source={source ?? ''}
                last={newest}
                onShow={() => setShowOld(true)}
                hasLines={lines.length > 0}
              />
            ) : filtered ? (
              <NoMatches
                source={sourceName}
                chips={chips}
                levels={levels}
                text={splitQuery(search.q ?? '').text}
                window={windowLabel}
                onClear={clearFilters}
                onRemove={removeChip}
              />
            ) : (
              <span className="flex flex-col items-center gap-2 text-muted-foreground">
                No lines yet. New lines appear here as they arrive.
                <Link to="/guide" className="text-brand text-xs hover:underline">
                  New here? How quiet works and the agent prompt →
                </Link>
              </span>
            )
          }
        />
      </div>
      <StreamFooter
        state={conn.down || offline ? 'offline' : live === 'live' && filtered ? 'filtered' : quiet ? 'quiet' : live}
        text={footer}
      />
      {source && exporting && (
        <ExportDialog
          open={exporting}
          onOpenChange={setExporting}
          title="Export lines"
          description="What you see in the stream: this source, these filters, this time range."
          params={{
            source,
            levels: levelsCsv || undefined,
            q: search.q,
            since: lines[0]?.ts ?? Date.now() - 15 * 60_000,
            until: Date.now(),
          }}
          rangeNote="from the stream view"
          summary={
            <>
              <div className="flex min-h-7 items-center gap-3 border-border/60 border-b py-1">
                <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">source</span>
                <span className="border px-1.5 font-mono text-xs">{sourceName}</span>
                <span className="font-mono text-muted-foreground text-xs">{info?.kind}</span>
              </div>
              <div className="flex min-h-7 flex-wrap items-center gap-1.5 border-border/60 border-b py-1">
                <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">filters</span>
                {chips.map((c) => (
                  <FilterChip key={c} chip={c} />
                ))}
                {splitQuery(search.q ?? '').text && (
                  <span className="font-mono text-xs">“{splitQuery(search.q ?? '').text}”</span>
                )}
                <span className="font-mono text-muted-foreground text-xs">
                  {levels.length ? `level ${levels.join(', ')}` : chips.length ? '' : 'none · every level'}
                </span>
              </div>
            </>
          }
        />
      )}
    </div>
  )
}

/** Nothing matches the filters (design 03.6). */
function NoMatches({
  source,
  chips,
  levels,
  text,
  window,
  onClear,
  onRemove,
}: {
  source: string
  chips: string[]
  levels: LevelChip[]
  text: string
  window: string
  onClear: () => void
  onRemove: (c: string) => void
}) {
  const what = [
    ...chips.map((c) => c.replace(/^(-?[^:]+):/, '$1:')),
    text && `“${text}”`,
    levels.length && `level ${levels.join(' or ')}`,
  ]
    .filter(Boolean)
    .join(' and ')
  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-4">
      <div className="flex w-full flex-col items-center gap-3 border border-dashed p-8 text-center">
        <span className="border p-1.5">
          <FilterXIcon className="size-4 text-muted-foreground" />
        </span>
        <h2 className="font-medium">No lines match</h2>
        <p className="text-muted-foreground">
          Nothing in {source} has {what || 'these filters'} in the last {window}. New matches will appear here live.
        </p>
        <Button size="sm" onClick={onClear}>
          Clear filters
        </Button>
      </div>
      {chips.length > 0 && (
        <p className="flex flex-wrap items-center justify-center gap-1.5 font-mono text-muted-foreground text-xs">
          Try removing:
          {chips.map((c) => (
            <button key={c} type="button" onClick={() => onRemove(c)} className="hover:opacity-80">
              <FilterChip chip={c} />
            </button>
          ))}
          or{' '}
          <Link
            to="/search"
            search={{ q: [text, ...chips].filter(Boolean).join(' ') || undefined }}
            className="text-brand hover:underline"
          >
            search all sources
          </Link>
        </p>
      )}
    </div>
  )
}

/** Connected and healthy, just nothing new (design 08.5). */
function QuietState({
  name,
  source,
  last,
  hasLines,
  onShow,
}: {
  name: string
  source: string
  last: number | null
  hasLines: boolean
  onShow: () => void
}) {
  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-3 border border-dashed p-8 text-center">
      <span className="border p-1.5">
        <ClockIcon className="size-4 text-muted-foreground" />
      </span>
      <h2 className="font-medium">{name} is quiet</h2>
      <p className="text-muted-foreground">
        No lines in the last 5 min. The connection is healthy, so new lines will stream in the moment they are written.
      </p>
      <p className="font-mono text-muted-foreground text-xs">
        <span className="text-status-ok">●</span> still listening
        {last ? ` · last line ${fmtTime(last).slice(0, 8)}` : ''}
        {hasLines && (
          <>
            {' · '}
            <button type="button" onClick={onShow} className="text-brand hover:underline">
              show the last lines
            </button>
          </>
        )}
      </p>
      <Link to="/guide" search={{ tab: 'check', source }} className="text-brand text-xs hover:underline">
        Check {name}'s logs against the canonical line →
      </Link>
    </div>
  )
}

const DIRECTION_KEY = 'quiet.stream-direction'

/** The instance default (Settings → General), unless this browser flipped it. */
function useStreamDirection(instance: 'bottom' | 'top' | undefined) {
  const [mine, setMine] = useState<'bottom' | 'top' | null>(() => {
    try {
      const v = localStorage.getItem(DIRECTION_KEY)
      return v === 'top' || v === 'bottom' ? v : null
    } catch {
      return null
    }
  })
  const set = (d: 'bottom' | 'top') => {
    setMine(d)
    try {
      localStorage.setItem(DIRECTION_KEY, d)
    } catch {}
  }
  return [mine ?? instance ?? 'bottom', set] as const
}
