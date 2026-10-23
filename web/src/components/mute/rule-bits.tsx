import { GlobeIcon, LockIcon, MousePointer2Icon, PencilLineIcon, TriangleAlertIcon } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { LogLine, MutePreview, MuteRule, MuteShape } from '@/gen'
import { fmtRowTime } from '@/lib/format'
import { methodOf, pickRoute, rulePattern, SHAPE_LABEL } from '@/lib/mute'
import { cn } from '@/lib/utils'

/** Rules that hide more than this share of a source get a warning (06.17, 03.16). */
export const WARN_SHARE = 0.3
/** Deleting a rule that hides fewer lines a day than this needs no confirm (06.24 / 06.25). */
export const DELETE_CONFIRM_AT = 1000
/** Copy shared by every read-only view (03.18, 06.23, 07.18). */
export const OWNERS_ONLY = 'Only owners can edit muted lines'
export const OWNERS_ONLY_GLOBAL = 'Only owners can add global rules'

export const fmtN = (n: number) => n.toLocaleString('en-US')

/** `2h ago`, `yesterday`, `Oct 19`. */
export function fmtWhen(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return ''
  const d = now - ms
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  if (d < 2 * 86_400_000) return 'yesterday'
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** `Oct 21` always (the rule detail's Added card). */
export const fmtDay = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

export function ShapeChip({ shape }: { shape: MuteShape }) {
  return (
    <span className="shrink-0 border px-1.5 py-px font-mono text-[11px] text-foreground/80">{SHAPE_LABEL[shape]}</span>
  )
}

export function GlobalTag() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 bg-brand/15 px-1.5 py-px font-mono text-[11px] text-brand">
      <GlobeIcon className="size-3" aria-hidden />
      global
    </span>
  )
}

/** `path:` `/api/v1/health` in the rule's colours. */
export function Pattern({ rule, className }: { rule: MuteRule; className?: string }) {
  const p = rulePattern(rule)
  return (
    <span className={cn('min-w-0 truncate font-mono text-[13px]', className)} title={`${p.prefix}${p.value}`}>
      <span className="text-brand">{p.prefix}</span>
      <span className={rule.shape === 'route' || rule.shape === 'method_route' ? 'text-brand/90' : undefined}>
        {p.value}
      </span>
    </span>
  )
}

export function OriginNote({ rule }: { rule: MuteRule }) {
  return rule.origin === 'hover' ? (
    <span className="inline-flex items-center gap-1">
      <MousePointer2Icon className="size-3" aria-hidden /> from hover
    </span>
  ) : (
    <span className="inline-flex items-center gap-1">
      <PencilLineIcon className="size-3" aria-hidden /> manual
    </span>
  )
}

/** `kwaame · 2h ago · from hover` */
export function WhoWhen({ rule }: { rule: MuteRule }) {
  return (
    <>
      {rule.created_by && <span>{rule.created_by}</span>}
      {rule.created_at ? <span>{fmtWhen(rule.created_at)}</span> : null}
      <OriginNote rule={rule} />
    </>
  )
}

