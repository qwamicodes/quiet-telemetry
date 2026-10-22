import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowRightIcon, CheckIcon, ClockIcon, KeyRoundIcon, LinkIcon, TerminalIcon, XIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { AuthCard, AuthFrame, Field, FormError } from '@/components/auth/auth-frame'
import { MIN_PASSWORD, PasswordInput, PasswordMeter } from '@/components/auth/password-input'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import type { InviteProblem, SetupHost } from '@/gen'
import { ApiError } from '@/lib/api'
import { inviteQuery, resetQuery, useAcceptInvite, useAuth, useCompleteReset, useLogin, useSetup } from '@/lib/auth-api'
import { fmtBytes, fmtDay, fmtWindow } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const signInRoute = getRouteApi('/signin')
const inviteRoute = getRouteApi('/invite/$token')
const resetRoute = getRouteApi('/reset/$token')

/** A readable message for a failed auth request. */
function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'cross_site') return 'This request came from another site and was refused.'
    return e.message.charAt(0).toUpperCase() + e.message.slice(1)
  }
  return 'Could not reach quiet. Check the server is running.'
}

function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Working…' : children}
      {!pending && <Kbd className="ml-1">↵</Kbd>}
    </Button>
  )
}

function Heading({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
      {sub && <p className="text-muted-foreground text-sm">{sub}</p>}
    </div>
  )
}

// ---- first run ------------------------------------------------------------------

function HostCheck({ ok, title, detail }: { ok: boolean | null; title: string; detail: string }) {
  return (
    <li className="flex gap-2.5 border-b py-2.5 last:border-b-0">
      <span
        className={cn(
          'mt-0.5 [&_svg]:size-3.5',
          ok === false ? 'text-level-error' : ok ? 'text-status-ok' : 'text-muted-foreground',
        )}
      >
        {ok === false ? <XIcon /> : ok ? <CheckIcon /> : <ClockIcon />}
      </span>
      <span className="flex flex-col">
        <span className="text-[13px]">{title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </li>
  )
}

function ThisHost({ host }: { host: SetupHost }) {
  const d = host.docker
  const docker =
    d.state === 'connected'
      ? { ok: true, title: 'Docker socket readable', detail: `docker.sock · ${d.containers} containers` }
      : d.state === 'disabled'
        ? { ok: null, title: 'Docker receiver off', detail: 'QUIET_DOCKER=off · HTTP ingest only' }
        : d.state === 'connecting'
          ? { ok: null, title: 'Docker socket', detail: 'connecting…' }
          : { ok: false, title: 'Docker socket not readable', detail: 'mount /var/run/docker.sock read-only' }
  return (
    <aside aria-label="This host" className="w-full max-w-[340px] self-center border bg-card p-5">
      <h2 className="mb-2 font-medium text-sm">This host</h2>
      <ul>
        <HostCheck {...docker} />
        <HostCheck
          ok={host.store === 'memory' ? null : host.data_dir_writable}
          title={host.data_dir_writable ? 'Data directory writable' : 'Data directory not writable'}
          detail={host.data_dir ?? '—'}
        />
        <HostCheck
          ok
          title="Storage defaults"
          detail={`${fmtWindow(host.retention_ms)} searchable · ${fmtBytes(host.max_disk)} disk cap`}
        />
      </ul>
      <p className="mt-3 text-muted-foreground text-xs">
        v0.1 runs on one host and reads the local Docker socket. Remote hosts come in v0.2.
      </p>
    </aside>
  )
}

export function SetupPage() {
  const host = useAuth().data?.host
  const setup = useSetup()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setup.mutate(
      { name, email, password },
      {
        onSuccess: (r) => {
          toast.success(`Welcome, ${r.user.name.split(' ')[0]}`, {
            description: 'You are the owner. Connect a source next.',
          })
          navigate({ to: '/' })
        },
      },
    )
  }
  return (
    <AuthFrame footer="first run · no owner yet">
      <div className="flex w-full max-w-[800px] flex-wrap items-start justify-center gap-6">
        <AuthCard>
          <Heading
            title="Set up quiet"
            sub="You're the first person here, so this account becomes the owner. Invite teammates once you're in."
          />
          <ol className="mb-5 flex gap-5 text-sm">
            <li className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center border border-foreground font-mono text-[11px]">
                1
              </span>
              Owner account
            </li>
            <li className="flex items-center gap-2 text-muted-foreground">
              <span className="flex size-5 items-center justify-center border font-mono text-[11px]">2</span>
              Connect a source
            </li>
          </ol>
          <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Create owner account">
            <Field label="Your name" htmlFor="setup-name">
              <Input
                id="setup-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
              />
            </Field>
            <Field label="Email" htmlFor="setup-email" hint="Used to sign in. No mail is sent in v0.1.">
              <Input
                id="setup-email"
                type="email"
                className="font-mono"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </Field>
            <Field
              label="Password"
              htmlFor="setup-password"
              hint={`At least ${MIN_PASSWORD} characters. Stored as an argon2id hash on this host.`}
            >
              <PasswordInput
                id="setup-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                required
              />
              <PasswordMeter value={password} />
            </Field>
            <FormError>{setup.error ? message(setup.error) : null}</FormError>
            <SubmitButton pending={setup.isPending}>
              Create owner account <ArrowRightIcon />
            </SubmitButton>
          </form>
        </AuthCard>
        {host && <ThisHost host={host} />}
      </div>
    </AuthFrame>
  )
}

