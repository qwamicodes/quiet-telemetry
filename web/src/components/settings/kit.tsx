import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A settings page title with its one-line subtitle and an optional right-hand note. */
export function PageHeader({ title, sub, aside }: { title: string; sub?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-6 pb-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-xl">{title}</h2>
        {sub && <p className="text-muted-foreground text-sm">{sub}</p>}
      </div>
      {aside && <div className="pt-1 font-mono text-muted-foreground text-xs">{aside}</div>}
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
    <div className="flex items-start justify-between gap-6 border-b py-4">
      <div className="flex max-w-xl flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium">
            {label}
          </label>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        {hint && <span className="text-muted-foreground text-xs leading-relaxed">{hint}</span>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {children}
        {under && <span className="font-mono text-[11px] text-muted-foreground">{under}</span>}
      </div>
    </div>
  )
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('border bg-card', className)}>
      {(title || aside) && (
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
          <span className="font-medium">{title}</span>
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
