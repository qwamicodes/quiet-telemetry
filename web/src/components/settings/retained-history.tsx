import { CheckIcon, CloudIcon, PlusIcon, XIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Caps, Panel } from '@/components/settings/kit'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Destination, DestinationKind, VerifyResult } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtAgo, fmtBytes, fmtCount, fmtDay } from '@/lib/format'
import {
  GAP_LABEL,
  KIND_HINT,
  KIND_LABEL,
  useActivateDestination,
  useCreateDestination,
  useHistory,
  useRemoveDestination,
  useVerifyDestination,
} from '@/lib/history-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

// Settings → Storage → Retained history (v0.1.1 Phase 5a). Screens follow
// docs/v0.1.1-storage-design.md; compare with the "v1.1 storage & retention"
// boards once Paper is open.

const KINDS: DestinationKind[] = ['garage', 'r2', 's3', 's3_compatible']
const STEP_LABEL = { write: 'Write', read: 'Read', list: 'List', delete: 'Delete' } as const

/** `Write ✓ · Read ✓ · List ✓ · Delete ✗ AccessDenied`. */
export function VerifySteps({ v }: { v: VerifyResult }) {
  return (
    <ul aria-label="Verify results" className="flex flex-col gap-1 font-mono text-xs">
      {v.steps.map((s) => (
        <li key={s.step} className="flex items-start gap-2">
          {s.ok ? (
            <CheckIcon aria-label="passed" className="mt-0.5 size-3.5 shrink-0 text-status-ok" />
          ) : (
            <XIcon aria-label="failed" className="mt-0.5 size-3.5 shrink-0 text-status-err" />
          )}
          <span className="w-12 shrink-0">{STEP_LABEL[s.step]}</span>
          {s.error && <span className="min-w-0 break-words text-muted-foreground">{s.error}</span>}
        </li>
      ))}
      {v.ok && !v.cleanup && (
        <li className="pt-1 font-sans text-status-warn">
          quiet can't delete here, so history retention won't be able to remove old hours (cleanup blocked).
        </li>
      )}
    </ul>
  )
}

function span(d: Destination): string {
  if (d.hours === 0 || d.first == null || d.last == null) return 'nothing archived yet'
  const first = fmtDay(d.first)
  const last = fmtDay(d.last)
  return `${first === last ? first : `${first} – ${last}`} · ${d.hours} h · ${fmtCount(d.lines)} lines · ${fmtBytes(d.bytes_stored)}`
}

function DestinationRow({ d, owner }: { d: Destination; owner: boolean }) {
  const verify = useVerifyDestination()
  const activate = useActivateDestination()
  const remove = useRemoveDestination()
  const [removing, setRemoving] = useState(false)
  const [checked, setChecked] = useState<VerifyResult | null>(null)
  const tone = d.state === 'ok' ? 'ok' : d.state === 'unavailable' ? 'warn' : 'idle'
  const run = async (what: 'verify' | 'activate') => {
    try {
      if (what === 'verify') {
        const v = await verify.mutateAsync(d.id)
        setChecked(v)
        if (v.ok) toast.success(`${d.name} verified`)
        else toast.error(`${d.name} failed Verify`)
      } else {
        await activate.mutateAsync(d.id)
        toast.success(`New hours now go to ${d.name}`, {
          description: 'Hours already archived elsewhere stay searchable there.',
        })
      }
    } catch (err) {
      toast.error(what === 'verify' ? 'Verify failed' : 'Could not make it active', {
        description: (err as Error).message,
      })
    }
  }
  return (
    <li className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <StatusDot status={tone} />
        <span className="font-medium">{d.name}</span>
        <span className="font-mono text-muted-foreground text-xs">{KIND_LABEL[d.kind]}</span>
        {d.active ? (
          <span className="border border-brand/40 bg-brand/10 px-1.5 font-mono text-[11px] text-brand">active</span>
        ) : (
          <span className="border px-1.5 font-mono text-[11px] text-muted-foreground">read only</span>
        )}
        <span className="flex-1" />
        {owner && (
          <span className="flex items-center gap-1.5">
            <Button variant="outline" size="xs" disabled={verify.isPending} onClick={() => run('verify')}>
              Verify
            </Button>
            {!d.active && (
              <>
                <Button variant="outline" size="xs" disabled={activate.isPending} onClick={() => run('activate')}>
                  Make active
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              </>
            )}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pl-5 font-mono text-muted-foreground text-xs">
        <span>
          {d.bucket}/{d.prefix}
        </span>
        <span>{span(d)}</span>
        <span>
          key {d.access_key_preview}
          {d.verified_at ? ` · verified ${fmtAgo(d.verified_at)}` : ' · not verified'}
        </span>
      </div>
      {d.state === 'unavailable' && (
        <p className="ml-5 border border-status-warn/40 bg-status-warn/5 px-3 py-2 text-xs">
          Unreachable: {d.error}
          {d.next_retry &&
            ` · retrying ${d.next_retry <= Date.now() ? 'now' : `in ${Math.ceil((d.next_retry - Date.now()) / 1000)}s`}`}
          . Hours wait on local disk until it's back.
        </p>
      )}
      {checked && (
        <div className="ml-5">
          <VerifySteps v={checked} />
        </div>
      )}
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {d.name}?</DialogTitle>
            <DialogDescription>
              quiet forgets this connection and stops searching its {d.hours} archived hour{d.hours === 1 ? '' : 's'}.
              The objects stay in {d.bucket}; connect it again to bring them back.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync(d.id)
                  setRemoving(false)
                  toast.success(`Removed ${d.name}`, { description: `Its history stays in ${d.bucket}.` })
                } catch (err) {
                  toast.error('Could not remove it', { description: (err as Error).message })
                }
              }}
            >
              Remove, keep its data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}