// ---- sign in ---------------------------------------------------------------------

export function SignInPage() {
  const { redirect } = signInRoute.useSearch()
  const login = useLogin()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [forgot, setForgot] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    login.mutate({ email, password, remember }, { onSuccess: () => router.history.push(redirect ?? '/') })
  }
  return (
    <AuthFrame>
      <AuthCard>
        <Heading title="Sign in to quiet" sub={window.location.host} />
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Sign in">
          <Field label="Email" htmlFor="signin-email">
            <Input
              id="signin-email"
              type="email"
              className="font-mono"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </Field>
          <Field
            label="Password"
            htmlFor="signin-password"
            extra={
              <button
                type="button"
                className="text-brand text-xs hover:underline"
                onClick={() => setForgot((f) => !f)}
                aria-expanded={forgot}
              >
                Forgot password?
              </button>
            }
          >
            <PasswordInput
              id="signin-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <div className="flex items-center gap-2.5 text-[13px]">
            <Switch
              id="signin-remember"
              checked={remember}
              onCheckedChange={setRemember}
              aria-label="Keep me signed in for 30 days"
            />
            <span aria-hidden>Keep me signed in for 30 days</span>
          </div>
          <FormError>{login.error ? message(login.error) : null}</FormError>
          <SubmitButton pending={login.isPending}>Sign in</SubmitButton>
        </form>
        {forgot && (
          <div className="mt-5 flex flex-col gap-2.5 border border-dashed p-3.5" role="note">
            <div className="flex items-center gap-2 font-medium text-[13px] [&_svg]:size-3.5">
              <TerminalIcon /> Password resets happen on the server
            </div>
            <p className="text-muted-foreground text-xs">
              There's no reset email in v0.1. Ask an owner for a reset link (Settings → Members), or anyone with shell
              access to the host can run:
            </p>
            <div className="flex items-center justify-between gap-2 border bg-background py-1 pr-1 pl-2.5">
              <code className="truncate font-mono text-xs">$ quiet admin reset-password &lt;email&gt;</code>
              <CopyButton text="quiet admin reset-password " label="Copy" variant="ghost" />
            </div>
            <p className="text-muted-foreground text-xs">
              It prints a one-time link (valid for an hour) to choose a new password.
            </p>
          </div>
        )}
      </AuthCard>
    </AuthFrame>
  )
}

// ---- invite ----------------------------------------------------------------------

