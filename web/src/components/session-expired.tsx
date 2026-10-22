import { useNavigate, useRouterState } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { PasswordInput } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { ApiError } from '@/lib/api'
import { useAuth, useLogin, useLogout } from '@/lib/auth-api'
import { useSessionLost } from '@/lib/session'

/**
 * "Your session expired": shown over whatever page the user was on when an
 * API call came back 401 (signed out elsewhere, removed, 30 days up). Signing
 * in again keeps them on the same page; the stream picks up where it was.
 */
export function SessionExpired() {
  const lost = useSessionLost()
  const user = useAuth().data?.user
  const login = useLogin()
  const logout = useLogout()
  const navigate = useNavigate()
  const href = useRouterState({ select: (s) => s.location.href })
  const [password, setPassword] = useState('')
  if (!lost) return null

  const toSignIn = () =>
    logout.mutate(undefined, { onSettled: () => navigate({ to: '/signin', search: { redirect: href } }) })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!user) return toSignIn()
    login.mutate({ email: user.email, password }, { onSuccess: () => setPassword('') })
  }
  const err = login.error instanceof ApiError ? login.error.message : login.error ? 'Could not reach quiet.' : null

  return (
    <Dialog open modal disablePointerDismissal onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogTitle className="font-semibold text-base">Your session expired</DialogTitle>
        <DialogDescription className="text-muted-foreground text-sm">
          You were signed out after 30 days, or from another device. Sign in again and you'll land back here.
        </DialogDescription>
        {user && (
          <div className="flex items-center gap-3 border p-3">
            <span aria-hidden className="flex size-8 items-center justify-center border bg-muted font-mono text-xs">
              {user.name[0]?.toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px]">{user.name}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">{user.email}</span>
            </span>
            <button type="button" className="text-brand text-xs hover:underline" onClick={toSignIn}>
              Not you?
            </button>
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Sign in again">
          <label htmlFor="again-password" className="font-medium text-xs">
            Password
          </label>
          <PasswordInput
            id="again-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
          {err && (
            <p role="alert" className="text-level-error text-xs">
              {err}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={toSignIn}>
              Sign out
            </Button>
            <Button type="submit" disabled={login.isPending}>
              Sign in again <Kbd>↵</Kbd>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
