import { CheckIcon, EllipsisIcon, KeyRoundIcon, PlusIcon, RotateCcwIcon, Trash2Icon, XIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CreatedInvite, Invite, Member, ResetLink, Role } from '@/gen'
import {
  absolute,
  isOwner,
  useCreateInvite,
  useMe,
  useMembers,
  useRemoveMember,
  useResetLink,
  useRevokeInvite,
  useSetRole,
} from '@/lib/auth-api'
import { fmtAgo, fmtDay } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', member: 'Member' }

function RoleSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: Role
  onChange: (r: Role) => void
  label: string
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as Role)} disabled={disabled}>
      <SelectTrigger aria-label={label} size="sm" className="w-28">
        <SelectValue>{(v: Role) => ROLE_LABEL[v]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">Member</SelectItem>
        <SelectItem value="owner">Owner</SelectItem>
      </SelectContent>
    </Select>
  )
}

function Initial({ text, dashed }: { text: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center border font-mono text-[11px]',
        dashed ? 'border-dashed text-muted-foreground' : 'bg-muted',
      )}
    >
      {text}
    </span>
  )
}

function lastSeen(ts: number | null) {
  if (ts == null) return 'never signed in'
  return Date.now() - ts < 2 * 60_000 ? 'active now' : fmtAgo(ts)
}

const err = (e: unknown) => (e as Error).message

function InviteForm({ onCreated }: { onCreated: (c: CreatedInvite) => void }) {
  const create = useCreateInvite()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate(
      { email: email.trim() || undefined, role },
      {
        onSuccess: (c) => {
          setEmail('')
          onCreated(c)
        },
        onError: (e) => toast.error('Could not create the invite', { description: err(e) }),
      },
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-label="Create invite link">
      <Input
        type="email"
        placeholder="email (optional)"
        aria-label="Invitee email"
        className="w-64 font-mono"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <RoleSelect value={role} onChange={setRole} label="Invite role" />
      <Button type="submit" variant="secondary" disabled={create.isPending}>
        <PlusIcon /> Create invite link
      </Button>
    </form>
  )
}

function CreatedBanner({ created, onClose }: { created: CreatedInvite; onClose: () => void }) {
  const link = absolute(created.path)
  return (
    <div role="status" className="flex flex-col gap-2.5 border border-status-ok/50 bg-status-ok/5 p-3.5">
      <div className="flex items-center gap-2 text-[13px]">
        <CheckIcon className="size-3.5 text-status-ok" />
        <span className="font-medium">Invite link{created.invite.email ? ` for ${created.invite.email}` : ''}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          · send it however you like · works once · expires in 7 days · shown once
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 border bg-background py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="invite-link">
          {link}
        </code>
        <CopyButton text={link} label="Copy invite link" what="Invite link" variant="default" />
      </div>
    </div>
  )
}