function Initial({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center border bg-muted font-mono text-xs">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

function daysLeft(ts: number) {
  const d = Math.ceil((ts - Date.now()) / 86_400_000)
  return d <= 1 ? 'expires within a day' : `expires in ${d} days`
}

function InviteDead({ problem }: { problem: InviteProblem }) {
  const inv = problem.invite
  const by = inv?.created_by ?? 'the owner'
  const title =
    problem.code === 'expired'
      ? 'This invite link has expired'
      : problem.code === 'used'
        ? 'This invite link was already used'
        : problem.code === 'revoked'
          ? 'This invite link was revoked'
          : "This invite link isn't valid"
  const fmt = (ts: number) =>
    new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <AuthCard>
      <span className="mb-5 flex size-9 items-center justify-center border text-level-warn [&_svg]:size-4">
        <ClockIcon />
      </span>
      <Heading title={title} sub="Nothing was created. You can still join once you have a new link." />
      {inv && (
        <dl className="mb-5 grid grid-cols-[96px_1fr] font-mono text-xs [&>*]:border-b [&>*]:py-1.5">
          <dt className="text-brand">invite</dt>
          <dd className="text-muted-foreground">{inv.preview}</dd>
          {inv.email && (
            <>
              <dt className="text-brand">for</dt>
              <dd>{inv.email}</dd>
            </>
          )}
          <dt className="text-brand">created</dt>
          <dd className="text-muted-foreground">
            {fmt(inv.created)} by {inv.created_by}
          </dd>
          <dt className="text-brand">{problem.code === 'expired' ? 'expired' : 'expires'}</dt>
          <dd className={problem.code === 'expired' ? 'text-level-warn' : 'text-muted-foreground'}>
            {fmt(inv.expires)}
          </dd>
        </dl>
      )}
      <p className="mb-5 text-muted-foreground text-xs">
        Invite links work for 7 days and only once. Ask an owner to copy a fresh link from Settings → Members.
      </p>
      <div className="flex gap-2">
        <CopyButton
          text={`Hi ${by}, my quiet invite link ${problem.code === 'expired' ? 'expired' : "doesn't work"}. Could you copy me a fresh one from Settings → Members?`}
          label={`Copy message for ${by.split(' ')[0]}`}
          what="Message"
        />
        <Button nativeButton={false} render={<Link to="/signin" />} className="flex-1">
          Go to sign in <ArrowRightIcon />
        </Button>
      </div>
    </AuthCard>
  )
}

export function InvitePage() {
  const { token } = inviteRoute.useParams()
  const lookup = useQuery(inviteQuery(token))
  const auth = useAuth().data
  const accept = useAcceptInvite()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  if (lookup.isPending) {
    return (
      <AuthFrame>
        <p className="text-muted-foreground text-sm">Checking the invite…</p>
      </AuthFrame>
    )
  }
  if (lookup.isError) {
    return (
      <AuthFrame>
        <AuthCard>
          <Heading title="Could not check this invite" sub={message(lookup.error)} />
          <Button variant="outline" onClick={() => lookup.refetch()}>
            Try again
          </Button>
        </AuthCard>
      </AuthFrame>
    )
  }
  if (!lookup.data.ok) {
    return (
      <AuthFrame>
        <InviteDead problem={lookup.data.problem} />
      </AuthFrame>
    )
  }
  const inv = lookup.data.invite
  const instance = auth?.instance_name || 'quiet'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    accept.mutate(
      { token, name, password, email: inv.email ? undefined : email },
      {
        onSuccess: (r) => {
          toast.success(`Welcome, ${r.user.name.split(' ')[0]}`)
          navigate({ to: '/' })
        },
      },
    )
  }
  return (
    <AuthFrame>
      <AuthCard>
        <Heading
          title={`Join ${instance}`}
          sub={
            inv.role === 'owner'
              ? 'A calm view of this team’s logs. Owners also manage members, invites and ingest tokens.'
              : 'A calm view of this team’s logs. Members can read every source.'
          }
        />
        <div className="mb-5 flex items-center gap-3 border p-3">
          <Initial name={inv.created_by} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px]">
              {inv.created_by} invited you as {inv.role === 'owner' ? 'an owner' : 'a member'}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {daysLeft(inv.expires)} · {fmtDay(inv.expires)}
            </span>
          </div>
          <span className="border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{inv.role}</span>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Accept invite">
          <Field
            label="Email"
            htmlFor="invite-email"
            hint={
              inv.email
                ? `Set by the invite. Ask ${inv.created_by.split(' ')[0]} for a new link to use a different address.`
                : 'Used to sign in.'
            }
          >
            <Input
              id="invite-email"
              type="email"
              className="font-mono"
              value={inv.email ?? email}
              onChange={(e) => setEmail(e.target.value)}
              readOnly={!!inv.email}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="Your name" htmlFor="invite-name">
            <Input
              id="invite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          </Field>
          <Field label="Password" htmlFor="invite-password">
            <PasswordInput
              id="invite-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              required
            />
            <PasswordMeter value={password} />
          </Field>
          <FormError>{accept.error ? message(accept.error) : null}</FormError>
          <SubmitButton pending={accept.isPending}>
            Join <ArrowRightIcon />
          </SubmitButton>
        </form>
      </AuthCard>
    </AuthFrame>
  )
}

