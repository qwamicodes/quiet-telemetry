import { type ComponentProps, type ReactNode, useId } from 'react'
import { Button } from '@/components/ui/button'
import type { Destination, DestinationKind } from '@/gen'
import { fmtClock, getDisplayTimeZone } from '@/lib/format'
import { cn } from '@/lib/utils'

// Shared pieces of Settings → Storage, drawn to the "quiet · v1.1 storage &
// retention" boards (v1.1-01…29).

/** A 28px outline button (the boards' secondary action). */
export function OBtn({ className, ...p }: ComponentProps<typeof Button>) {
  return <Button variant="outline" size="sm" className={cn('h-7 px-3 font-normal text-xs', className)} {...p} />
}

/** A 28px filled button (the boards' primary action). */
export function PBtn({ className, ...p }: ComponentProps<typeof Button>) {
  return <Button size="sm" className={cn('h-7 px-3 font-normal text-xs', className)} {...p} />
}

/** The destructive dialog action: outlined in red. */
export function DBtn({ className, ...p }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'h-7 border-status-err bg-level-error-muted px-3 font-normal text-status-err text-xs hover:bg-level-error-muted/80 hover:text-status-err dark:border-status-err',
        className,
      )}
      {...p}
    />
  )
}

/** A mono tag: `Garage · local`, `Cloudflare R2`; `ok` greens it (Active). */
export function Tag({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <span
      className={cn(
        'inline-flex w-max shrink-0 items-center border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground leading-[14px]',
        tone === 'ok' && 'bg-row-selected text-status-ok',
        tone === 'warn' && 'text-status-warn',
        tone === 'err' && 'text-status-err',
      )}
    >
      {children}
    </span>
  )
}

