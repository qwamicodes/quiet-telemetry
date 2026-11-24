import { Link } from '@tanstack/react-router'
import { type Go, StorageFrame, useStorageNav } from '@/components/settings/storage/page'
import {
  Callout,
  Card,
  connectorName,
  connectorTag,
  fmtD,
  fmtDT,
  fmtDYT,
  fmtLimit,
  fmtRange,
  fmtSize,
  isLocalGarage,
  KIND_NAME,
  KIND_SHORT,
  Meter,
  OBtn,
  PBtn,
  Row,
  StatusLine,
  StorageHeader,
  Tag,
} from '@/components/settings/storage/ui'
import type { Destination, HistoryJob, HistoryStatus, StorageReport } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtAgo, fmtClock, fmtCount, fmtTime, fmtWindow } from '@/lib/format'
import { useHistory, useRetryCleanup, useVerifyDestination } from '@/lib/history-api'
import { useStorage } from '@/lib/settings-api'
import { toast } from '@/lib/toast'

// Settings → Storage → Overview (v1.1-01, 13, 14, 15, 16, 18).

const DAY = 86_400_000

/** `14,280`. */
const num = (n: number) => n.toLocaleString('en-US')

/** What waits on local disk: `143 MB · 14,280 events` (hours when the store can't tell). */
function waitingText(h: HistoryStatus): string {
  if (h.waiting_lines > 0) return `${fmtSize(h.waiting_bytes)} · ${num(h.waiting_lines)} events`
  return `${h.waiting_hours} ${h.waiting_hours === 1 ? 'hour' : 'hours'}`
}

/** `16 Nov, 09:42–10:42`. */
function fmtSpan(from: number, to: number): string {
  return fmtD(from) === fmtD(to) ? `${fmtDT(from)}–${fmtClock(to)}` : `${fmtDT(from)} – ${fmtDT(to)}`
}

type State = 'copying' | 'unavailable' | 'evicting' | 'stopped' | 'cleanup' | 'ok'

function stateOf(d: Destination, h: HistoryStatus, copy: HistoryJob | undefined): State {
  if (d.state === 'unavailable') return 'unavailable'
  if (d.at_capacity) return h.policy.at_capacity === 'stop' ? 'stopped' : 'evicting'
  if (d.cleanup_blocked_hours > 0 || d.cleanup_error) return 'cleanup'
  if (copy) return 'copying'
  return 'ok'
}

/** `30 days · remove oldest history`. */
export function policyLine(p: HistoryStatus['policy']): string {
  const age = p.retention_days == null ? 'Keep indefinitely' : `${p.retention_days} days`
  return `${age} · ${p.at_capacity === 'stop' ? 'stop adding history' : 'remove oldest history'}`
}

export function Overview() {
  const [, go] = useStorageNav()
  const history = useHistory().data
  const local = useStorage().data
  if (!history || !local)
    return (
      <StorageFrame header={<StorageHeader title="Storage" sub="Loading…" />} tab="overview">
        {null}
      </StorageFrame>
    )
  const active = history.destinations.find((d) => d.active) ?? null
  const copy = history.jobs.find((j) => j.kind === 'backfill' && (j.state === 'running' || j.state === 'blocked'))
  const state: State | 'none' = active ? stateOf(active, history, copy) : 'none'
  const sub =
    state === 'ok' || state === 'none'
      ? 'Recent events on this host. Longer history in your connected storage.'
      : state === 'copying' && active
        ? `${KIND_NAME[active.kind]} now receives new history.`
        : 'Monitor retained history and storage health.'
  return (
    <StorageFrame
      tab="overview"
      header={
        <StorageHeader
          title="Storage"
          sub={sub}
          action={<OBtn onClick={() => go({ tab: 'connectors' })}>Manage connectors</OBtn>}
        />
      }
    >
      {active ? (
        <ActiveOverview d={active} h={history} local={local} state={state as State} copy={copy} go={go} />
      ) : (
        <>
          <Callout
            title="No connected storage"
            action={<OBtn onClick={() => go({ tab: 'connectors', screen: 'add' })}>Add connector</OBtn>}
          >
            Quiet keeps the recent window on this host. Connect Garage or your own bucket to keep longer history.
          </Callout>
          <LocalCard local={local} active={null} go={go} />
        </>
      )}
    </StorageFrame>
  )
}

