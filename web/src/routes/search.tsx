import { getRouteApi } from '@tanstack/react-router'
import { ClockIcon, CornerDownLeftIcon, DownloadIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ExportDialog } from '@/components/export-dialog'
import { Histogram } from '@/components/search/histogram'
import { QueryInput } from '@/components/search/query-input'
import { SearchResults } from '@/components/search/results'
import { TimeRange } from '@/components/search/time-range'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { SearchParams } from '@/gen'
import { useHealth, useSources } from '@/lib/api'
import { useFlowSummaries } from '@/lib/flow-api'
import { fmtClock, fmtCount, fmtWindow } from '@/lib/format'
import { displayIds, groupByFlow, joinQuery, splitQuery, terms } from '@/lib/query'
import { useSearchLines } from '@/lib/search-api'
import { searchBounds } from '@/lib/search-params'
import { useHotkeys } from '@/lib/use-hotkeys'

const route = getRouteApi('/search')
const ALL = '__all__'

export function SearchPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const sources = useSources().data ?? []
  const retentionMs = useHealth().data?.retention_ms ?? 24 * 3_600_000
  const inputRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)

  // The input is edited freely; the URL (and the query) follow on Enter.
  const q = search.q ?? ''
  const { chips } = splitQuery(q)
  const [text, setText] = useState(() => splitQuery(q).text)
  const [shownQ, setShownQ] = useState(q)
  if (shownQ !== q) {
    setShownQ(q)
    setText(splitQuery(q).text)
  }
  const setQ = (next: string) => navigate({ search: (s) => ({ ...s, q: next || undefined }) })
  const submit = () => setQ(joinQuery(chips, text))
  const addChip = (c: string) => setQ(joinQuery([...chips.filter((x) => x !== c), c], text))
  const removeChip = (c: string) =>
    setQ(
      joinQuery(
        chips.filter((x) => x !== c),
        text,
      ),
    )

  // "Now" is pinned per search so the query key (and the page cursor) stay stable.
  const bounds = useMemo(() => searchBounds(search), [search])
  const params: SearchParams = {
    q: q || undefined,
    source: search.source,
    since: bounds.since,
    until: bounds.until,
    order: search.order,
  }
  const res = useSearchLines(params)
  const pages = res.data?.pages ?? []
  const first = pages[0]
  const lines = useMemo(() => pages.flatMap((p) => p.lines), [pages])
  // Group by flow: one summary per display id stitches groups across ids.
  const ids = useMemo(() => (search.view === 'flows' ? displayIds(lines) : []), [lines, search.view])
  const summaries = useFlowSummaries(ids)
  const flows = useMemo(() => groupByFlow(lines, summaries).length, [lines, summaries])
  const words = useMemo(() => terms(q), [q])
  const total = first?.total ?? lines.length

  useHotkeys({ '/': () => inputRef.current?.focus() })
  useEffect(() => {
    if (!q) inputRef.current?.focus()
  }, [q])

  const rangeLabel = search.from ? 'this range' : `the last ${search.range}`
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-8 pt-6 pb-4">
      <header>
        <h1 className="font-medium text-xl">Search</h1>
        <p className="text-muted-foreground">
          Last {fmtWindow(retentionMs)} across every source. Type anything, then click a value to narrow it.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <Select
          value={search.source ?? ALL}
          onValueChange={(v) => navigate({ search: (s) => ({ ...s, source: v === ALL ? undefined : String(v) }) })}
        >
          <SelectTrigger aria-label="Source" className="h-9 w-44">
            <SelectValue>{(v: string) => (v === ALL ? 'All sources' : v)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s.name} value={s.name}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <QueryInput
          chips={chips}
          text={text}
          onText={setText}
          onRemoveChip={removeChip}
          onSubmit={submit}
          inputRef={inputRef}
        />
        <TimeRange
          range={search.range}
          from={search.from}
          to={search.to}
          retentionMs={retentionMs}
          onRange={(range) => navigate({ search: (s) => ({ ...s, range, from: undefined, to: undefined }) })}
          onCustom={(from, to) => navigate({ search: (s) => ({ ...s, from, to }) })}
        />
        <Button className="h-9" onClick={submit}>
          Search
          <CornerDownLeftIcon className="size-3 opacity-60" />
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <p className="font-mono text-muted-foreground text-xs" aria-live="polite">
          <span className="font-medium font-sans text-foreground text-sm">
            {res.isPending
              ? 'Searching…'
              : search.view === 'flows'
                ? `${fmtCount(total)} ${total === 1 ? 'line' : 'lines'}${lines.length ? ` in ${flows}${res.hasNextPage ? '+' : ''} ${flows === 1 ? 'flow' : 'flows'}` : ''}`
                : `${fmtCount(total)} ${total === 1 ? 'line' : 'lines'}`}
          </span>
          {first &&
            ` · ${fmtClock(first.since)}–${fmtClock(first.until)} · searched ${fmtCount(first.searched)} lines in ${first.took_ms}ms`}
        </p>
        <span className="flex-1" />
        <ToggleGroup
          aria-label="View"
          value={[search.view]}
          onValueChange={(v: string[]) =>
            v[0] && navigate({ search: (s) => ({ ...s, view: v[0] as 'flows' | 'lines' }), replace: true })
          }
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="flows">Group by flow</ToggleGroupItem>
          <ToggleGroupItem value="lines">Lines</ToggleGroupItem>
        </ToggleGroup>
        <Select
          value={search.order}
          onValueChange={(v) => navigate({ search: (s) => ({ ...s, order: v as 'newest' | 'oldest' }), replace: true })}
        >
          <SelectTrigger aria-label="Order" size="sm" className="w-36">
            <SelectValue>{(v: string) => (v === 'oldest' ? 'Oldest first' : 'Newest first')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setExporting(true)} disabled={!total}>
          <DownloadIcon />
          Export
        </Button>
      </div>

      {first?.histogram && total > 0 && <Histogram buckets={first.histogram} since={first.since} until={first.until} />}

      {res.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-7" />
          <Skeleton className="h-7" />
        </div>
      ) : res.isError ? (
        <p role="alert" className="border border-status-err/30 bg-status-err/10 p-3 text-status-err">
          {res.error.message}
        </p>
      ) : lines.length === 0 ? (
        <div className="flex flex-1 items-start justify-center pt-24">
          <div className="flex max-w-md flex-col items-center gap-3 border border-dashed p-10 text-center">
            <span className="border p-1.5">
              <SearchIcon className="size-4 text-muted-foreground" />
            </span>
            <h2 className="font-medium">No lines match in {rangeLabel}</h2>
            <p className="text-muted-foreground">
              Nothing in {search.source ?? 'any source'}
              {q ? <> contains “{q}”</> : ' in this range'}. Try the whole {fmtWindow(retentionMs)} window, all sources,
              or fewer words.
            </p>
            {(search.range !== '24h' || search.from || search.source) && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  navigate({
                    search: (s) => ({ ...s, range: '24h', from: undefined, to: undefined, source: undefined }),
                  })
                }
              >
                <ClockIcon />
                Search last 24h, all sources
              </Button>
            )}
          </div>
        </div>
      ) : (
        <SearchResults
          lines={lines}
          view={search.view}
          words={words}
          hasMore={Boolean(res.hasNextPage)}
          loadingMore={res.isFetchingNextPage}
          onMore={() => res.fetchNextPage()}
          onPick={addChip}
          summaries={summaries}
        />
      )}

      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        title="Export search results"
        description="Exports the matching lines, not whole flows. Open a flow to export it."
        params={params}
        summary={
          <>
            <div className="flex min-h-7 items-center gap-3 border-border/60 border-b py-1">
              <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">query</span>
              <span className="truncate font-mono text-xs">{q || '(everything)'}</span>
            </div>
            <div className="flex min-h-7 items-center gap-3 border-border/60 border-b py-1">
              <span className="w-24 shrink-0 font-mono text-muted-foreground text-xs">sources</span>
              <span className="border px-1.5 font-mono text-xs">{search.source ?? 'all sources'}</span>
            </div>
          </>
        }
      />
    </div>
  )
}
