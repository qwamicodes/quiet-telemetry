import { Link } from '@tanstack/react-router'
import { FileDownIcon } from 'lucide-react'
import { Callout, Card, Dot, Meter, OBtn, PBtn, Tag } from '@/components/settings/storage/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DestinationCoverage, HistoryCoverage, HistorySearchJob } from '@/gen'
import { fmtCount, fmtWindow } from '@/lib/format'
import { fmtDay, fmtDays, gapReasonText, historyExportUrl } from '@/lib/history-search'

// Retained history in Search (v1.1-19, 20, 21, 24, 27): what the range's
// history holds, the job searching it, and its incomplete / cancelled states.

/** `Garage` for the Garage quiet set up, else the connector's name. */
const shown = (name: string) => (name === 'garage-local' ? 'Garage' : name)

const range = (d: { first: number | null; last: number | null }) =>
  d.first != null && d.last != null ? fmtDays(d.first, d.last + 3_600_000) : '–'

/** The locations a history search reads: the local window, then each connector holding hours. */
function locations(c: HistoryCoverage): DestinationCoverage[] {
  return c.destinations.filter((d) => d.hours > 0)
}

export function HistoryPanel({
  coverage,
  job,
  starting,
  error,
  localWindowMs,
  onStart,
  onCancel,
}: {
  coverage: HistoryCoverage
  job: HistorySearchJob | null
  starting: boolean
  error: string | null
  /** The local window, for `Recent · 24h`. */
  localWindowMs: number
  onStart: () => void
  onCancel: () => void
}) {
  const held = locations(coverage)
  const failed = new Map((job?.failures ?? []).map((f) => [f.destination, f]))
  const first = held.map((d) => d.first).filter((x): x is number => x != null)
  const from = first.length ? Math.min(...first) : null
  const pct = job?.total ? Math.round((job.done / job.total) * 100) : 0
  const searching = held.filter((d) => !failed.has(d.name)).map((d) => shown(d.name))

  const notes = (
    <>
      {coverage.gaps.map((g) => (
        <li key={g.from}>
          Not retained {fmtDays(g.from, g.to)}: {gapReasonText(g.reason)}.
        </li>
      ))}
      {coverage.truncated && <li>Searches the newest 168 hours; narrow the range for older ones.</li>}
      {error && (
        <li role="alert" className="text-status-err">
          {error}
        </li>
      )}
    </>
  )

  if (job?.state === 'retrieving') {
    return (
      <section aria-label="Retained history" className="flex flex-col gap-5">
        <Callout title="Searching stored history" action={<OBtn onClick={onCancel}>Cancel search</OBtn>}>
          Recent local data {held.length > 1 ? 'is' : 'is'} ready. Quiet is still searching {searching.join(' and ')}{' '}
          for the selected dates.
        </Callout>
        <Card
          title="Retrieving matching events"
          aside={
            <span className="font-mono text-muted-foreground text-xs leading-[18px]" aria-live="polite">
              {job.done} of {job.total} hours
            </span>
          }
        >
          <div className="flex flex-col gap-2 p-4">
            <Meter label="Hours searched" ratio={job.total ? job.done / job.total : 0} />
            <div className="flex items-center gap-3 font-mono text-muted-foreground text-xs leading-[18px]">
              <span className="flex-1">
                {searching.join(', ') || 'Retained history'} · {job.done} of {job.total} hours searched
              </span>
              <span>{pct}%</span>
            </div>
          </div>
          <LocationRow name="Recent local data" detail={`Last ${fmtWindow(localWindowMs)} · complete`} tone="ok" />
          {held.map((d) => (
            <LocationRow key={d.id} name={shown(d.name)} detail={`${range(d)} · searching`} tone="warn" />
          ))}
        </Card>
      </section>
    )
  }

  if (job?.state === 'incomplete' && job.failures.length) {
    const f = job.failures[0]
    const ok = ['recent local data', ...held.filter((d) => !failed.has(d.name)).map((d) => shown(d.name))]
    return (
      <section aria-label="Retained history" className="flex flex-col gap-3">
        <Callout
          tone="warn"
          role="status"
          title="Results are incomplete"
          action={<OBtn onClick={onStart}>Retry {shown(f.destination)}</OBtn>}
        >
          {job.failures
            .map((x) => `${shown(x.destination)} could not be searched for ${fmtDays(x.from, x.to)}`)
            .join('. ')}
          . Results below cover {ok.join(' and ')} only.
        </Callout>
        <ul className="font-mono text-muted-foreground text-xs leading-[18px] empty:hidden">{notes}</ul>
      </section>
    )
  }

  if (job?.state === 'cancelled') {
    return (
      <section aria-label="Retained history" className="flex flex-col gap-3">
        <Callout title="Search cancelled · results are incomplete" action={<OBtn onClick={onStart}>Run again</OBtn>}>
          {searching.join(' and ') || 'Retained history'} was only partly searched. Results found before cancellation
          are kept below.
        </Callout>
        <div className="flex items-center gap-3">
          <span className="flex-1 font-medium text-[13px] leading-[18px]">
            {fmtCount(job.count)} {job.count === 1 ? 'match' : 'matches'} found before cancellation
          </span>
          <Tag tone="warn">Search cancelled</Tag>
        </div>
        <p className="text-muted-foreground text-xs leading-[18px]">
          Run the search again to complete the selected date range. These results cover only the locations and times
          searched before cancellation.
        </p>
      </section>
    )
  }

  // Not started, or done: the coverage bar (v1.1-19).
  return (
    <section aria-label="Retained history" className="flex flex-col gap-2">
      <div className="flex min-h-11 flex-wrap items-center gap-3 border bg-card px-4 py-2">
        <Dot tone={held.length ? 'ok' : 'idle'} />
        <span className="text-[13px] leading-[18px]">
          {from != null ? `History available · ${fmtDay(from)} — now` : 'No retained history in this range'}
          {job?.state === 'done' &&
            ` · ${fmtCount(job.count)} ${job.count === 1 ? 'event' : 'events'} from retained history`}
        </span>
        <span className="flex-1" />
        <Tag>Recent · {fmtWindow(localWindowMs)}</Tag>
        {held.map((d) => (
          <Tag key={d.id}>
            {shown(d.name)} · {d.active ? 'active' : 'history'}
          </Tag>
        ))}
        {!job && held.length > 0 && !coverage.auto && (
          <PBtn onClick={onStart} disabled={starting}>
            {starting ? 'Starting…' : 'Search retained history'}
          </PBtn>
        )}
        {job?.state === 'done' && job.count > 0 && (
          <OBtn render={<a href={historyExportUrl(job.id, 'ndjson')} download />}>
            <FileDownIcon />
            Export
          </OBtn>
        )}
      </div>
      {(coverage.gaps.length > 0 || coverage.truncated || error || coverage.expired_before != null) && (
        <ul className="font-mono text-muted-foreground text-xs leading-[18px]">
          {coverage.expired_before != null && <li>No retained history before {fmtDay(coverage.expired_before)}.</li>}
          {notes}
        </ul>
      )}
    </section>
  )
}

