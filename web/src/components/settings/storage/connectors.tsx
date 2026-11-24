import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ConnectForm } from '@/components/settings/storage/connect-form'
import { Crumbs, type Go, StorageFrame, useStorageNav } from '@/components/settings/storage/page'
import {
  Callout,
  Card,
  connectorName,
  DBtn,
  fmtDYT,
  fmtLimit,
  fmtRange,
  fmtSize,
  isLocalGarage,
  KIND_NAME,
  KIND_SHORT,
  KV,
  OBtn,
  PBtn,
  StatusLine,
  StorageHeader,
  Tag,
} from '@/components/settings/storage/ui'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { Destination, DestinationKind, HistoryStatus } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtAgo } from '@/lib/format'
import { useActivateDestination, useHistory, useRemoveDestination, useVerifyDestination } from '@/lib/history-api'
import { useStorage } from '@/lib/settings-api'
import { toast } from '@/lib/toast'

// Settings → Storage → Connectors (v1.1-02, 03, 09, 12, 17) and the connect
// flow (04–08, 25).

/** `30 days · 100 GB per connector · remove oldest`. */
function sharedPolicy(p: HistoryStatus['policy']): string {
  return [
    p.retention_days == null ? 'Keep indefinitely' : `${p.retention_days} days`,
    p.size_limit_bytes != null ? `${fmtLimit(p.size_limit_bytes)} per connector` : 'no size limit',
    p.at_capacity === 'stop' ? 'stop adding' : 'remove oldest',
  ].join(' · ')
}

/** `Local · default`, `Cloudflare R2`. */
const kindTag = (d: Destination) => (isLocalGarage(d) ? 'Local · default' : KIND_NAME[d.kind])

/** `quiet-history · this host`, `quiet-dr · eu-west-1 · quiet/`. */
function locationLine(d: Destination): string {
  if (isLocalGarage(d)) return `${d.bucket} · this host`
  return [d.bucket, d.kind === 'r2' || d.kind === 'garage' ? null : d.region || null, d.prefix]
    .filter(Boolean)
    .join(' · ')
}

export function Connectors() {
  const [search, go] = useStorageNav()
  const h = useHistory().data
  if (search.screen === 'add') return <AddConnector h={h} go={go} />
  if ((search.screen === 'connect' && search.kind) || (search.screen === 'edit' && search.id)) {
    const editing = search.screen === 'edit' ? h?.destinations.find((d) => d.id === search.id) : undefined
    if (search.screen === 'edit' && !editing) return <Loading />
    return <ConnectForm kind={editing?.kind ?? (search.kind as DestinationKind)} editing={editing} go={go} />
  }
  if (search.screen === 'details' && search.id) {
    const d = h?.destinations.find((x) => x.id === search.id)
    return d && h ? <Details d={d} h={h} go={go} /> : <Loading />
  }
  return <ConnectorList h={h} go={go} />
}

function Loading() {
  return (
    <StorageFrame tab="connectors" header={<StorageHeader title="Storage connectors" sub="Loading…" />}>
      {null}
    </StorageFrame>
  )
}

