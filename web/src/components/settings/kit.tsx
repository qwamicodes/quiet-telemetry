import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A settings page title with its one-line subtitle and an optional right-hand note. */
export function PageHeader({
  title,
  sub,
  aside,
  className,
}: {
  title: string
  sub?: ReactNode
  aside?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex items-end justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 className="font-semibold text-xl leading-6 tracking-tight">{title}</h2>
        {sub && <p className="text-muted-foreground text-sm">{sub}</p>}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </header>
  )
}

/** One setting: label and hint on the left, the control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  under,
  htmlFor,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  /** Small mono text under the control (e.g. `default 24h`). */
  under?: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b py-4">
      <div className="flex min-w-48 max-w-xl flex-col gap-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium text-sm">
            {label}
          </label>
        ) : (
          <span className="font-medium text-sm">{label}</span>
        )}
        {hint && <span className="text-muted-foreground text-xs leading-[18px]">{hint}</span>}
      </div>
      <div className="flex min-w-0 max-w-[55%] shrink-0 flex-col items-end gap-1.5">
        {children}
        {under && (
          <span className="max-w-full break-all text-right font-mono text-[11px] text-muted-foreground">{under}</span>
        )}
      </div>
    </div>
  )
}

export function Panel({
  title,
  aside,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  /** Title inline with the body, no divider (v0.1.1-06.3 cards). */
  flush?: boolean
}) {
  return (
    <section className={cn('border bg-card', className)}>
      {(title || aside) && (
        <div
          className={cn(
            'flex items-center justify-between gap-4 px-4',
            flush ? '-mb-1 pt-4 text-[13px] leading-[18px]' : 'border-b py-3',
          )}
        >
          <span className={flush ? 'font-semibold' : 'font-medium'}>{title}</span>
          {aside && <span className="font-mono text-[11px] text-muted-foreground">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

/** Shown to members on pages they can read but not change. */
export function ReadOnlyNote() {
  return (
    <p className="border border-dashed px-3 py-2 text-muted-foreground text-xs">
      Only an owner can change these settings. You can see what is in effect.
    </p>
  )
}

/** A small mono caps label. */
export function Caps({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]', className)}>
      {children}
    </span>
  )
}