/**
 * Next to the result count (v1.1-20, 21): the job's progress, and for an
 * incomplete one how many locations answered, with View coverage listing
 * each location and what happened there.
 */
export function CoverageStatus({
  coverage,
  job,
  localWindowMs,
}: {
  coverage: HistoryCoverage
  job: HistorySearchJob | null
  localWindowMs: number
}) {
  if (job?.state === 'retrieving') return <Tag tone="warn">Search in progress</Tag>
  if (job?.state !== 'incomplete' || !job.failures.length) return null
  const held = locations(coverage)
  const failed = new Map(job.failures.map((f) => [f.destination, f]))
  return (
    <>
      <Tag tone="warn">
        {held.length + 1 - failed.size} of {held.length + 1} locations searched
      </Tag>
      <Popover>
        <PopoverTrigger render={<OBtn />}>View coverage</PopoverTrigger>
        <PopoverContent align="end" className="w-[420px] gap-0 p-0">
          <p className="border-b px-4 py-3 font-medium text-[13px] leading-[18px]">Searched locations</p>
          <ul aria-label="Coverage">
            <CoverageRow name="Recent local data" detail={`Last ${fmtWindow(localWindowMs)} · searched`} tone="ok" />
            {held.map((d) => {
              const f = failed.get(d.name)
              return (
                <CoverageRow
                  key={d.id}
                  name={shown(d.name)}
                  detail={f ? `${fmtDays(f.from, f.to)} · not searched · ${f.error}` : `${range(d)} · searched`}
                  tone={f ? 'err' : 'ok'}
                />
              )
            })}
            {coverage.gaps.map((g) => (
              <CoverageRow
                key={g.from}
                name="Not retained"
                detail={`${fmtDays(g.from, g.to)} · ${gapReasonText(g.reason)}`}
                tone="idle"
              />
            ))}
            {coverage.expired_before != null && (
              <CoverageRow
                name="Expired"
                detail={`Before ${fmtDay(coverage.expired_before)} · no retained history`}
                tone="idle"
              />
            )}
          </ul>
        </PopoverContent>
      </Popover>
    </>
  )
}