const DEFAULT_NAME: Record<DestinationKind, string> = {
  garage: 'garage-local',
  r2: 'r2-history',
  s3: 's3-history',
  s3_compatible: 'history',
}

function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="font-medium text-xs">{label}</span>
      <Input id={id} {...input} />
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** Connect storage: kind, fields, Save and verify → per-step results → Make active. */
export function ConnectStorage({
  open,
  onOpenChange,
  first,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** No destination yet: offer to make it active straight away. */
  first: boolean
}) {
  const create = useCreateDestination()
  const activate = useActivateDestination()
  const [kind, setKind] = useState<DestinationKind>('garage')
  const [name, setName] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [region, setRegion] = useState('')
  const [bucket, setBucket] = useState('quiet-history')
  const [prefix, setPrefix] = useState('')
  const [pathStyle, setPathStyle] = useState<boolean | null>(null)
  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [result, setResult] = useState<{ id: number; name: string; v: VerifyResult } | null>(null)
  const hint = KIND_HINT[kind]
  const finalName = name ?? DEFAULT_NAME[kind]
  const finalPath = pathStyle ?? hint.pathStyle
  const reset = () => {
    setResult(null)
    setSecret('')
  }
  const close = (o: boolean) => {
    if (!o) reset()
    onOpenChange(o)
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const r = await create.mutateAsync({
        name: finalName,
        kind,
        endpoint: endpoint.trim() || undefined,
        region: region.trim() || undefined,
        bucket: bucket.trim(),
        prefix: prefix.trim() || undefined,
        path_style: finalPath,
        access_key_id: keyId.trim(),
        secret_access_key: secret,
        activate: false,
      })
      setResult({ id: r.destination.id, name: r.destination.name, v: r.verify })
      setSecret('')
    } catch (err) {
      toast.error('Could not save it', { description: (err as Error).message })
    }
  }
  const makeActive = async () => {
    if (!result) return
    try {
      await activate.mutateAsync(result.id)
      toast.success(`Retained history on: ${result.name}`, {
        description: 'Hours that leave the local window are archived there.',
      })
      close(false)
    } catch (err) {
      toast.error('Could not make it active', { description: (err as Error).message })
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Connect storage</DialogTitle>
          <DialogDescription>
            Hours that leave the local window are archived here instead of deleted. Credentials are encrypted on this
            host and never shown again.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {result.v.ok ? 'Verify passed for ' : 'Verify failed for '}
              <span className="font-medium">{result.name}</span>. It's saved
              {result.v.ok ? '.' : '; fix the details and Verify again from the list.'}
            </p>
            <VerifySteps v={result.v} />
          </div>
        ) : (
          <form id="connect-storage" onSubmit={save} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Caps>Where</Caps>
              <ToggleGroup
                variant="outline"
                size="sm"
                spacing={0}
                value={[kind]}
                onValueChange={(v) => v[0] && setKind(v[0] as DestinationKind)}
                aria-label="Storage kind"
              >
                {KINDS.map((k) => (
                  <ToggleGroupItem key={k} value={k} className="px-3">
                    {KIND_LABEL[k]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <span className="text-muted-foreground text-xs">{hint.blurb}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field id="dest-name" label="Name" value={finalName} onChange={(e) => setName(e.target.value)} required />
              <Field
                id="dest-bucket"
                label="Bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                required
              />
              <Field
                id="dest-endpoint"
                label={hint.needsEndpoint ? 'Endpoint' : 'Endpoint (optional)'}
                placeholder={hint.endpoint}
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                required={hint.needsEndpoint}
              />
              <Field
                id="dest-region"
                label="Region"
                placeholder={hint.region}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
              <Field
                id="dest-key"
                label="Access key id"
                autoComplete="off"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                required
              />
              <Field
                id="dest-secret"
                label="Secret access key"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
              />
              <Field
                id="dest-prefix"
                label="Prefix (optional)"
                placeholder="quiet/<instance id>/"
                hint="Two quiet servers can share a bucket under different prefixes."
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
              <label className="flex items-center gap-2 self-start pt-6 text-xs" htmlFor="dest-path-style">
                <Switch id="dest-path-style" checked={finalPath} onCheckedChange={(c) => setPathStyle(c)} />
                Path-style URLs
              </label>
            </div>
          </form>
        )}
        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Done
              </Button>
              {result.v.ok && (
                <Button onClick={makeActive} disabled={activate.isPending}>
                  {first ? 'Turn on retained history' : 'Make active'}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" form="connect-storage" disabled={create.isPending}>
                {create.isPending ? 'Verifying…' : 'Save and verify'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Settings → Storage → Retained history. */
export function RetainedHistory({ sqlite }: { sqlite: boolean }) {
  const h = useHistory().data
  const owner = isOwner(useMe())
  const [connecting, setConnecting] = useState(false)
  if (!sqlite)
    return (
      <Panel title="Retained history" aside="needs the SQLite store">
        <p className="px-4 py-3 text-muted-foreground text-sm">
          With <code className="font-mono">--store memory</code> nothing is kept on disk, so nothing can be archived.
        </p>
      </Panel>
    )
  if (!h) return null
  const active = h.destinations.find((d) => d.active)
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <CloudIcon className="size-4 text-muted-foreground" /> Retained history
        </span>
      }
      aside={
        active
          ? `on · ${active.name}${h.waiting_hours ? ` · ${h.waiting_hours} h waiting` : ''}`
          : h.enabled
            ? 'off · no active destination'
            : 'off · local window only'
      }
    >
      {h.destinations.length === 0 ? (
        <div className="flex items-center justify-between gap-6 px-4 py-4">
          <p className="max-w-lg text-muted-foreground text-sm">
            Keep searchable history longer than the local window: in Garage next to quiet, or in a bucket you bring
            (Cloudflare R2, Amazon S3, S3-compatible). The local window keeps working as it is.
          </p>
          {owner && (
            <Button onClick={() => setConnecting(true)}>
              <PlusIcon /> Connect storage
            </Button>
          )}
        </div>
      ) : (
        <>
          <ul aria-label="Destinations">
            {h.destinations.map((d) => (
              <DestinationRow key={d.id} d={d} owner={owner} />
            ))}
          </ul>
          <div className={cn('flex items-center justify-between gap-4 border-t px-4 py-2.5 text-xs')}>
            <span className="text-muted-foreground">
              {h.gap_hours > 0
                ? `${h.gap_hours} hour${h.gap_hours === 1 ? '' : 's'} not retained · latest: ${
                    h.gaps[0] ? `${fmtDay(h.gaps[0].hour)}, ${GAP_LABEL[h.gaps[0].reason]}` : ''
                  }`
                : active
                  ? 'Every hour that left the local window was archived.'
                  : 'No destination is active: hours that leave the local window are deleted.'}
            </span>
            {owner && (
              <Button variant="outline" size="xs" onClick={() => setConnecting(true)}>
                <PlusIcon /> Connect storage
              </Button>
            )}
          </div>
        </>
      )}
      <ConnectStorage open={connecting} onOpenChange={setConnecting} first={!active} />
    </Panel>
  )
}
