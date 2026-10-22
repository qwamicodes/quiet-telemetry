import { useQuery } from '@tanstack/react-query'
import { CheckIcon, ChevronDownIcon, ClockIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Bucket } from '@/gen'
import { fetchJson } from '@/lib/api'
import { fmtClock, fmtWindow } from '@/lib/format'
import { searchResponse } from '@/lib/schemas'
import { toQuery } from '@/lib/search-api'
import { RANGE_MS, RANGES, type Range } from '@/lib/search-params'
import { cn } from '@/lib/utils'

const BARS = 48

/** The whole window as a mini histogram; drag across it to pick a range (design 05.2). */
export function WindowBrush({
  buckets,
  since,
  until,
  from,
  to,
  onPick,
}: {
  buckets: Bucket[]
  since: number
  until: number
  /** The range shown now (highlighted). */
  from: number
  to: number
  onPick: (from: number, to: number | undefined) => void
}) {
  const [drag, setDrag] = useState<[number, number] | null>(null)
  const width = (until - since) / Math.max(1, buckets.length)
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const inRange = (i: number) => {
    if (drag) return i >= Math.min(...drag) && i <= Math.max(...drag)
    const start = since + i * width
    return start + width > from && start < to
  }
  const finish = () => {
    if (!drag) return
    const [a, b] = [Math.min(...drag), Math.max(...drag)]
    setDrag(null)
    onPick(since + a * width, b === buckets.length - 1 ? undefined : since + (b + 1) * width)
  }
  const day = until - since <= 86_400_000
  return (
    <figure aria-label="Lines in the window" className="flex flex-col gap-1">
      <div
        className="flex h-9 cursor-crosshair touch-none select-none items-end gap-px"
        onPointerUp={finish}
        onPointerLeave={finish}
      >
        {buckets.map((b, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position buckets
            key={i}
            data-testid="brush-bar"
            data-on={inRange(i) || undefined}
            title={`${fmtClock(since + i * width)} · ${b.count.toLocaleString()} lines`}
            onPointerDown={(e) => {
              e.preventDefault()
              setDrag([i, i])
            }}
            onPointerEnter={() => drag && setDrag([drag[0], i])}
            className={cn('flex h-full flex-1 items-end', inRange(i) && 'bg-brand/15')}
          >
            <span
              className={cn('w-full', inRange(i) ? 'bg-brand' : 'bg-muted-foreground/35')}
              style={{ height: `${b.count ? Math.max(8, (b.count / max) * 100) : 4}%` }}
            />
          </span>
        ))}
      </div>
      <figcaption className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>
          {day ? 'yesterday ' : ''}
          {fmtClock(since)}
        </span>
        <span>now</span>
      </figcaption>
    </figure>
  )
}

const LABEL: Record<Range, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last 1 hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '3d': 'Last 3 days',
  '7d': 'Last 7 days',
}

/** `datetime-local` value for a unix ms, in the viewer's zone. */
function local(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

export function TimeRange({
  range,
  from,
  to,
  retentionMs,
  onRange,
  onCustom,
  q,
  source,
}: {
  range: Range
  from?: number
  to?: number
  retentionMs: number
  onRange: (r: Range) => void
  onCustom: (from: number, to: number | undefined) => void
  /** The current search, so the window histogram counts what it matches. */
  q?: string
  source?: string
}) {
  const [open, setOpen] = useState(false)
  // Whole window, counted when the picker opens (rounded to the minute for the cache).
  const windowUntil = Math.ceil(Date.now() / 60_000) * 60_000
  const windowSince = windowUntil - retentionMs
  const hist = useQuery({
    queryKey: ['window-histogram', q, source, windowUntil, retentionMs],
    enabled: open,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchJson(
        `/api/search?${toQuery({ q: q || undefined, source, since: windowSince, until: windowUntil, limit: 1, buckets: BARS })}`,
        searchResponse,
        { signal },
      ),
  })
  const ranges = RANGES.filter((r) => RANGE_MS[r] <= retentionMs)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [start, setStart] = useState(() => local(from ?? Date.now() - RANGE_MS[range]))
  const [end, setEnd] = useState(() => (to ? local(to) : ''))
  const label = from ? 'Custom' : `Last ${range}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" className="h-9 font-normal" />}>
        <ClockIcon />
        {label}
        <ChevronDownIcon className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="flex flex-col p-1" role="listbox" aria-label="Time range">
          {ranges.map((r) => {
            const on = !from && r === range
            return (
              <button
                key={r}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => {
                  onRange(r)
                  setOpen(false)
                }}
                className="flex h-8 items-center gap-2 px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent aria-selected:bg-accent"
              >
                <CheckIcon className={on ? 'size-3.5' : 'size-3.5 opacity-0'} />
                <span className="flex-1">{LABEL[r]}</span>
                <span className="font-mono text-muted-foreground text-xs">
                  {r}
                  {RANGE_MS[r] === retentionMs ? ' · whole window' : ''}
                </span>
              </button>
            )
          })}
        </div>
        <div className="border-t p-3">
          <p className="mb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            {fmtWindow(retentionMs)} window
          </p>
          {hist.data?.histogram ? (
            <WindowBrush
              buckets={hist.data.histogram}
              since={hist.data.since}
              until={hist.data.until}
              from={from ?? Date.now() - RANGE_MS[range]}
              to={to ?? Date.now()}
              onPick={(a, b) => {
                onCustom(Math.round(a), b && Math.round(b))
                setOpen(false)
              }}
            />
          ) : (
            <div className="h-[52px] animate-pulse bg-muted/40" />
          )}
        </div>
        <div className="border-t p-3">
          <p className="mb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">Custom range</p>
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              aria-label="From"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="h-8 min-w-0 flex-1 border bg-transparent px-2 font-mono text-xs outline-none focus:border-ring"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="datetime-local"
              aria-label="To"
              value={end}
              placeholder="now"
              onChange={(e) => setEnd(e.target.value)}
              className="h-8 min-w-0 flex-1 border bg-transparent px-2 font-mono text-xs outline-none focus:border-ring"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 w-full"
            disabled={!start}
            onClick={() => {
              onCustom(new Date(start).getTime(), end ? new Date(end).getTime() : undefined)
              setOpen(false)
            }}
          >
            Apply
          </Button>
          <p className="mt-2 text-muted-foreground text-xs">
            Times in {tz}. Lines older than {fmtWindow(retentionMs)} have expired.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
