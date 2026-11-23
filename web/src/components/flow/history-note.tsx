import { ArchiveIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FlowHistory, HistorySearchJob } from '@/gen'
import { fmtCount } from '@/lib/format'
import { fmtDays } from '@/lib/history-search'

/**
 * "Related history unavailable" (Phase 5c): the flow may continue in
 * retained history that was not loaded. Searching it adds what it finds to
 * the activity list, tagged with where it came from.
 */
export function FlowHistoryNote({
  history,
  job,
  starting,
  error,
  onStart,
  onCancel,
}: {
  history: FlowHistory
  job: HistorySearchJob | null
  starting: boolean
  error: string | null
  onStart: () => void
  onCancel: () => void
}) {
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border bg-card px-3 py-2 font-mono text-muted-foreground text-xs"
    >
      <ArchiveIcon className="size-3.5 shrink-0" aria-hidden />
      {job?.state === 'retrieving' ? (
        <>
          <span className="flex items-center gap-1.5 text-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
            Retrieving {job.done} of {job.total} {job.total === 1 ? 'hour' : 'hours'} of retained history
          </span>
          <Button variant="outline" size="xs" onClick={onCancel}>
            <SquareIcon />
            Cancel
          </Button>
        </>
      ) : job ? (
        <span className={job.state === 'done' ? 'text-foreground' : 'text-status-warn'}>
          {job.count === 0
            ? `No related events in retained history (${fmtDays(history.since, history.until)})`
            : `${fmtCount(job.count)} related ${job.count === 1 ? 'event' : 'events'} from retained history added`}
          {job.state === 'cancelled' && ' · cancelled, partial'}
          {job.state === 'incomplete' &&
            ` · ${job.failures.map((f) => `${f.destination} not searched · ${fmtDays(f.from, f.to)}`).join(' · ')}`}
        </span>
      ) : (
        <>
          <span className="text-foreground">Related history unavailable</span>
          <span>
            ·{' '}
            {history.found
              ? 'retained history holds this flow’s ids'
              : `this flow may continue before ${fmtDays(history.until - 1, history.until)}`}
          </span>
          <Button size="xs" onClick={onStart} disabled={starting}>
            {starting && <LoaderCircleIcon className="animate-spin" />}
            Search retained history
          </Button>
        </>
      )}
      {error && (
        <span role="alert" className="text-status-err">
          {error}
        </span>
      )}
    </p>
  )
}
