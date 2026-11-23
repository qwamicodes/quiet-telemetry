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

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const dayStart = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime()

/** A custom-range field (05.2): `today 08:07`, `yesterday 22:10`, `Oct 22 14:07`. */
export function fmtRangeField(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000)
  if (days === 0) return `today ${hhmm(d)}`
  if (days === 1) return `yesterday ${hhmm(d)}`
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${hhmm(d)}`
}

/**
 * Reads what was typed: `now`, `today 08:07`, `yesterday 22:10`, `08:07`
 * (today), `2026-11-22 14:07`, `Oct 22 14:07`. `undefined` for now; `null`
 * when it can't be read.
 */
export function parseRangeField(text: string, now = Date.now()): number | undefined | null {
  const t = text.trim().toLowerCase()
  if (t === '' || t === 'now') return undefined
  const rel = /^(?:(today|yesterday)\s+)?(\d{1,2}):(\d{2})$/.exec(t)
  if (rel) {
    const d = new Date(now)
    if (rel[1] === 'yesterday') d.setDate(d.getDate() - 1)
    d.setHours(Number(rel[2]), Number(rel[3]), 0, 0)
    return Number(rel[2]) < 24 && Number(rel[3]) < 60 ? d.getTime() : null
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(t)
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5]).getTime()
  const md = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})$/.exec(t)
  if (md) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(md[1])
    if (month < 0) return null
    const d = new Date(now)
    const at = new Date(d.getFullYear(), month, +md[2], +md[3], +md[4]).getTime()
    // "Dec 31" typed in January means last year.
    return at > now ? new Date(d.getFullYear() - 1, month, +md[2], +md[3], +md[4]).getTime() : at
  }
  return null
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
  const [start, setStart] = useState(() => fmtRangeField(from ?? Date.now() - RANGE_MS[range]))
  const [end, setEnd] = useState(() => (to ? fmtRangeField(to) : 'now'))
  const a = parseRangeField(start)
  const b = parseRangeField(end)
  const bad = a == null || b === null || (b !== undefined && b <= a)
  const tzShort =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  // Enter in either field applies; there is no Apply button (05.2).
  const apply = () => {
    if (bad || a == null) return
    onCustom(a, b ?? undefined)
    setOpen(false)
  }
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
              type="text"
              aria-label="From"
              aria-invalid={a == null || undefined}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              className="h-8 min-w-0 flex-1 border bg-transparent px-2 font-mono text-xs outline-none focus:border-ring aria-invalid:border-status-err"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="text"
              aria-label="To"
              aria-invalid={b === null || (b !== undefined && a != null && b <= a) || undefined}
              value={end}
              placeholder="now"
              onChange={(e) => setEnd(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              className="h-8 min-w-0 flex-1 border bg-transparent px-2 font-mono text-xs outline-none focus:border-ring aria-invalid:border-status-err"
            />
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            Times in {tz}
            {tzShort ? ` (${tzShort})` : ''}. Events older than this source's {fmtWindow(retentionMs)} retention have
            expired.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
