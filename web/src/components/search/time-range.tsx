import { CheckIcon, ChevronDownIcon, ClockIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fmtWindow } from '@/lib/format'
import { RANGE_MS, RANGES, type Range } from '@/lib/search-params'

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
}: {
  range: Range
  from?: number
  to?: number
  retentionMs: number
  onRange: (r: Range) => void
  onCustom: (from: number, to: number | undefined) => void
}) {
  const [open, setOpen] = useState(false)
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