function ResetLinkDialog({
  result,
  onClose,
}: {
  result: { member: Member; link: ResetLink } | null
  onClose: () => void
}) {
  const link = result ? absolute(result.link.path) : ''
  return (
    <Dialog open={result != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Password reset link for {result?.member.name}</DialogTitle>
          <DialogDescription>
            Send it to {result?.member.email} yourself. It works once, for 24 hours, and signs them out everywhere. Any
            older reset link for them stops working.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border bg-background py-1 pr-1 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{link}</code>
          <CopyButton text={link} label="Copy link" what="Reset link" variant="default" />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RemoveDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const remove = useRemoveMember()
  const confirm = () => {
    if (!member) return
    remove.mutate(member.id, {
      onSuccess: () => {
        toast.success(`${member.name} removed`, { description: 'Signed out everywhere.' })
        onClose()
      },
      onError: (e) => toast.error('Could not remove', { description: err(e) }),
    })
  }
  return (
    <Dialog open={member != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {member?.name}?</DialogTitle>
          <DialogDescription>
            {member?.email} loses access and is signed out everywhere at once. You can invite them again later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={remove.isPending}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MemberRow({
  m,
  meId,
  manage,
  onReset,
  onRemove,
}: {
  m: Member
  meId: number | undefined
  manage: boolean
  onReset: (m: Member) => void
  onRemove: (m: Member) => void
}) {
  const setRole = useSetRole()
  const me = m.id === meId
  const change = (role: Role) =>
    setRole.mutate(
      { id: m.id, role },
      {
        onSuccess: (u) => toast.success(`${u.name} is now ${u.role === 'owner' ? 'an owner' : 'a member'}`),
        onError: (e) => toast.error('Could not change the role', { description: err(e) }),
      },
    )
  return (
    <li className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0" aria-label={m.name}>
      <Initial text={(m.name[0] ?? '?').toUpperCase()} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px]">
          {m.name}
          {me && <span className="ml-1.5 text-muted-foreground">(you)</span>}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{m.email}</span>
      </div>
      <span className="w-28 text-right font-mono text-[11px] text-muted-foreground">{lastSeen(m.last_seen)}</span>
      {manage ? (
        <RoleSelect value={m.role} onChange={change} label={`Role of ${m.name}`} disabled={setRole.isPending} />
      ) : (
        <span className="w-28 text-right">
          <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{m.role}</span>
        </span>
      )}
      {manage ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${m.name}`} />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onReset(m)}>
              <KeyRoundIcon /> Password reset link
            </DropdownMenuItem>
            {!me && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onRemove(m)}>
                  <Trash2Icon /> Remove
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="w-7" />
      )}
    </li>
  )
}

function InviteRow({ inv, onNew }: { inv: Invite; onNew: (inv: Invite) => void }) {
  const revoke = useRevokeInvite()
  const expired = inv.expires <= Date.now()
  const who = inv.email ?? 'anyone with the link'
  return (
    <li className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0" aria-label={`Invite ${who}`}>
      <Initial text="–" dashed />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[13px]">{who}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          invited {fmtAgo(inv.created)} by {inv.created_by} · {expired ? 'expired' : 'expires'} {fmtDay(inv.expires)} ·{' '}
          {inv.role}
        </span>
      </div>
      <span
        className={cn('w-28 text-right font-mono text-[11px]', expired ? 'text-level-warn' : 'text-muted-foreground')}
      >
        {expired ? 'expired' : 'pending'}
      </span>
      <Button variant="outline" size="sm" className="w-28" onClick={() => onNew(inv)}>
        <RotateCcwIcon /> New link
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Revoke invite for ${who}`}
        disabled={revoke.isPending}
        onClick={() =>
          revoke.mutate(inv.id, {
            onSuccess: () => toast.success('Invite revoked', { description: 'The link no longer works.' }),
            onError: (e) => toast.error('Could not revoke', { description: err(e) }),
          })
        }
      >
        <XIcon />
      </Button>
    </li>
  )
}

/** Settings → Members: who can open this quiet; owners invite and manage. */
export function Members() {
  const me = useMe()
  const { data, isPending, error } = useMembers()
  const owner = isOwner(me)
  const createInvite = useCreateInvite()
  const revokeInvite = useRevokeInvite()
  const resetLink = useResetLink()
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [reset, setReset] = useState<{ member: Member; link: ResetLink } | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)

  // Only the hash of a link is kept, so "copy again" is a fresh link.
  const newLink = (inv: Invite) =>
    createInvite.mutate(
      { email: inv.email ?? undefined, role: inv.role },
      {
        onSuccess: (c) => {
          revokeInvite.mutate(inv.id)
          setCreated(c)
        },
        onError: (e) => toast.error('Could not create the invite', { description: err(e) }),
      },
    )
  const makeReset = (m: Member) =>
    resetLink.mutate(m.id, {
      onSuccess: (link) => setReset({ member: m, link }),
      onError: (e) => toast.error('Could not create a reset link', { description: err(e) }),
    })

  return (
    <section className="flex max-w-190 flex-col gap-5" aria-label="Members">
      <header className="flex flex-col gap-1">
        <h2 className="font-semibold text-xl">Members</h2>
        <p className="text-muted-foreground text-sm">
          People who can open this quiet instance. Invites are links you copy; email invites come in v0.2.
        </p>
      </header>

      {owner && <InviteForm onCreated={setCreated} />}
      {created && <CreatedBanner created={created} onClose={() => setCreated(null)} />}

      {error && <p className="text-level-error text-sm">{err(error)}</p>}
      {isPending && <p className="text-muted-foreground text-sm">Loading…</p>}
      {data && (
        <ul className="border" aria-label="People">
          {data.members.map((m) => (
            <MemberRow key={m.id} m={m} meId={me?.id} manage={owner} onReset={makeReset} onRemove={setRemoving} />
          ))}
          {data.invites.map((inv) => (
            <InviteRow key={`i${inv.id}`} inv={inv} onNew={newLink} />
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5 border p-3.5">
          <span className="flex items-center gap-2">
            <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">owner</span>
            <span className="font-mono text-[11px] text-muted-foreground">at least 1</span>
          </span>
          <p className="text-muted-foreground text-xs">
            Everything a member can do, plus members, invites, reset links, ingest tokens and exports with PII unmasked.
          </p>
        </div>
        <div className="flex flex-col gap-1.5 border p-3.5">
          <span className="flex items-center gap-2">
            <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">member</span>
            <span className="font-mono text-[11px] text-muted-foreground">read-only</span>
          </span>
          <p className="text-muted-foreground text-xs">
            Reads every source, flow and search. Exports with PII masked. Can't change members, tokens or settings.
          </p>
        </div>
      </div>

      <ResetLinkDialog result={reset} onClose={() => setReset(null)} />
      <RemoveDialog member={removing} onClose={() => setRemoving(null)} />
    </section>
  )
}
