import { StatusDot } from '@/components/status-dot'
import type { SettingsResponse } from '@/gen'
import { useSources } from '@/lib/api'
import { kindLabel } from '@/lib/connect'
import { isRecent } from '@/lib/format'
import { globalOff } from '@/lib/mute'
import { fmtDay, fmtN } from './rule-bits'

export type OffHere = NonNullable<ReturnType<typeof globalOff>>

/** Sources that switched a global rule off ("Don't apply here"), with who and when. */
export function offOn(data: SettingsResponse | undefined, id: string): (readonly [string, OffHere])[] {
  return Object.entries(data?.sources ?? {})
    .map(([name, s]) => [name, globalOff(s, id)] as const)
    .filter((x): x is readonly [string, OffHere] => Boolean(x[1]))
}

/**
 * Hits by source · 24h (07.15, 07.16): every source with its kind, a bar and
 * the count; where the global rule is off, what it would hide and who
 * switched it off.
 */
export function HitsBySource({ hits, off }: { hits: Record<string, number>; off: ReadonlyMap<string, OffHere> }) {
  const sources = useSources().data
  const names = Array.from(new Set([...(sources ?? []).map((s) => s.name), ...Object.keys(hits)]))
  names.sort((a, b) => (hits[b] ?? 0) - (hits[a] ?? 0) || a.localeCompare(b))
  const max = Math.max(1, ...Object.values(hits))
  return (
    <>
      <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
        <span className="uppercase tracking-[0.06em]">Hits by source · 24h</span>
        <span>{names.length} sources</span>
      </div>
      <ul className="flex flex-col divide-y border-y" aria-label="Hits by source">
        {names.map((n) => {
          const info = sources?.find((s) => s.name === n)
          const o = off.get(n)
          const c = hits[n] ?? 0
          return (
            <li key={n} className="flex flex-col gap-0.5 py-2">
              <div className="grid grid-cols-[minmax(0,1fr)_72px_64px_auto_72px] items-center gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot status={info && isRecent(info.last_ts) ? 'ok' : 'idle'} />
                  <span className="truncate">{n}</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{info ? kindLabel(info.kind) : ''}</span>
                <span className="h-1.5 bg-muted">
                  <span
                    className={o ? 'block h-full bg-muted-foreground' : 'block h-full bg-brand'}
                    style={{ width: `${Math.round((c / max) * 100)}%` }}
                  />
                </span>
                <span className="text-right font-mono tabular-nums">{o ? `would hide ${fmtN(c)}` : fmtN(c)}</span>
                <span
                  className={
                    o
                      ? 'text-right font-mono text-[11px] text-status-warn'
                      : 'text-right font-mono text-[11px] text-muted-foreground'
                  }
                >
                  {o ? 'off here' : 'applies'}
                </span>
              </div>
              {o && (
                <span className="pl-4 font-mono text-[11px] text-muted-foreground">
                  Don't apply here{o.by ? ` · ${o.by}` : ''}
                  {o.at ? ` · ${fmtDay(o.at)}` : ''}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-muted-foreground text-xs">
        Turning a rule off here is per source: owners do it from Sources → edit → Muted lines. New sources get every
        global rule.
      </p>
    </>
  )
}