// ---- reset link -------------------------------------------------------------------

export function ResetPage() {
  const { token } = resetRoute.useParams()
  const lookup = useQuery(resetQuery(token))
  const reset = useCompleteReset()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const mismatch = confirm.length > 0 && confirm !== password

  if (lookup.isPending) {
    return (
      <AuthFrame>
        <p className="text-muted-foreground text-sm">Checking the link…</p>
      </AuthFrame>
    )
  }
  if (lookup.isError) {
    const code = lookup.error instanceof ApiError ? lookup.error.code : undefined
    return (
      <AuthFrame>
        <AuthCard>
          <span className="mb-5 flex size-9 items-center justify-center border text-level-warn [&_svg]:size-4">
            <KeyRoundIcon />
          </span>
          <Heading
            title={
              code === 'expired'
                ? 'This reset link has expired'
                : code === 'used'
                  ? 'This reset link was already used'
                  : "This reset link isn't valid"
            }
            sub="Reset links work once. Ask an owner for a new one, or run quiet admin reset-password on the host."
          />
          <Button nativeButton={false} render={<Link to="/signin" />} className="w-full">
            Go to sign in <ArrowRightIcon />
          </Button>
        </AuthCard>
      </AuthFrame>
    )
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (mismatch) return
    reset.mutate(
      { token, password },
      {
        onSuccess: () => {
          toast.success('Password changed', { description: 'Every session was signed out. Sign in with the new one.' })
          navigate({ to: '/signin' })
        },
      },
    )
  }
  return (
    <AuthFrame>
      <AuthCard>
        <Heading
          title="Choose a new password"
          sub={
            <>
              For <span className="font-mono">{lookup.data.email}</span>. This link works once and signs you out
              everywhere.
            </>
          }
        />
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Choose a new password">
          <Field label="New password" htmlFor="reset-password">
            <PasswordInput
              id="reset-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              required
            />
            <PasswordMeter value={password} />
          </Field>
          <Field
            label="Confirm new password"
            htmlFor="reset-confirm"
            hint={mismatch ? 'The passwords differ.' : undefined}
          >
            <PasswordInput
              id="reset-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              aria-invalid={mismatch}
              required
            />
          </Field>
          <FormError>{reset.error ? message(reset.error) : null}</FormError>
          <SubmitButton pending={reset.isPending}>
            Set password <ArrowRightIcon />
          </SubmitButton>
        </form>
      </AuthCard>
    </AuthFrame>
  )
}

/** A malformed invite/reset link (path params failed their schema). */
export function BrokenAuthLink() {
  return (
    <AuthFrame>
      <AuthCard>
        <span className="mb-5 flex size-9 items-center justify-center border text-level-warn [&_svg]:size-4">
          <LinkIcon />
        </span>
        <Heading title="This link is broken" sub="Part of it is missing or mistyped. Copy the whole link again." />
        <Button nativeButton={false} render={<Link to="/signin" />} className="w-full">
          Go to sign in <ArrowRightIcon />
        </Button>
      </AuthCard>
    </AuthFrame>
  )
}
