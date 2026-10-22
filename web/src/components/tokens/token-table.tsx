import { CheckIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { CopyButton } from '@/components/copy-button'
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { CreatedIngestToken, IngestToken } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtAgo, fmtDay } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useCreateToken, useRevokeToken, useTokens } from '@/lib/tokens-api'
import { cn } from '@/lib/utils'

function CreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: (c: CreatedIngestToken) => void
}) {
  const create = useCreateToken()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'any' | 'one'>('any')
  const [source, setSource] = useState('')
  const valid = name.trim() && (scope === 'any' || source.trim())
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    try {
      const c = await create.mutateAsync({
        name: name.trim(),
        source: scope === 'one' ? source.trim() : undefined,
      })
      onCreated(c)
      onOpenChange(false)
      setName('')
      setSource('')
      setScope('any')
    } catch (err) {
      toast.error('Could not create the token', { description: (err as Error).message })
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Create ingest token</DialogTitle>
            <DialogDescription>Send-only: it can push lines, nothing else. You see it once.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token-name" className="text-muted-foreground">
              Name
            </label>
            <Input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="vector · edge-1"
              aria-label="Token name"
              maxLength={80}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground">Scope</span>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'any' | 'one')}>
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the Base UI radio inside is the control */}
              <label className="flex items-center gap-2">
                <RadioGroupItem value="any" aria-label="All sources" />
                All sources <span className="text-muted-foreground">· the shipper names each source</span>
              </label>
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the Base UI radio inside is the control */}
              <label className="flex items-center gap-2">
                <RadioGroupItem value="one" aria-label="One source" />
                One source <span className="text-muted-foreground">· every line lands there</span>
              </label>
            </RadioGroup>
            {scope === 'one' && (
              <Input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="cron-runner"
                aria-label="Source name"
                className="font-mono"
                maxLength={128}
              />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RevokeDialog({ token, onOpenChange }: { token: IngestToken | null; onOpenChange: (o: boolean) => void }) {
  const revoke = useRevokeToken()
  const confirm = async () => {
    if (!token) return
    try {
      await revoke.mutateAsync(token.id)
      toast.success(`Token “${token.name}” revoked`, { description: 'Shippers using it now get 401.' })
      onOpenChange(false)
    } catch (err) {
      toast.error('Could not revoke the token', { description: (err as Error).message })
    }
  }
  return (
    <Dialog open={token != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke “{token?.name}”?</DialogTitle>
          <DialogDescription>
            Anything sending with {token?.preview} gets 401 from its next request. Lines already received stay. This
            can't be undone; create a new token instead.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={revoke.isPending}>
            Revoke token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Settings → Ingest tokens: create (secret shown once), list, revoke. */
export function IngestTokens() {
  const { data: tokens, isPending, error } = useTokens()
  const owner = isOwner(useMe())
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedIngestToken | null>(null)
  const [revoking, setRevoking] = useState<IngestToken | null>(null)
  return (
    <section className="flex max-w-190 flex-col gap-5" aria-label="Ingest tokens">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-xl">Ingest tokens</h2>
          <p className="text-muted-foreground text-sm">
            Vector, Fluent Bit, OTLP over HTTP and NDJSON pushes authenticate with these. Docker needs none.
          </p>
        </div>
        {owner ? (
          <Button onClick={() => setCreating(true)}>
            <PlusIcon /> Create token
          </Button>
        ) : (
          <span className="border px-2 py-1 font-mono text-[11px] text-muted-foreground">owners manage tokens</span>
        )}
      </header>

      {created && (
        <div className="flex flex-col gap-3 border border-status-ok/50 bg-status-ok/5 p-4" role="status">
          <div className="flex items-center gap-2">
            <CheckIcon className="size-3.5 text-status-ok" />
            <span className="font-medium">Token “{created.token.name}” created</span>
            <span className="text-muted-foreground text-xs">· copy it now, it won't be shown again</span>
          </div>
          <div className="flex h-10 items-center gap-2 border bg-code pr-1.5 pl-3">
            <code className="flex-1 truncate font-mono text-[13px]" data-testid="new-secret">
              {created.secret}
            </code>
            <CopyButton text={created.secret} what="Token" variant="default" />
          </div>
        </div>
      )}

      <table className="w-full border text-left">
        <thead className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          <tr className="h-9 border-b">
            <th className="px-4 font-normal">Name</th>
            <th className="font-normal">Token</th>
            <th className="font-normal">Scope</th>
            <th className="font-normal">Created</th>
            <th className="font-normal">Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tokens?.map((t) => (
            <tr key={t.id} className={cn('h-11 border-b last:border-b-0', t.revoked && 'text-muted-foreground')}>
              <td className="px-4">{t.name}</td>
              <td className="font-mono text-muted-foreground text-xs">{t.preview}</td>
              <td>
                <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {t.source ?? 'all sources'}
                </span>
              </td>
              <td className="font-mono text-muted-foreground text-xs">{fmtDay(t.created)}</td>
              <td className="font-mono text-muted-foreground text-xs">{t.last_used ? fmtAgo(t.last_used) : 'never'}</td>
              <td className="pr-3 text-right">
                {t.revoked ? (
                  <span className="bg-destructive/15 px-1.5 py-0.5 font-mono text-[11px] text-destructive">
                    revoked
                  </span>
                ) : owner ? (
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name}`}>
                    Revoke
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
          {tokens?.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-muted-foreground text-xs">
                No tokens yet. Create one, or connect a source and quiet makes one for you.
              </td>
            </tr>
          )}
          {isPending && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-muted-foreground text-xs">
                Loading…
              </td>
            </tr>
          )}
          {error && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-destructive text-xs">
                {error.message}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="text-muted-foreground text-xs">
        Tokens only allow sending lines. They can't read logs or change settings. Revoking takes effect on the next
        request.
      </p>

      <CreateDialog open={creating} onOpenChange={setCreating} onCreated={setCreated} />
      <RevokeDialog token={revoking} onOpenChange={(o) => !o && setRevoking(null)} />
    </section>
  )
}