function ActiveOverview({
  d,
  h,
  local,
  state,
  copy,
  go,
}: {
  d: Destination
  h: HistoryStatus
  local: StorageReport
  state: State
  copy: HistoryJob | undefined
  go: Go
}) {
  const owner = isOwner(useMe())
  const verify = useVerifyDestination()
  const retryCleanup = useRetryCleanup()
  const now = local.now
  const limit = d.capacity_bytes
  const ratio = limit ? d.bytes_stored / limit : 0
  const others = h.destinations.filter((x) => !x.active && x.hours > 0)
  // The oldest event Quiet can search: archived anywhere, else local.
  const firsts = [...h.destinations.map((x) => x.first), local.oldest].filter((x): x is number => x != null)
  const available = firsts.length ? Math.min(...firsts) : null
  const retry = async () => {
    try {
      const v = await verify.mutateAsync(d.id)
      if (v.ok) toast.success(`${connectorName(d)} is reachable again`)
      else toast.error(`${connectorName(d)} is still unreachable`)
    } catch (err) {
      toast.error('Could not retry', { description: (err as Error).message })
    }
  }
  const limitLine = limit ? `of ${fmtLimit(limit)} history limit` : 'no history limit'

  const status = {
    ok: <StatusLine tone="ok">Up to date</StatusLine>,
    copying: <StatusLine tone="ok">Receiving new events</StatusLine>,
    unavailable: (
      <StatusLine tone="err">
        Retrying{d.next_retry != null && ` · next attempt in ${Math.max(1, Math.round((d.next_retry - now) / 1000))}s`}
      </StatusLine>
    ),
    evicting: <StatusLine tone="warn">Removing oldest history</StatusLine>,
    stopped: <StatusLine tone="err">History writes stopped</StatusLine>,
    cleanup: <StatusLine tone="warn">Cleanup needs attention</StatusLine>,
  }[state]
  const upload =
    state === 'stopped'
      ? `History stopped${d.last_upload ? ` · ${fmtClock(d.last_upload)}` : ''}`
      : d.last_upload == null
        ? 'No upload yet'
        : state === 'unavailable'
          ? `Last upload · ${fmtClock(d.last_upload)}`
          : `Last upload ${fmtAgo(d.last_upload, now)}`
  const footer =
    state === 'copying'
      ? 'History is filling from available local events.'
      : state === 'evicting' && d.first != null
        ? `Oldest available · ${fmtDT(d.first)} · ${Math.max(1, Math.round((now - d.first) / DAY))} days of history`
        : state === 'stopped' && d.last != null
          ? `Stored through · ${fmtDT(d.last_event ?? d.last + 3_600_000 - 1)}`
          : state === 'cleanup' && d.cleanup_blocked_bytes > 0
            ? `${fmtSize(Math.max(0, d.bytes_stored - d.cleanup_blocked_bytes))} retained · ${fmtSize(d.cleanup_blocked_bytes)} awaiting cleanup`
            : d.first != null
              ? state === 'ok'
                ? `Oldest event · ${fmtDYT(d.first)}`
                : `Oldest stored · ${fmtDT(d.first)}`
              : 'Nothing archived yet'

  return (
    <>
      {state === 'copying' && others.length > 0 && (
        <Callout title={`${connectorName(d)} is active`}>
          {others.map(connectorName).join(', ')} {others.length === 1 ? 'remains' : 'remain'} connected for older
          searches. {others.length === 1 ? 'Its' : 'Their'} stored history is not being migrated.
        </Callout>
      )}
      {state === 'unavailable' && (
        <Callout
          tone="err"
          role="alert"
          title="History uploads are delayed"
          action={
            owner && (
              <OBtn onClick={retry} disabled={verify.isPending}>
                Retry now
              </OBtn>
            )
          }
        >
          {connectorName(d)} has been unreachable
          {d.error ? ` (${d.error})` : ''}. Quiet is collecting locally and retrying this destination.
        </Callout>
      )}
      {state === 'evicting' && (
        <Callout
          tone="warn"
          role="status"
          title="History size limit reached"
          action={<OBtn onClick={() => go({ tab: 'policy' })}>Edit policy</OBtn>}
        >
          Quiet is removing the oldest history to make room for new arrivals.
          {h.policy.retention_days != null &&
            ` Available history is shorter than the ${h.policy.retention_days}-day setting.`}
        </Callout>
      )}
      {state === 'stopped' && (
        <Callout
          tone="err"
          role="alert"
          title="New history is not being stored"
          action={<OBtn onClick={() => go({ tab: 'policy' })}>Edit policy</OBtn>}
        >
          The {limit ? fmtLimit(limit) : 'size'} limit was reached
          {d.last_upload ? ` at ${fmtClock(d.last_upload)}` : ''}. Your policy keeps stored history and stops adding new
          history.
        </Callout>
      )}
      {state === 'cleanup' && (
        <Callout
          tone="warn"
          role="status"
          title="Some objects could not be removed"
          action={
            <OBtn onClick={() => document.getElementById('pending-cleanup')?.scrollIntoView({ behavior: 'smooth' })}>
              View details
            </OBtn>
          }
        >
          {d.cleanup_error ? 'The provider refused' : 'Cleanup is blocked'} in {connectorName(d)}. Expired events have
          left Search, but their objects remain in storage.
        </Callout>
      )}

      <Card
        title="Stored history"
        label="Stored history"
        aside={
          <>
            <Tag>{connectorTag(d)}</Tag>
            <Tag tone="ok">Active</Tag>
          </>
        }
      >
        <div className="flex items-start gap-3 p-4">
          <div className="flex flex-1 flex-col gap-1.5">
            <span className="font-medium font-mono text-2xl leading-7">{fmtSize(d.bytes_stored)}</span>
            <span className="font-mono text-muted-foreground text-xs leading-[18px]">{limitLine}</span>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            {status}
            <span className="font-mono text-muted-foreground text-xs leading-[18px]">{upload}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-4 pb-4">
          <Meter
            label="History used"
            ratio={ratio}
            tone={state === 'evicting' ? 'warn' : state === 'stopped' ? 'err' : undefined}
          />
          <div className="flex items-center gap-3 font-mono text-muted-foreground text-xs leading-[18px]">
            <span className="flex-1">{footer}</span>
            {state === 'ok' && limit != null && <span>{(ratio * 100).toFixed(1)}% used</span>}
          </div>
        </div>
        {state === 'ok' && (
          <div className="flex items-center gap-3 border-t px-4 py-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs leading-[18px]">{policyLine(h.policy)}</span>
              <span className="text-muted-foreground text-xs leading-[18px]">
                All sources · logs and traces · includes new sources automatically
              </span>
            </div>
            <OBtn onClick={() => go({ tab: 'policy' })}>Edit policy</OBtn>
          </div>
        )}
      </Card>

      {state === 'copying' && copy && <CopyCard job={copy} local={local} />}

      {state === 'unavailable' && (
        <>
          <Card
            title="Waiting to upload"
            aside={
              d.last_upload != null && (
                <span className="font-mono text-muted-foreground text-xs leading-[18px]">
                  {Math.max(1, Math.round((now - d.last_upload) / 60_000))} minutes behind
                </span>
              )
            }
          >
            <Row k="Pending data">{waitingText(h)}</Row>
            <Row k="Local headroom">
              {fmtSize(Math.max(0, local.settings.max_disk - local.used))} before the local disk cap
            </Row>
            {d.last_event != null && (
              <Row k="Last stored event">{`${fmtD(d.last_event)}, ${fmtTime(d.last_event).slice(0, 8)}`}</Row>
            )}
          </Card>
          <p className="text-muted-foreground text-xs leading-[18px]">
            Pending data is not yet retained in {KIND_SHORT[d.kind]}. Local eviction can create a history gap; Quiet
            will report affected times. No destination switch happens automatically.
          </p>
          <div className="flex justify-end gap-3">
            <OBtn onClick={() => go({ tab: 'connectors', screen: 'edit', id: d.id })}>Edit connection</OBtn>
            <OBtn onClick={() => go({ tab: 'connectors' })}>Choose another destination</OBtn>
          </div>
        </>
      )}

      {state === 'evicting' && (
        <>
          <Card
            title="Recent eviction"
            aside={<span className="font-mono text-muted-foreground text-xs">Remove oldest history</span>}
          >
            <div className="flex flex-col gap-3 p-4">
              <KVLine k="Oldest event now">{d.first != null ? fmtDYT(d.first) : '–'}</KVLine>
              {d.recent_eviction && (
                <KVLine k="Removed in last hour">
                  {fmtSize(d.recent_eviction.bytes)}
                  {d.recent_eviction.from != null &&
                    d.recent_eviction.to != null &&
                    ` · ${fmtSpan(d.recent_eviction.from, d.recent_eviction.to)}`}
                </KVLine>
              )}
              <p className="text-muted-foreground text-xs leading-[18px]">
                The size limit is taking effect before age-based retention. Events in the removed period are no longer
                searchable.
              </p>
            </div>
          </Card>
          <div className="flex justify-end gap-3">
            <OBtn render={<Link to="/search" />}>Search available history</OBtn>
            <OBtn onClick={() => go({ tab: 'connectors', screen: 'add' })}>Add external storage</OBtn>
          </div>
        </>
      )}

      {state === 'stopped' && (
        <>
          <Card title="History gap" aside={<Tag tone="warn">Open gap</Tag>}>
            <div className="flex flex-col gap-3 p-4">
              <KVLine k="Not stored since">{d.last != null ? fmtDYT(d.last + 3_600_000) : '–'}</KVLine>
              <KVLine k="Waiting locally">{waitingText(h)}</KVLine>
              <p className="text-muted-foreground text-xs leading-[18px]">
                New events remain available within the recent local window. They can expire there before history storage
                resumes.
              </p>
            </div>
          </Card>
          <div className="flex justify-end gap-3">
            <OBtn onClick={() => go({ tab: 'policy' })}>Increase size limit</OBtn>
            <OBtn onClick={() => go({ tab: 'policy' })}>Change eviction policy</OBtn>
          </div>
        </>
      )}

      {state === 'cleanup' && (
        <>
          <section id="pending-cleanup" className="scroll-mt-4">
            <Card
              title="Pending cleanup"
              aside={<span className="font-mono text-muted-foreground text-xs">{d.name}</span>}
            >
              <Row k="Affected history">
                {h.policy.retention_days != null
                  ? `Before ${fmtDYT(now - h.policy.retention_days * DAY)}`
                  : 'Hours removed by the size limit'}
              </Row>
              <Row k="Objects remaining">
                {fmtCount(d.cleanup_blocked_hours * 2)} objects ·{' '}
                {d.cleanup_blocked_bytes > 0
                  ? fmtSize(d.cleanup_blocked_bytes)
                  : `${d.cleanup_blocked_hours} ${d.cleanup_blocked_hours === 1 ? 'hour' : 'hours'}`}
              </Row>
              <Row k="Provider response">{d.cleanup_error ?? '–'}</Row>
              <Row k="Next action">
                {`Review the bucket lock in ${KIND_NAME[d.kind]}`}
                {d.cleanup_retry_at != null && ` · next retry ${fmtClock(d.cleanup_retry_at)}`}
              </Row>
            </Card>
          </section>
          <p className="text-muted-foreground text-xs leading-[18px]">
            Physical cleanup is separate from searchable retention. Quiet will retry removal when the provider allows
            it. Storage limits can still be reached while cleanup is blocked.
          </p>
          <div className="flex justify-end gap-3">
            <OBtn onClick={() => go({ tab: 'connectors', screen: 'details', id: d.id })}>Connection details</OBtn>
            {owner && (
              <PBtn
                disabled={retryCleanup.isPending}
                onClick={async () => {
                  try {
                    await retryCleanup.mutateAsync(d.id)
                    toast.success('Cleanup retried')
                  } catch (err) {
                    toast.error('Could not retry cleanup', { description: (err as Error).message })
                  }
                }}
              >
                Retry cleanup
              </PBtn>
            )}
          </div>
        </>
      )}

      {state === 'ok' && (
        <>
          {isLocalGarage(d) && (
            <Callout
              title="Local history"
              action={<OBtn onClick={() => go({ tab: 'connectors', screen: 'add' })}>Add connector</OBtn>}
            >
              Garage stores history on this host. Connect external storage to keep history off this server.
            </Callout>
          )}
          <LocalCard local={local} active={d} go={go} />
          {available != null && (
            <div className="flex items-center gap-3 pt-1">
              <div className="flex flex-1 flex-col gap-1.5">
                <span className="font-medium text-[13px] leading-[18px]">History available</span>
                <span className="font-mono text-muted-foreground text-xs leading-[18px]">
                  {fmtDYT(available)} — now
                </span>
              </div>
              <OBtn render={<Link to="/search" />}>Search history</OBtn>
            </div>
          )}
        </>
      )}

      {state === 'copying' &&
        others.map((o) => (
          <div key={o.id} className="flex items-center gap-3 pt-1">
            <div className="flex flex-1 flex-col gap-1.5">
              <span className="font-medium text-[13px] leading-[18px]">{connectorName(o)} · historical access</span>
              <span className="font-mono text-muted-foreground text-xs leading-[18px]">
                {fmtSize(o.bytes_stored)}
                {o.first != null && ` · ${fmtRange(o.first, o.last, now)}`}
              </span>
            </div>
            <OBtn render={<Link to="/search" />}>Search history</OBtn>
          </div>
        ))}
    </>
  )
}

