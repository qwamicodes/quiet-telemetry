import { MonitorIcon, SmartphoneIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { MIN_PASSWORD, PasswordInput, PasswordMeter } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SessionInfo } from '@/gen'
import {
  useAuth,
  useChangePassword,
  useSessions,
  useSignOutOthers,
  useSignOutSession,
  useUpdateProfile,
} from '@/lib/auth-api'
import { fmtAgo, fmtDay } from '@/lib/format'
import { toast } from '@/lib/toast'

const err = (e: unknown) => (e as Error).message

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border p-5" aria-label={title}>
      <header className="flex items-center justify-between">
        <h3 className="font-medium text-sm">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

function Labeled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-xs">
        {label}
      </label>
      {children}
    </div>
  )
}

/** `Chrome · macOS` from a user agent, good enough to tell sessions apart. */
export function describeAgent(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown browser', mobile: false }
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /curl\//.test(ua)
            ? 'curl'
            : 'Browser'
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null
  return { label: os ? `${browser} · ${os}` : browser, mobile: /iPhone|Android|Mobile/.test(ua) }
}

function Profile() {
  const user = useAuth().data?.user
  const update = useUpdateProfile()
  const [name, setName] = useState(user?.name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  if (!user) return null
  const emailChanged = email.trim().toLowerCase() !== user.email
  const submit = (e: FormEvent) => {
    e.preventDefault()
    update.mutate(
      { name, email, password: emailChanged ? password : undefined },
      {
        onSuccess: () => {
          setPassword('')
          toast.success('Profile saved')
        },
        onError: (e) => toast.error('Could not save', { description: err(e) }),
      },
    )
  }
  return (
    <Card
      title="Profile"
      aside={<span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{user.role}</span>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Profile">
        <div className="flex gap-4">
          <Labeled id="acc-name" label="Name">
            <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Labeled>
          <Labeled id="acc-email" label="Email">
            <Input
              id="acc-email"
              type="email"
              className="font-mono"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Labeled>
        </div>
        {emailChanged && (
          <Labeled id="acc-email-password" label="Current password (to change your sign-in email)">
            <PasswordInput
              id="acc-email-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Labeled>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="outline" disabled={update.isPending}>
            Save profile
          </Button>
        </div>
      </form>
    </Card>
  )
}

function ChangePasswordCard() {
  const user = useAuth().data?.user
  const change = useChangePassword()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const mismatch = confirm.length > 0 && confirm !== next
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (mismatch) return
    change.mutate(
      { current, password: next },
      {
        onSuccess: (r) => {
          setCurrent('')
          setNext('')
          setConfirm('')
          toast.success('Password updated', {
            description: r.signed_out
              ? `${r.signed_out} other session${r.signed_out === 1 ? '' : 's'} signed out.`
              : 'No other sessions were signed in.',
          })
        },
        onError: (e) => toast.error('Could not update the password', { description: err(e) }),
      },
    )
  }
  return (
    <Card title="Change password">
      <p className="-mt-2 text-muted-foreground text-xs">
        You stay signed in here. Every other session is signed out, so a leaked password stops working everywhere.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Change password">
        <div className="flex gap-3">
          <Labeled id="pw-current" label="Current password">
            <PasswordInput
              id="pw-current"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Labeled>
          <Labeled id="pw-new" label="New password">
            <PasswordInput
              id="pw-new"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              required
            />
          </Labeled>
          <Labeled id="pw-confirm" label="Confirm new password">
            <PasswordInput
              id="pw-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              aria-invalid={mismatch}
              required
            />
          </Labeled>
        </div>
        <PasswordMeter value={next} />
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] text-muted-foreground">
            {mismatch
              ? 'the new passwords differ'
              : user
                ? `last changed ${fmtDay(user.password_changed)} · argon2id`
                : ''}
          </span>
          <Button type="submit" disabled={change.isPending || mismatch}>
            Update password
          </Button>
        </div>
      </form>
    </Card>
  )
}

function SessionRow({ s }: { s: SessionInfo }) {
  const signOut = useSignOutSession()
  const { label, mobile } = describeAgent(s.user_agent)
  return (
    <li
      className="flex items-center gap-3 border-b py-2 last:border-b-0"
      aria-label={s.current ? 'This browser' : label}
    >
      <span className="text-muted-foreground [&_svg]:size-4">{mobile ? <SmartphoneIcon /> : <MonitorIcon />}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px]">{s.current ? 'This browser' : label}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {[s.current ? label : null, s.ip, `since ${fmtDay(s.created)}`].filter(Boolean).join(' · ')}
        </span>
      </div>
      <span className="font-mono text-[11px] text-muted-foreground">{s.current ? 'now' : fmtAgo(s.last_seen)}</span>
      {s.current ? (
        <span className="border border-status-ok/50 px-1.5 py-0.5 font-mono text-[11px] text-status-ok">current</span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={signOut.isPending}
          onClick={() =>
            signOut.mutate(s.id, {
              onSuccess: () => toast.success('Session signed out'),
              onError: (e) => toast.error('Could not sign it out', { description: err(e) }),
            })
          }
        >
          Sign out
        </Button>
      )}
    </li>
  )
}

function Sessions() {
  const { data: sessions } = useSessions()
  const others = useSignOutOthers()
  const count = sessions?.filter((s) => !s.current).length ?? 0
  return (
    <Card
      title="Sessions"
      aside={
        <Button
          variant="outline"
          size="sm"
          disabled={count === 0 || others.isPending}
          onClick={() =>
            others.mutate(undefined, {
              onSuccess: (r) =>
                toast.success(`Signed out ${r.signed_out} other session${r.signed_out === 1 ? '' : 's'}`),
              onError: (e) => toast.error('Could not sign out', { description: err(e) }),
            })
          }
        >
          Sign out everywhere else
        </Button>
      }
    >
      <ul aria-label="Signed-in sessions">
        {sessions?.map((s) => (
          <SessionRow key={s.id} s={s} />
        ))}
      </ul>
    </Card>
  )
}

/** Settings → Account: profile, password, signed-in sessions. */
export function Account() {
  const auth = useAuth().data
  return (
    <section className="flex max-w-190 flex-col gap-5" aria-label="Account">
      <header className="flex flex-col gap-1">
        <h2 className="font-semibold text-xl">Account</h2>
        <p className="text-muted-foreground text-sm">Your profile and password on this quiet instance.</p>
      </header>
      {auth?.auth === 'off' ? (
        <p className="border border-dashed p-4 text-muted-foreground text-sm">
          Sign-in is off on this server (<code className="font-mono">QUIET_AUTH=off</code>, local development only), so
          there are no accounts. Restart without it to use accounts.
        </p>
      ) : (
        <>
          <Profile />
          <ChangePasswordCard />
          <Sessions />
        </>
      )}
    </section>
  )
}