/** Dot-separated meta line under a rule. */
export function Meta({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-muted-foreground [&>*+*]:before:mr-1.5 [&>*+*]:before:content-["·"]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export interface SegOption<T extends string> {
  value: T
  label: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** Why it is disabled (shown on hover / focus). */
  reason?: string
}

/** A segmented radio group (scope switch, rule shape tabs, Inherit / On / Off). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
}: {
  value: T
  onChange: (v: T) => void
  options: SegOption<T>[]
  label: string
  className?: string
  size?: 'sm' | 'md'
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const live = options.filter((o) => !o.disabled)
    const i = live.findIndex((o) => o.value === value)
    const next = live[(i + (e.key === 'ArrowRight' ? 1 : live.length - 1)) % live.length]
    if (next) onChange(next.value)
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className={cn('flex w-full gap-px bg-muted/60 p-0.5', className)}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={o.disabled || undefined}
            title={o.disabled ? o.reason : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => !o.disabled && onChange(o.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3.5',
              size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
              on && 'bg-background text-foreground shadow-[inset_0_0_0_1px_var(--border)]',
              o.disabled && 'cursor-not-allowed opacity-50 hover:text-muted-foreground',
            )}
          >
            {o.disabled ? <LockIcon aria-hidden /> : o.icon}
            <span className={cn(on && 'font-medium')}>{o.label}</span>
            {o.sub && <span className="font-mono text-[11px] text-muted-foreground">{o.sub}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** A yellow warning box (06.17, 06.20). */
export function Warn({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div role="alert" className="flex gap-2.5 border border-status-warn/40 bg-status-warn/10 px-3 py-2.5">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-status-warn" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-sm">{title}</span>
        {children && <span className="text-muted-foreground text-xs">{children}</span>}
      </div>
    </div>
  )
}

/** Share of the lines in scope a preview hides (0 when nothing is known). */
export const shareOf = (p: MutePreview | undefined) => (p && p.lines > 0 ? p.total / p.lines : 0)
export const fmtShare = (x: number) => (x > 0 && x < 0.001 ? '<0.1%' : `${x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)}%`)

/** `about 13 a minute` over the 24h window. */
export function perMinute(n: number): string {
  const m = n / 1440
  if (m >= 1) return `about ${fmtN(Math.round(m))} a minute`
  const h = n / 24
  return h >= 1 ? `about ${fmtN(Math.round(h))} an hour` : 'a few a day'
}

/** One sample line in a preview: `14:07:21 GET /api/v1/health 200 · 2ms`. */
export function SampleLine({ line }: { line: LogLine }) {
  const f = (line.fields ?? {}) as Record<string, unknown>
  const route = pickRoute(line)
  const method = methodOf(line)
  const status = f.status ?? f.statusCode ?? (f.res as Record<string, unknown> | undefined)?.statusCode
  const dur = f.duration_ms ?? f.responseTime ?? f.duration
  return (
    <div className="flex min-w-0 gap-3 font-mono text-[11px] text-muted-foreground">
      <span className="shrink-0 tabular-nums">{fmtRowTime(line.ts)}</span>
      {route ? (
        <>
          {method && <span className="w-9 shrink-0">{method}</span>}
          <span className="min-w-0 truncate text-foreground/90">{route.raw.replace(/^[a-z]+:\/\/[^/]+/i, '')}</span>
          {status != null && <span className="shrink-0">{String(status)}</span>}
          {dur != null && <span className="shrink-0">· {String(dur)}ms</span>}
        </>
      ) : (
        <>
          {line.level && <span className="shrink-0">{line.level}</span>}
          <span className="min-w-0 truncate text-foreground/90">{line.msg}</span>
        </>
      )}
    </div>
  )
}

/** `GET 1,270 · HEAD 14 · ?v=2 ignored` under a route preview. */
export function MethodSplit({ p, from }: { p: MutePreview; from?: string | null }) {
  const parts: string[] = []
  if (from) parts.push(`from ${from}`)
  if (p.query_ignored > 0) parts.push('?query ignored')
  for (const m of p.by_method.slice(0, 4)) parts.push(`${m.method} ${fmtN(m.count)}`)
  if (!parts.length) return null
  return <div className="font-mono text-[11px] text-muted-foreground">{parts.join(' · ')}</div>
}

/** Per-source bars for a global rule (03.21, 07.13, 07.15). */
export function SourceBars({
  per,
  names,
  max,
  right,
}: {
  per: Record<string, number>
  names?: string[]
  max?: number
  right?: (source: string) => ReactNode
}) {
  const rows = (names ?? Object.keys(per)).map((s) => [s, per[s] ?? 0] as const)
  const top = max ?? Math.max(1, ...rows.map(([, n]) => n))
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map(([s, n]) => (
        <li key={s} className="grid grid-cols-[minmax(0,140px)_1fr_auto] items-center gap-3 font-mono text-[11px]">
          <span className="truncate">{s}</span>
          <span className="h-1.5 bg-muted">
            <span className="block h-full bg-brand" style={{ width: `${Math.round((n / top) * 100)}%` }} />
          </span>
          <span className="flex items-center gap-3 text-muted-foreground tabular-nums">
            {fmtN(n)}
            {right?.(s)}
          </span>
        </li>
      ))}
    </ul>
  )
}