function KVLine({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[180px] shrink-0 text-xs leading-[18px]">{k}</span>
      <span className="font-mono text-muted-foreground text-xs leading-[18px]">{children}</span>
    </div>
  )
}

/** v1.1-13: the local window being copied to a newly active destination. */
function CopyCard({ job, local }: { job: HistoryJob; local: StorageReport }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0
  return (
    <Card
      title="Copying recent local history"
      aside={<span className="font-mono text-muted-foreground text-xs">{pct}%</span>}
    >
      <div className="flex flex-col gap-2 p-4">
        <Meter label="Copied" ratio={job.total ? job.done / job.total : 0} />
        <div className="flex items-center gap-3 font-mono text-muted-foreground text-xs leading-[18px]">
          <span className="flex-1">
            {job.done} / {job.total} hours copied
            {job.bytes > 0 && ` · ${fmtSize(job.bytes)}`}
          </span>
          {job.state === 'blocked' && <span>Waiting for the destination</span>}
        </div>
        <p className="pt-1.5 text-muted-foreground text-xs leading-[18px]">
          Copying events from {local.oldest != null ? fmtDT(local.oldest) : 'the start of the local window'} onward.
          Newly arriving logs and traces are already being stored.
        </p>
      </div>
    </Card>
  )
}

/** Recent local data: the SQLite window on this host (v1.1-01). */
function LocalCard({ local, active, go }: { local: StorageReport; active: Destination | null; go: Go }) {
  const win = local.settings.retention_ms
  const label =
    win % 86_400_000 === 0 && win > 86_400_000 ? `${win / 86_400_000}-day` : `${Math.round(win / 3_600_000)}-hour`
  return (
    <Card
      title="Recent local data"
      aside={<span className="font-mono text-muted-foreground text-xs">Fast access · SQLite</span>}
    >
      <div className="flex items-center gap-3 p-4">
        <div className="flex flex-1 flex-col gap-1.5">
          <span className="font-mono text-xl leading-6">{fmtSize(local.used)}</span>
          <span className="font-mono text-muted-foreground text-xs leading-[18px]">
            of {fmtLimit(local.settings.max_disk)} local disk cap
          </span>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-xs leading-[18px]">{label} recent window</span>
          <span className="font-mono text-muted-foreground text-xs leading-[18px]">
            {local.oldest != null ? `Oldest · ${fmtDT(local.oldest)}` : `Window ${fmtWindow(win)} · nothing stored yet`}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t px-4 py-3">
        <span className="flex-1 text-muted-foreground text-xs leading-[18px]">
          {active
            ? `Local expiry does not remove history already uploaded to ${connectorName(active)}.`
            : 'Without connected storage, events leave Quiet when they expire locally.'}
        </span>
        <OBtn onClick={() => go({ screen: 'local' })}>Local settings</OBtn>
      </div>
    </Card>
  )
}