function ConnectorList({ h, go }: { h: HistoryStatus | undefined; go: Go }) {
  const owner = isOwner(useMe())
  const [activating, setActivating] = useState<Destination | null>(null)
  const [removing, setRemoving] = useState<Destination | null>(null)
  const now = Date.now()
  return (
    <StorageFrame
      tab="connectors"
      header={
        <StorageHeader
          title="Storage connectors"
          sub="Save multiple connections. One receives new history."
          action={owner && <OBtn onClick={() => go({ tab: 'connectors', screen: 'add' })}>Add connector</OBtn>}
        />
      }
    >
      {h && (
        <div className="flex items-center gap-3 pb-1">
          <span className="flex-1 text-xs leading-[18px]">Shared policy</span>
          <span className="font-mono text-muted-foreground text-xs leading-[18px]">{sharedPolicy(h.policy)}</span>
          <OBtn onClick={() => go({ tab: 'policy' })}>Edit policy</OBtn>
        </div>
      )}
      {h && h.destinations.length === 0 && (
        <Callout
          title="No connectors yet"
          action={owner && <OBtn onClick={() => go({ tab: 'connectors', screen: 'add' })}>Add connector</OBtn>}
        >
          Garage, Cloudflare R2, Amazon S3 or any S3-compatible bucket can keep history longer than this host does.
        </Callout>
      )}
      {h && h.destinations.length > 0 && (
        <ul aria-label="Connectors" className="flex flex-col border bg-card">
          {h.destinations.map((d) => {
            const historyOnly = !d.active && d.hours > 0
            const verified = d.last_verify?.ok
            return (
              <li key={d.id} className="border-b last:border-b-0">
                <div className="flex items-center gap-3 border-b p-4">
                  <div className="flex w-[356px] shrink-0 flex-col gap-1.5">
                    <span className="flex items-center gap-3">
                      <span className="font-medium text-[13px] leading-[18px]">{connectorName(d)}</span>
                      <Tag>{kindTag(d)}</Tag>
                    </span>
                    <span className="font-mono text-muted-foreground text-xs leading-[18px]">{locationLine(d)}</span>
                  </div>
                  <div className="flex w-[156px] shrink-0 flex-col gap-1.5">
                    {d.active ? (
                      <Tag tone="ok">Active</Tag>
                    ) : d.state === 'unavailable' ? (
                      <Tag tone="err">Unavailable</Tag>
                    ) : historyOnly ? (
                      <Tag>History only</Tag>
                    ) : verified ? (
                      <Tag>Ready</Tag>
                    ) : (
                      <Tag tone="warn">Not verified</Tag>
                    )}
                    <span className="font-mono text-muted-foreground text-xs leading-[18px]">
                      {d.hours > 0 ? fmtSize(d.bytes_stored) : 'No history'}
                    </span>
                  </div>
                  <div className="flex flex-1 items-center justify-end gap-3 self-start">
                    {d.active || historyOnly ? (
                      <OBtn onClick={() => go({ tab: 'connectors', screen: 'details', id: d.id })}>Details</OBtn>
                    ) : (
                      owner && (
                        <OBtn disabled={d.removing} onClick={() => setActivating(d)}>
                          Activate
                        </OBtn>
                      )
                    )}
                    {owner &&
                      (historyOnly ? (
                        <OBtn onClick={() => setRemoving(d)}>Remove</OBtn>
                      ) : (
                        <OBtn onClick={() => go({ tab: 'connectors', screen: 'edit', id: d.id })}>Edit</OBtn>
                      ))}
                  </div>
                </div>
                <div className="flex items-center gap-3 px-4 pt-3 pb-3 font-mono text-muted-foreground text-xs leading-[18px]">
                  <span className="flex-1">
                    {d.active
                      ? d.state === 'unavailable'
                        ? `Unreachable${d.error ? ` · ${d.error}` : ''}`
                        : d.last_upload != null
                          ? `Up to date · uploaded ${fmtAgo(d.last_upload, now)}`
                          : 'Active · nothing uploaded yet'
                      : d.removing
                        ? 'Deleting its history…'
                        : d.verified_at != null
                          ? `Connection verified · ${fmtAgo(d.verified_at, now)}`
                          : 'Connection not verified'}
                  </span>
                  <span>{d.first != null ? fmtRange(d.first, d.active ? null : d.last, now) : 'Not used yet'}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-muted-foreground text-xs leading-[18px]">
        Previously used connectors stay searchable while connected. Retention and eviction run on every connector.
      </p>
      {h && activating && <ActivateDialog d={activating} h={h} onClose={() => setActivating(null)} />}
      {h && removing && <RemoveDialog d={removing} h={h} onClose={() => setRemoving(null)} />}
    </StorageFrame>
  )
}

/** v1.1-03: choose a provider. */
function AddConnector({ h, go }: { h: HistoryStatus | undefined; go: Go }) {
  const garage = h?.destinations.find(isLocalGarage)
  const OPTIONS: { kind: DestinationKind; tag: string; text: string }[] = [
    {
      kind: 'garage',
      tag: 'Default',
      text: 'Local S3-compatible storage. Already configured with your Quiet installation.',
    },
    { kind: 'r2', tag: 'Object storage', text: 'Connect an existing R2 bucket with its S3 endpoint and access keys.' },
    { kind: 's3', tag: 'Object storage', text: 'Use your Quiet host’s AWS credentials or an access-key pair.' },
    {
      kind: 's3_compatible',
      tag: 'Custom endpoint',
      text: 'Connect another provider using its S3 endpoint, region and credentials.',
    },
  ]
  return (
    <StorageFrame
      tab="connectors"
      header={<StorageHeader title="Add storage connector" sub="Choose where Quiet keeps your logs and traces." />}
    >
      <Crumbs
        items={[
          { label: 'Storage', to: {} },
          { label: 'Connectors', to: { tab: 'connectors' } },
          { label: 'Add connector' },
        ]}
      />
      <ul aria-label="Storage providers" className="flex flex-col border bg-card">
        {OPTIONS.map((o) => (
          <li key={o.kind} className="flex items-center gap-3 border-b p-4 last:border-b-0">
            <div className="flex flex-1 flex-col gap-1.5">
              <span className="flex items-center gap-3">
                <span className="font-medium text-[13px] leading-[18px]">{KIND_NAME[o.kind]}</span>
                <Tag>{o.tag}</Tag>
              </span>
              <span className="text-muted-foreground text-xs leading-[18px]">
                {o.kind === 'garage' && !garage
                  ? 'Local S3-compatible storage next to Quiet. make up-history starts it and connects it.'
                  : o.text}
              </span>
            </div>
            {o.kind === 'garage' && garage ? (
              <OBtn onClick={() => go({ tab: 'connectors', screen: 'details', id: garage.id })}>View connection</OBtn>
            ) : (
              <OBtn onClick={() => go({ tab: 'connectors', screen: 'connect', kind: o.kind })}>Connect</OBtn>
            )}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs leading-[18px]">
        Your bucket stays yours. Quiet stores captured, redacted events and traces; adding a connection does not
        activate it.
      </p>
    </StorageFrame>
  )
}

/** v1.1-09: one connector's connection and status. */
function Details({ d, h, go }: { d: Destination; h: HistoryStatus; go: Go }) {
  const owner = isOwner(useMe())
  const verify = useVerifyDestination()
  const local = isLocalGarage(d)
  const test = async () => {
    try {
      const v = await verify.mutateAsync(d.id)
      if (v.ok && v.cleanup) toast.success(`${connectorName(d)}: 4 of 4 checks passed`)
      else
        toast.error(`${connectorName(d)}: connection test failed`, {
          description: v.steps.find((s) => !s.ok && !s.skipped)?.error ?? undefined,
        })
    } catch (err) {
      toast.error('Could not test the connection', { description: (err as Error).message })
    }
  }
  const status =
    d.state === 'unavailable' ? (
      <StatusLine tone="err">Unreachable</StatusLine>
    ) : d.at_capacity ? (
      <StatusLine tone="warn">At the size limit</StatusLine>
    ) : d.active ? (
      <StatusLine tone="ok">Up to date</StatusLine>
    ) : (
      <StatusLine tone="idle">{d.hours > 0 ? 'History only' : 'Ready'}</StatusLine>
    )
  return (
    <StorageFrame
      tab="connectors"
      header={
        <StorageHeader
          title={connectorName(d)}
          sub={
            local
              ? 'Default local history storage, configured with your installation.'
              : `${KIND_NAME[d.kind]} connection.`
          }
          action={
            owner && (
              <OBtn onClick={test} disabled={verify.isPending}>
                Test connection
              </OBtn>
            )
          }
        />
      }
    >
      <Card
        title={connectorName(d)}
        aside={
          <>
            {d.active && <Tag tone="ok">Active</Tag>}
            <Tag>{local ? 'Default' : KIND_NAME[d.kind]}</Tag>
          </>
        }
      >
        <DetailRow k="Location">{local ? 'This host' : KIND_NAME[d.kind]}</DetailRow>
        {d.endpoint && <DetailRow k="Endpoint">{d.endpoint}</DetailRow>}
        <DetailRow k="Region">{d.region || (d.kind === 'r2' ? 'auto' : 'us-east-1')}</DetailRow>
        <DetailRow k="Bucket">{d.bucket}</DetailRow>
        <DetailRow k="Object prefix">{d.prefix}</DetailRow>
        <DetailRow k="Credentials">
          {local
            ? 'Configured by installation · hidden'
            : d.access_key_preview
              ? `${d.access_key_preview} · secret hidden`
              : 'Host credentials'}
        </DetailRow>
      </Card>
      {local && (
        <Callout title="Local history stays on this host">
          Persistent storage keeps history across service restarts. A copy on this host does not protect against losing
          its disk or server.
        </Callout>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-[13px] leading-[18px]">Status</span>
        {status}
      </div>
      <div className="flex items-end gap-3">
        <div className="flex flex-1 flex-col gap-1.5 font-mono text-muted-foreground text-xs leading-[18px]">
          <span>{d.first != null ? `Oldest · ${fmtDYT(d.first)}` : 'Nothing stored here yet'}</span>
          <span>
            {fmtSize(d.bytes_stored)} stored
            {d.last_upload != null && ` · last upload ${fmtAgo(d.last_upload)}`}
          </span>
        </div>
        <OBtn render={<Link to="/search" />}>Search history</OBtn>
        {owner && <OBtn onClick={() => go({ tab: 'connectors', screen: 'edit', id: d.id })}>Advanced settings</OBtn>}
      </div>
      {!d.active && owner && (
        <div className="flex justify-end">
          <RemoveButton d={d} h={h} />
        </div>
      )}
    </StorageFrame>
  )
}

function DetailRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t px-4 py-3 first-of-type:border-t-0">
      <span className="w-[160px] shrink-0 text-xs leading-[18px]">{k}</span>
      <span className="min-w-0 break-all font-mono text-xs leading-[18px]">{children}</span>
    </div>
  )
}

export function RemoveButton({ d, h }: { d: Destination; h: HistoryStatus }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <OBtn onClick={() => setOpen(true)}>Remove connector</OBtn>
      {open && <RemoveDialog d={d} h={h} onClose={() => setOpen(false)} />}
    </>
  )
}

/** v1.1-12: switch where new history goes; the local window is copied. */
function ActivateDialog({ d, h, onClose }: { d: Destination; h: HistoryStatus; onClose: () => void }) {
  const activate = useActivateDestination()
  const local = useStorage().data
  const [, go] = useStorageNav()
  const current = h.destinations.find((x) => x.active)
  const hours = local ? Math.round(local.settings.retention_ms / 3_600_000) : null
  const run = async () => {
    try {
      await activate.mutateAsync(d.id)
      toast.success(`${connectorName(d)} is active`)
      onClose()
      go({})
    } catch (err) {
      toast.error(`Could not activate ${connectorName(d)}`, { description: (err as Error).message })
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="top-1/2 w-[520px] gap-5 p-6 sm:max-w-[520px]">
        <div className="flex flex-col gap-2">
          <DialogTitle className="font-semibold text-base leading-[22px] tracking-tight">
            Activate {connectorName(d)}?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs leading-[18px]">
            New logs and traces will be written to {KIND_NAME[d.kind]}.
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-4 border bg-card p-4">
          <KV k="Current destination" width="w-[172px]" muted>
            {current
              ? `${connectorName(current)} · ${isLocalGarage(current) ? 'this host' : KIND_SHORT[current.kind]}`
              : 'None'}
          </KV>
          <KV k="New destination" width="w-[172px]" muted>
            {connectorName(d)} · {isLocalGarage(d) ? 'this host' : KIND_SHORT[d.kind]}
          </KV>
        </div>
        <p className="text-xs leading-5">
          Quiet will copy the {hours ?? 'recent'} hours still available locally
          {local && ` (about ${fmtSize(local.used)})`} in the background. New arrivals are included immediately.
        </p>
        {current && current.hours > 0 && (
          <p className="text-muted-foreground text-xs leading-5">
            The {fmtSize(current.bytes_stored)} already in {connectorName(current)} stays searchable while connected. It
            is not migrated. The shared policy continues to run there.
          </p>
        )}
        <div className="flex justify-end gap-3">
          <OBtn onClick={onClose}>Cancel</OBtn>
          <PBtn onClick={run} disabled={activate.isPending}>
            Activate {KIND_SHORT[d.kind]}
          </PBtn>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** v1.1-17: disconnect a connector; its objects are left untouched. */
function RemoveDialog({ d, h, onClose }: { d: Destination; h: HistoryStatus; onClose: () => void }) {
  const remove = useRemoveDestination()
  const [, go] = useStorageNav()
  const active = h.destinations.find((x) => x.active && x.id !== d.id)
  const run = async () => {
    try {
      await remove.mutateAsync(d.id)
      toast.success(`${connectorName(d)} removed`, { description: 'Its objects were left in the bucket.' })
      onClose()
      go({ tab: 'connectors' })
    } catch (err) {
      toast.error(`Could not remove ${connectorName(d)}`, { description: (err as Error).message })
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="top-1/2 w-[520px] gap-5 p-6 sm:max-w-[520px]">
        <div className="flex flex-col gap-2">
          <DialogTitle className="font-semibold text-base leading-[22px] tracking-tight">
            Remove {connectorName(d)} from Quiet?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs leading-[18px]">
            This disconnects historical access. Objects in {connectorName(d)} will be left untouched.
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-3 border bg-card p-4">
          <span className="text-[13px] leading-[18px]">
            {fmtSize(d.bytes_stored)}
            {d.first != null && ` · ${fmtRange(d.first, d.last)}`}
          </span>
          <span className="text-muted-foreground text-xs leading-5">
            History available only in this connector will disappear from Quiet’s searches. Overlapping history in other
            connectors remains available.
          </span>
        </div>
        <p className="text-muted-foreground text-xs leading-5">
          Quiet will also stop running retention and eviction for this removed connection. Existing provider lifecycle
          rules can still apply.
        </p>
        {active && <p className="text-xs leading-5">{connectorName(active)} will remain the active destination.</p>}
        <div className="flex justify-end gap-3">
          <OBtn onClick={onClose}>Cancel</OBtn>
          <DBtn onClick={run} disabled={remove.isPending}>
            Remove connector
          </DBtn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
