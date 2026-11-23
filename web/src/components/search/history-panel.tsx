import { ArchiveIcon, FileDownIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HistoryCoverage, HistorySearchJob } from '@/gen'
import { fmtBytes, fmtCount } from '@/lib/format'
import { fmtDay, fmtDays, gapReasonText, historyExportUrl } from '@/lib/history-search'
import { cn } from '@/lib/utils'

/**
 * What retained history holds of a search range past the local window
 * (v1.1-19 … 23), and the job searching it: coverage per destination,
 * "No retained history before …", gaps, Search retained history, progress,
 * cancel, and the cancelled / incomplete states.
 */
export function HistoryPanel({
  coverage,
  job,
  starting,
  error,
  onStart,
  onCancel,
}: {
  coverage: HistoryCoverage
  job: HistorySearchJob | null
  starting: boolean
  error: string | null
  onStart: () => void
  onCancel: () => void
}) {
  const retrieving = job?.state === 'retrieving'
  const failed = new Set(job?.failures.map((f) => f.destination) ?? [])
  return (
    <section
      aria-label="Retained history"
      className="flex flex-col gap-2 border bg-card px-3 py-2.5 font-mono text-muted-foreground text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ArchiveIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium font-sans text-[13px] text-foreground">Retained history</span>
        <span>
          {fmtDays(coverage.from, coverage.to)} · {coverage.archived} of {coverage.hours}{' '}
          {coverage.hours === 1 ? 'hour' : 'hours'} archived
        </span>
        <span className="flex-1" />
        {retrieving ? (
          <>
            <span className="flex items-center gap-1.5 text-foreground" aria-live="polite">
              <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
              Retrieving {job.done} of {job.total} {job.total === 1 ? 'hour' : 'hours'} · {fmtBytes(job.bytes)}
            </span>
            <Button variant="outline" size="xs" onClick={onCancel}>
              <SquareIcon />
              Cancel
            </Button>
          </>
        ) : job ? (
          <>
            <span className={cn(job.state === 'done' ? 'text-foreground' : 'text-status-warn')} aria-live="polite">
              {job.state === 'cancelled'
                ? `Cancelled · ${fmtCount(job.count)} found in ${job.done} of ${job.total} hours kept`
                : job.state === 'incomplete'
                  ? `Incomplete · ${fmtCount(job.count)} found · ${job.done - job.failures.reduce((n, f) => n + f.hours, 0)} of ${job.total} hours searched`
                  : `${fmtCount(job.count)} ${job.count === 1 ? 'event' : 'events'} from retained history · ${job.total} hours searched`}
            </span>
            {job.count > 0 && (
              <Button variant="outline" size="xs" render={<a href={historyExportUrl(job.id, 'ndjson')} download />}>
                <FileDownIcon />
                Export
              </Button>
            )}
            {job.state !== 'done' && (
              <Button variant="outline" size="xs" onClick={onStart}>
                Search again
              </Button>
            )}
          </>
        ) : coverage.archived > 0 ? (
          <Button size="xs" onClick={onStart} disabled={starting}>
            {starting && <LoaderCircleIcon className="animate-spin" />}
            Search retained history
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1 pl-5.5">
        {coverage.destinations.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-2">
            <span className="text-foreground">{d.name}</span>
            {d.active && <span className="border px-1 text-[10px]">active</span>}
            {failed.has(d.name) ? (
              <span className="text-status-warn">
                {d.name} not searched
                {(() => {
                  const f = job?.failures.find((x) => x.destination === d.name)
                  return f ? ` · ${fmtDays(f.from, f.to)} · ${f.error}` : ''
                })()}
              </span>
            ) : d.first != null && d.last != null ? (
              <span>
                covers {fmtDays(d.first, d.last)} · {d.percent}%
              </span>
            ) : (
              <span>holds nothing in this range</span>
            )}
            <span aria-hidden className="relative h-1 w-20 bg-secondary">
              <span className="absolute inset-y-0 left-0 bg-brand/60" style={{ width: `${d.percent}%` }} />
            </span>
          </li>
        ))}
        {coverage.expired_before != null && <li>No retained history before {fmtDay(coverage.expired_before)}.</li>}
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
      </ul>
    </section>
  )
}
