import { getRouteApi } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FieldCard } from '@/components/field-card'
import { ConnectionBanner, GapBanner } from '@/components/stream/connection-banner'
import { FilterBar } from '@/components/stream/filter-bar'
import { LogTable } from '@/components/stream/log-table'
import { StreamFooter } from '@/components/stream/stream-footer'
import { liveState, TopBar } from '@/components/stream/top-bar'
import { useSources } from '@/lib/api'
import type { LevelFilter } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounced'
import { useHotkeys } from '@/lib/use-hotkeys'
import { useRates } from '@/lib/use-rates'
import { useStream } from '@/lib/use-stream'

const route = getRouteApi('/')

export function StreamPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const { data: sources } = useSources()
  const rates = useRates(sources)
  const source = search.source ?? null
  const level: LevelFilter = search.level ?? ''

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

  const live = liveState(state, !follow)
  useHotkeys({
    '/': () => filterRef.current?.focus(),
    j: () => move(1),
    k: () => move(-1),
    space: () => state === 'live' && setFollow((f) => !f),
    g: (e) => e.shiftKey && setFollow(true),
    escape: () => setSelectedId(null),
  })

  const info = sources?.find((s) => s.name === source)
  const filtered = Boolean(level || search.q)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        source={info}
        name={source}
        state={live}
        rate={source ? (rates[source] ?? null) : null}
        onTogglePause={() => setFollow((f) => !f)}
      />
      <FilterBar
        text={text}
        onText={setText}
        level={level}
        onLevel={(l) => navigate({ search: (s) => ({ ...s, level: l || undefined }), replace: true })}
        counts={counts}
        inputRef={filterRef}
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
          />
        )}
      </div>
      <StreamFooter state={live} count={lines.length} />
    </div>
  )
}