function CoverageRow({ name, detail, tone }: { name: string; detail: string; tone: 'ok' | 'err' | 'idle' }) {
  return (
    <li className="flex items-start gap-3 border-t px-4 py-2.5 first:border-t-0">
      <span className="flex h-[18px] items-center">
        <Dot tone={tone} />
      </span>
      <span className="w-32 shrink-0 text-xs leading-[18px]">{name}</span>
      <span className="min-w-0 break-words font-mono text-muted-foreground text-xs leading-[18px]">{detail}</span>
    </li>
  )
}

/** Under the results (v1.1-20, 21): what a partial answer means. */
export function CoverageFootnote({ job }: { job: HistorySearchJob | null }) {
  const text =
    job?.state === 'retrieving'
      ? 'Results update as each location finishes. Cancelling keeps the results found so far and marks them incomplete.'
      : job?.state === 'incomplete' && job.failures.length
        ? 'A failed location is not the same as no matches. Older related events may be missing from this flow.'
        : null
  return text ? <p className="shrink-0 text-muted-foreground text-xs leading-[18px]">{text}</p> : null
}

function LocationRow({ name, detail, tone }: { name: string; detail: string; tone: 'ok' | 'warn' | 'err' }) {
  return (
    <div className="flex items-center gap-3 border-t px-4 py-3">
      <Dot tone={tone} />
      <span className="w-[200px] shrink-0 text-xs leading-[18px]">{name}</span>
      <span className="font-mono text-muted-foreground text-xs leading-[18px]">{detail}</span>
    </div>
  )
}

/** v1.1-24: a range wholly before the oldest retained event. */
export function OutsideHistory({ since, until, earliest }: { since: number; until: number; earliest: number | null }) {
  return (
    <section aria-label="Outside available history" className="flex flex-col gap-5">
      <div className="flex min-h-11 items-center gap-3 border bg-card px-4 py-2">
        <span className="flex-1 font-mono text-muted-foreground text-xs leading-[18px]">
          Selected · {fmtDays(since, until)}
        </span>
        <Tag tone="warn">Outside available history</Tag>
      </div>
      <div className="flex flex-col gap-4 border bg-card px-8 py-12">
        <h2 className="font-semibold text-xl leading-6 tracking-tight">This time range has no retained history</h2>
        <p className="text-[13px] text-muted-foreground leading-5">
          {earliest != null
            ? `The earliest available event is ${new Date(earliest).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}. `
            : ''}
          Earlier data was not retained or has expired.
        </p>
        <div className="flex gap-3">
          <PBtn render={<Link to="/search" search={(s) => ({ ...s, from: undefined, to: undefined, range: '7d' })} />}>
            Search available history
          </PBtn>
          <OBtn render={<Link to="/settings/storage" />}>Storage settings</OBtn>
        </div>
      </div>
      <p className="text-muted-foreground text-xs leading-[18px]">
        Increasing retention only preserves data that is still available. It cannot restore expired or evicted history.
      </p>
    </section>
  )
}
