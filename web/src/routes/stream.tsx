import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ExportDialog } from '@/components/export-dialog'
import { FieldCard } from '@/components/field-card'
import { ConnectionBanner, GapBanner } from '@/components/stream/connection-banner'
import { FilterBar } from '@/components/stream/filter-bar'
import { LogTable } from '@/components/stream/log-table'
import { StreamFooter } from '@/components/stream/stream-footer'
import { liveState, TopBar } from '@/components/stream/top-bar'
import type { LogLine } from '@/gen'
import { useSources } from '@/lib/api'
import { LEVEL_FILTERS, type LevelFilter } from '@/lib/format'
import { useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounced'
import { useHotkeys } from '@/lib/use-hotkeys'
import { useRates } from '@/lib/use-rates'
import { useStream } from '@/lib/use-stream'
import { Welcome } from '@/routes/connect'

const route = getRouteApi('/')

export function StreamPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const go = useNavigate()
  const { data: sources } = useSources()
  const rates = useRates(sources)
  const source = search.source ?? null
  const settings = useSettings().data
  // A source's default level applies until the URL says otherwise (`all` = none).
  const fallback = settings?.sources[source ?? '']?.default_level
  const sourceDefault: LevelFilter =
    fallback && (LEVEL_FILTERS as readonly string[]).includes(fallback)
      ? (fallback as LevelFilter)
      : fallback === 'fatal'
        ? 'error'
        : ''
  const level: LevelFilter = search.level === 'all' ? '' : (search.level ?? sourceDefault)
  const [direction, setDirection] = useStreamDirection(settings?.general.stream_direction)

  // Pick the first source when none is in the URL.
  useEffect(() => {
    if (!source && sources?.length) navigate({ search: (s) => ({ ...s, source: sources[0].name }), replace: true })
  }, [source, sources, navigate])

  // Text filter: type freely, the URL and the socket follow 250ms later.
  const [text, setText] = useState(search.q ?? '')
  const q = useDebounced(text, 250)
  useEffect(() => {
    if ((search.q ?? '') !== q) navigate({ search: (s) => ({ ...s, q: q || undefined }), replace: true })
  }, [q, search.q, navigate])

  const { lines, state, dropped, attempt, retryAt, retryNow } = useStream({ source, level, q: search.q })
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)

  // A new source starts fresh: nothing selected, following the live edge.
  const [shownSource, setShownSource] = useState(source)
  if (shownSource !== source) {
    setShownSource(source)
    setSelectedId(null)
    setFollow(true)
  }

  // A short "back online" note after a drop, nothing on first connect.
  const wasDown = useRef(false)
  useEffect(() => {
    if (state === 'reconnecting') wasDown.current = true
    if (state === 'live' && wasDown.current) {
      wasDown.current = false
      toast.success('Reconnected', { description: 'The stream is live again.' })
    }
  }, [state])

  const selectedIndex = selectedId == null ? -1 : lines.findIndex((l) => l.id === selectedId)
  const selected = selectedIndex >= 0 ? lines[selectedIndex] : null
  const move = (by: number) => {
    if (!lines.length) return
    const from = selectedIndex >= 0 ? selectedIndex : by > 0 ? -1 : lines.length
    const next = Math.min(lines.length - 1, Math.max(0, from + by))
    setFollow(false)
    setSelectedId(lines[next].id)
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const l of lines) {
      if (!l.level) continue
      const k = l.level === 'fatal' ? 'error' : l.level
      c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [lines])

  // Any line opens as a flow: by its id when it has one, else by itself (one node).
  const openFlow = (l: LogLine) =>
    l.display_id
      ? go({ to: '/flow/$id', params: { id: l.display_id.value }, search: { line: l.id } })
      : go({ to: '/line/$lineId', params: { lineId: l.id } })

  const live = liveState(state, !follow)
  useHotkeys({
    '/': () => filterRef.current?.focus(),
    j: () => move(direction === 'top' ? -1 : 1),
    k: () => move(direction === 'top' ? 1 : -1),
    space: () => state === 'live' && setFollow((f) => !f),
    g: (e) => e.shiftKey && setFollow(true),
    escape: () => setSelectedId(null),
    enter: () => selected && openFlow(selected),
  })

  const info = sources?.find((s) => s.name === source)
  const filtered = Boolean(level || search.q)
  // First run: nothing has sent a line yet.
  if (sources?.length === 0 && !source) return <Welcome />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        source={info}
        name={source}
        state={live}
        rate={source ? (rates[source] ?? null) : null}
        onTogglePause={() => setFollow((f) => !f)}
        onExport={source ? () => setExporting(true) : undefined}
      />
      <FilterBar
        text={text}
        onText={setText}
        level={level}
        onLevel={(l) =>
          navigate({ search: (s) => ({ ...s, level: l || (sourceDefault ? 'all' : undefined) }), replace: true })
        }
        counts={counts}
        inputRef={filterRef}
        direction={direction}
        onDirection={setDirection}
      />
      {state === 'reconnecting' && <ConnectionBanner attempt={attempt} retryAt={retryAt} onRetry={retryNow} />}
      {dropped > 0 && <GapBanner dropped={dropped} />}
      <div className="flex min-h-0 flex-1 gap-3 px-6 pb-3">
        <LogTable
          lines={lines}
          selectedId={selectedId}
          onSelect={(l) => setSelectedId(l.id)}
          follow={follow}
          onFollow={setFollow}
          direction={direction}
          emptyText={
            !source
              ? 'Waiting for the first source…'
              : filtered
                ? 'No lines match these filters yet.'
                : 'No lines yet. New lines appear here as they arrive.'
          }
        />
        {selected && (
          <FieldCard
            line={selected}
            position={{ index: selectedIndex, total: lines.length }}
            onClose={() => setSelectedId(null)}
            onPrev={() => move(-1)}
            onNext={() => move(1)}
            onOpenFlow={() => openFlow(selected)}
          />
        )}
      </div>
      <StreamFooter state={live} count={lines.length} direction={direction} />
      {source && exporting && (
        <ExportDialog
          open={exporting}
          onOpenChange={setExporting}
          title="Export lines"
          description="What you see in the stream: this source, these filters, this time range."
          params={{
            source,
            level: level || undefined,
            q: search.q,
            since: lines[0]?.ts ?? Date.now() - 15 * 60_000,
            until: Date.now(),
          }}
          summary={
            <>
              <div className="flex min-h-7 items-center gap-3 border-border/60 border-b py-1">
                <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">source</span>
                <span className="border px-1.5 font-mono text-xs">{source}</span>
                <span className="font-mono text-muted-foreground text-xs">{info?.kind}</span>
              </div>
              <div className="flex min-h-7 items-center gap-3 border-border/60 border-b py-1">
                <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">filters</span>
                <span className="truncate font-mono text-xs">
                  {[level && `level ≥${level}`, search.q && `“${search.q}”`].filter(Boolean).join(' · ') || 'none'}
                </span>
              </div>
            </>
          }
        />
      )}
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
