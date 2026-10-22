import type { ReactNode } from 'react'
import { Logo } from '@/components/logo'
import { useAuth } from '@/lib/auth-api'
import { cn } from '@/lib/utils'

/**
 * Signed-out pages (setup, sign in, invite, reset): no sidebar, logo + host on
 * top, a centred card, a mono footer.
 */
export function AuthFrame({ children, footer }: { children: ReactNode; footer?: string }) {
  const version = useAuth().data?.version
  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between px-8">
        <Logo />
        <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-status-ok" />
          {window.location.host}
        </span>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10">{children}</main>
      <footer className="flex h-12 shrink-0 items-center justify-between border-t px-8 font-mono text-[11px] text-muted-foreground">
        <span>
          {footer ?? 'self-hosted · single host'}
          {version ? ` · v${version}` : ''}
        </span>
        <a
          href="https://github.com/qwamicodes/quiet-telemetry"
          className="hover:text-foreground"
          target="_blank"
          rel="noreferrer"
        >
          github
        </a>
      </footer>
    </div>
  )
}

export function AuthCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('w-full max-w-[420px] border bg-card p-7 text-card-foreground', className)}>
      {children}
    </section>
  )
}

export function Field({
  label,
  htmlFor,
  hint,
  extra,
  children,
}: {
  label: string
  htmlFor: string
  hint?: ReactNode
  extra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={htmlFor} className="font-medium text-xs">
          {label}
        </label>
        {extra}
      </div>
      {children}
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  )
}

/** Inline form error under the fields. */
export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p role="alert" className="border border-level-error/40 bg-level-error-muted px-2.5 py-2 text-level-error text-xs">
      {children}
    </p>
  )
}
