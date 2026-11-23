import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRightIcon, CheckIcon, CopyIcon, EyeOffIcon, PlusIcon } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { LogTable, type RowActions } from '@/components/stream/log-table'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { LogLine, SourceInfo } from '@/gen'
import type { ConnectKind } from '@/lib/connect'
import { fmtTime } from '@/lib/format'
import { copyPrompt, stackNow } from '@/lib/guide'
import { useSourceFields, useStreamStats } from '@/lib/stream-api'
import { useStream } from '@/lib/use-stream'
import { cn } from '@/lib/utils'

/** "HH:MM:SS" from a full stream time. */
const hms = (ts: number) => fmtTime(ts).slice(0, 8)

function Stat({
  label,
  value,
  sub,
  brand = false,
}: {
  label: string
  value: ReactNode
  sub: ReactNode
  brand?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border bg-card p-4">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{label}</span>
      <span className={cn('truncate font-mono text-2xl', brand && 'text-brand')}>{value}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
    </div>
  )
}

function Done({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 font-medium text-[13px] text-status-ok">
      <span className="flex size-5 items-center justify-center border border-status-ok">
        <CheckIcon className="size-3" />
      </span>
      {children}
    </span>
  )
}

const HEALTH = /(^|\/)(health|healthz|readyz|livez|ping|status)(\/|$)/

/** The most frequent health-check path among `lines`, if it is a real share of them. */
function noisyHealth(lines: LogLine[]): { path: string; count: number } | null {
  const counts = new Map<string, number>()
  for (const l of lines) {
    const p = l.fields?.path ?? l.fields?.url
    if (typeof p === 'string' && HEALTH.test(p.split('?')[0])) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  let best: { path: string; count: number } | null = null
  for (const [path, count] of counts) if (!best || count > best.count) best = { path, count }
  return best && best.count >= 3 ? best : null
}

/**
 * First lines arrived (02.4): what quiet found in them, the next step for the
 * app (11.6 C), and the lines streaming in.
 */
export function Live({
  kind,
  source,
  since,
  baseline,
  onAnother,
}: {
  kind: ConnectKind
  source: SourceInfo
  /** When the first line was seen. */
  since: number
  /** The source's line count before this connection, to count only new lines. */
  baseline: number
  onAnother: () => void
}) {
  const navigate = useNavigate()
  const name = source.name
  const stream = useStream({ source: name, max: 500 })
  const fields = useSourceFields(name).data
  const stats = useStreamStats(name, undefined).data
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const openStream = () => navigate({ to: '/', search: { source: name } })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || t?.closest('input,textarea,button,a,[role="row"]')) return
      e.preventDefault()
      navigate({ to: '/', search: { source: name } })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, name])

  const lines = stream.lines
  const first = lines[0]?.ts ?? source.last_ts ?? since
  const count = Math.max(lines.length, (stats?.total ?? source.lines) - baseline)
  const secs = Math.max(1, Math.round((now - first) / 1000))
  const rate = count / secs
  const json = fields && fields.sampled > 0 ? fields.json / fields.sampled : null
  const levels = stats?.levels
  const leveled = levels ? levels.debug + levels.info + levels.warn + levels.error : 0
  const id = useMemo(() => [...(fields?.ids ?? [])].sort((a, b) => b.coverage - a.coverage)[0], [fields])
  const keys = fields?.fields.map((f) => f.key) ?? []
  const health = useMemo(() => noisyHealth(lines), [lines])

  const actions: RowActions = {
    onSelect: () => openStream(),
    onOpenFlow: (l) =>
      l.display_id
        ? navigate({ to: '/flow/$id', params: { id: l.display_id.value }, search: { line: l.id } })
        : openStream(),
    onOpenDiagram: () => openStream(),
    onCopy: (l) => void navigator.clipboard.writeText(l.raw),
    onFilter: () => openStream(),
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 pt-7 pb-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-[28px] leading-[34px] tracking-tight">You're live.</h1>
        <p className="text-muted-foreground text-sm">
          Lines are flowing. Mute the noise now, or go straight to the stream.
        </p>
      </header>
      <div className="flex flex-wrap gap-6">
        <Done>{kind === 'docker' ? 'Docker readable' : 'Token created'}</Done>
        <Done>Flow ids picked</Done>
        <Done>First line received</Done>
      </div>

      <div className="flex items-center gap-3 border border-status-ok/50 bg-status-ok/5 p-4" role="status">
        <CheckIcon className="size-4 text-status-ok" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-sm">{name} is connected</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            first line {fmtTime(first)} · {count.toLocaleString()} lines in {secs}s
            {json != null && (json >= 0.5 ? ' · json ✓' : ' · plain text')}
            {levels && (leveled > 0 ? ' · levels ✓' : ' · no levels')}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={onAnother}>
          <PlusIcon /> Connect another
        </Button>
        <Button size="sm" onClick={openStream}>
          Open stream <ArrowRightIcon /> <Kbd>↵</Kbd>
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Rate" value={`${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s`} sub={`since ${hms(first)}`} />
        <Stat
          label="Correlation id"
          brand={!!id}
          value={id ? id.key : 'none yet'}
          sub={id ? `found on ${Math.round(id.coverage * 100)}% of lines` : 'no request_id or job_id seen'}
        />
        <Stat label="Fields detected" value={keys.length} sub={keys.slice(0, 6).join(', ') || '—'} />
        <Stat
          label="Levels"
          value={levels ? `${levels.info} · ${levels.warn} · ${levels.error}` : '—'}
          sub="info · warn · error"
        />
      </div>

      <section aria-label="Next: instrument your app" className="flex items-center gap-4 border bg-card p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-sm">Next: instrument your app</span>
          <span className="text-muted-foreground text-xs">
            Lines are arriving. For flows with timing, give your coding agent one prompt: one canonical line per request
            and job, with ids.
          </span>
        </div>
        <Button size="sm" onClick={() => void copyPrompt(stackNow())}>
          <CopyIcon /> Copy agent prompt
        </Button>
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={<Link to="/guide" search={{ tab: 'check', source: name }} />}
        >
          Check my logs
        </Button>
      </section>

      <div className="flex min-h-[360px] flex-1 flex-col">
        <div className="flex h-9 items-center gap-3">
          <span className="flex-1 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            First lines · live
          </span>
          {health && (
            <>
              <span className="text-muted-foreground text-xs">Noisy health checks:</span>
              <span className="font-mono text-xs">
                path:{health.path} · {health.count} lines
              </span>
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link to="/sources/$name" params={{ name }} search={{ edit: 'muted' }} />}
              >
                <EyeOffIcon /> Mute
              </Button>
            </>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <LogTable
            lines={lines}
            selectedId={null}
            expandedId={null}
            follow
            onFollow={() => {}}
            empty={<p className="p-4 text-muted-foreground text-xs">Waiting for the next line…</p>}
            loading={!stream.settled}
            actions={actions}
          />
        </div>
      </div>
    </div>
  )
}
