import { Callout, OBtn, PBtn } from '@/components/settings/storage/ui'
import type { FlowHistory, HistorySearchJob } from '@/gen'
import { fmtCount } from '@/lib/format'
import { fmtDays } from '@/lib/history-search'

const shown = (name: string) => (name === 'garage-local' ? 'Garage' : name)

/**
 * Related history in a flow (v1.1-23, 26): the flow may continue in retained
 * history that was not loaded. Searching it adds what it finds to the
 * activity list; a location that fails leaves the flow marked incomplete.
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
  const err = error && (
    <span role="alert" className="text-status-err">
      {' '}
      {error}
    </span>
  )
  if (job?.state === 'retrieving') {
    return (
      <Callout role="status" title="Searching retained history" action={<OBtn onClick={onCancel}>Cancel search</OBtn>}>
        Retrieving {job.done} of {job.total} {job.total === 1 ? 'hour' : 'hours'} of retained history for this flow’s
        ids.
      </Callout>
    )
  }
  if (job?.state === 'incomplete' && job.failures.length) {
    return (
      <Callout
        tone="warn"
        role="status"
        title="Related history is incomplete"
        action={<OBtn onClick={onStart}>Retry</OBtn>}
      >
        Some matching events could not be loaded from{' '}
        {[...new Set(job.failures.map((f) => shown(f.destination)))].join(', ')}. This flow may be missing logs or spans
        from {job.failures.map((f) => fmtDays(f.from, f.to)).join(', ')}.{err}
      </Callout>
    )
  }
  if (job?.state === 'cancelled') {
    return (
      <Callout
        role="status"
        title="Search cancelled · related history is incomplete"
        action={<OBtn onClick={onStart}>Run again</OBtn>}
      >
        {fmtCount(job.count)} related {job.count === 1 ? 'event was' : 'events were'} found before cancellation.
      </Callout>
    )
  }
  if (job) {
    return (
      <Callout
        role="status"
        title={
          job.count === 0
            ? 'No related events in retained history'
            : `${fmtCount(job.count)} related ${job.count === 1 ? 'event' : 'events'} from retained history added`
        }
      >
        Searched {fmtDays(history.since, history.until)} in retained history.
      </Callout>
    )
  }
  return (
    <Callout
      role="status"
      title="Related history unavailable"
      action={
        <PBtn onClick={onStart} disabled={starting}>
          {starting ? 'Starting…' : 'Search retained history'}
        </PBtn>
      }
    >
      {history.found
        ? 'Retained history holds this flow’s ids; they were not loaded with the recent window.'
        : `This flow may continue before ${fmtDays(history.until - 1, history.until)}, in retained history.`}
      {err}
    </Callout>
  )
}