/** A bordered card with an optional 40px header row. */
export function Card({
  title,
  aside,
  children,
  className,
  label,
}: {
  title?: ReactNode
  aside?: ReactNode
  children?: ReactNode
  className?: string
  label?: string
}) {
  return (
    <section aria-label={label} className={cn('flex flex-col border bg-card', className)}>
      {title != null && (
        <div className="flex min-h-10 items-center gap-3 border-b px-4 py-2">
          <h3 className="flex-1 font-medium text-[13px] leading-[18px]">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

/** A label / value row in a card (`Bucket  quiet-production`). */
export function KV({
  k,
  children,
  muted,
  width = 'w-[140px]',
  tone,
}: {
  k: ReactNode
  children: ReactNode
  muted?: boolean
  width?: string
  tone?: 'err'
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={cn('shrink-0 text-xs leading-[18px]', width)}>{k}</span>
      <span
        className={cn(
          'min-w-0 break-all font-mono text-xs leading-[18px]',
          muted && 'text-muted-foreground',
          tone === 'err' && 'text-level-error',
        )}
      >
        {children}
      </span>
    </div>
  )
}

/** A card row with a top border: `Pending data   143 MB · 14,280 events`. */
export function Row({ k, children, width = 'w-[200px]' }: { k: ReactNode; children: ReactNode; width?: string }) {
  return (
    <div className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0">
      <span className={cn('shrink-0 text-xs leading-[18px]', width)}>{k}</span>
      <span className="min-w-0 flex-1 break-words font-mono text-muted-foreground text-xs leading-[18px]">
        {children}
      </span>
    </div>
  )
}

const CALLOUT = {
  brand: 'bg-card border-l-brand',
  err: 'bg-level-error-muted border-l-status-err',
  warn: 'bg-level-warn-muted border-l-status-warn',
} as const

/** The boards' left-ruled note: brand (info), err, warn. */
export function Callout({
  tone = 'brand',
  title,
  children,
  action,
  role,
}: {
  tone?: keyof typeof CALLOUT
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  role?: 'alert' | 'status'
}) {
  return (
    <div role={role} className={cn('flex items-start gap-3 border-l-2 px-4 py-3.5', CALLOUT[tone])}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="font-medium text-[13px] leading-[18px]">{title}</p>
        {children && <div className="text-muted-foreground text-xs leading-[18px]">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 gap-3">{action}</div>}
    </div>
  )
}

/** Dot + text: `● Up to date`. */
export function StatusLine({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'idle'; children: ReactNode }) {
  return (
    <span className="flex items-center gap-3 text-xs leading-[18px]">
      <Dot tone={tone} />
      {children}
    </span>
  )
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'err' | 'idle' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        tone === 'ok' && 'bg-status-ok',
        tone === 'warn' && 'bg-status-warn',
        tone === 'err' && 'bg-status-err',
        tone === 'idle' && 'bg-status-idle',
      )}
    />
  )
}

/** An 8px meter (`bg-secondary` track). */
export function Meter({ ratio, tone, label }: { ratio: number; tone?: 'warn' | 'err'; label: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an 8px styled bar; <meter> cannot be styled to the board
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className="flex h-2 shrink-0 bg-secondary"
    >
      <div
        className={cn('h-2', tone === 'warn' ? 'bg-status-warn' : tone === 'err' ? 'bg-status-err' : 'bg-chart-1')}
        style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
      />
    </div>
  )
}

/** A form field: 12px label, 32px mono input on the card colour, hint. */
export function Field({
  label,
  hint,
  className,
  suffix,
  id,
  ...input
}: ComponentProps<'input'> & { label: ReactNode; hint?: ReactNode; suffix?: ReactNode }) {
  const auto = useId()
  const inputId = id ?? auto
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="font-medium text-xs leading-[18px]">
        {label}
      </label>
      <span className="flex h-8 items-center gap-3 border border-input bg-card px-2.5 focus-within:border-ring">
        <input
          id={inputId}
          aria-describedby={hint ? `${inputId}-hint` : undefined}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs leading-[18px] outline-none placeholder:text-muted-foreground"
          {...input}
        />
        {suffix}
      </span>
      {hint && (
        <span id={`${inputId}-hint`} className="text-muted-foreground text-xs leading-[18px]">
          {hint}
        </span>
      )}
    </div>
  )
}

/** Header for a storage screen: 20px title, subtitle, one action on the right. */
export function StorageHeader({ title, sub, action }: { title: ReactNode; sub: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h2 className="font-semibold text-xl leading-6 tracking-tight">{title}</h2>
        <p className="text-[13px] text-muted-foreground leading-[18px]">{sub}</p>
      </div>
      {action}
    </header>
  )
}

export const KIND_NAME: Record<DestinationKind, string> = {
  garage: 'Garage',
  r2: 'Cloudflare R2',
  s3: 'Amazon S3',
  s3_compatible: 'S3-compatible',
}

/** `R2`, `S3`, `Garage` — the short provider name in dialogs and tags. */
export const KIND_SHORT: Record<DestinationKind, string> = {
  garage: 'Garage',
  r2: 'R2',
  s3: 'S3',
  s3_compatible: 'S3-compatible',
}

/** Garage that quiet set up next to itself ("this host"). */
export const isLocalGarage = (d: Pick<Destination, 'kind' | 'name'>) => d.kind === 'garage' && d.name === 'garage-local'

/** What a connector is called on screen: the bootstrap Garage reads `Garage`. */
export const connectorName = (d: Pick<Destination, 'kind' | 'name'>) => (isLocalGarage(d) ? 'Garage' : d.name)

/** `Garage · local`, `production-r2 · R2`. */
export const connectorTag = (d: Destination) =>
  isLocalGarage(d) ? 'Garage · local' : `${d.name} · ${KIND_SHORT[d.kind]}`

/** `23.8 GB`, `100 GB`, `1.90 GB`, `143 MB`. */
export function fmtSize(b: number): string {
  if (b < 1e6) return `${Math.max(0, Math.round(b / 1e3))} KB`
  if (b < 1e9) return `${Math.round(b / 1e6)} MB`
  const g = b / 1e9
  return `${g >= 100 ? Math.round(g) : g >= 10 ? g.toFixed(1) : g.toFixed(2)} GB`
}

/** The display timezone for Intl (`local` means the browser's own). */
const zone = () => {
  const tz = getDisplayTimeZone()
  return tz && tz !== 'local' ? tz : undefined
}

/** A limit as set: `5 GB`, `100 GB`, `2.5 GB`. */
export function fmtLimit(b: number): string {
  return b >= 1e9 ? `${+(b / 1e9).toFixed(2)} GB` : fmtSize(b)
}

const parts = (ts: number) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone(),
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
      .formatToParts(ts)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>

/** `09 Nov`. */
export function fmtD(ts: number): string {
  const p = parts(ts)
  return `${p.day} ${p.month}`
}

/** `09 Nov 2026`. */
export function fmtDY(ts: number): string {
  const p = parts(ts)
  return `${p.day} ${p.month} ${p.year}`
}

/** `09 Nov 2026, 08:12`. */
export const fmtDYT = (ts: number) => `${fmtDY(ts)}, ${fmtClock(ts)}`

/** `21 Nov, 14:09`. */
export const fmtDT = (ts: number) => `${fmtD(ts)}, ${fmtClock(ts)}`

/** `09 Nov — now`, `09 Nov — 22 Nov, 14:07`. */
export function fmtRange(first: number, last: number | null, now = Date.now()): string {
  return `${fmtD(first)} — ${last == null || now - last < 2 * 3_600_000 ? 'now' : fmtDT(last)}`
}
