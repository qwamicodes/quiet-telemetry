import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  GaugeIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RowsIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { IdOrderEditor } from '@/components/settings/id-order'
import { Caps, Panel } from '@/components/settings/kit'
import { fmtSpan, PurgeDialog } from '@/components/settings/storage'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { Level, PiiKind, RemovedSource, SourceInfo, SourceSettings } from '@/gen'
import { fetchJson, useHealth, useSources } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { kindLabel } from '@/lib/connect'
import { fmtAgo, fmtBytes, fmtClock, fmtCount, fmtTime, fmtWindow, isRecent } from '@/lib/format'
import { parseMute } from '@/lib/mute'
import { searchResponse } from '@/lib/schemas'
import { toQuery } from '@/lib/search-api'
import {
  DEFAULT_SOURCE_SETTINGS,
  HOUR,
  PII_KINDS,
  PII_LABEL,
  useActivity,
  useRemoveSource,
  useResetSource,
  useSaveSource,
  useSettings,
  WINDOWS,
} from '@/lib/settings-api'
import { useSourceFields, useStreamStats } from '@/lib/stream-api'
import { toast } from '@/lib/toast'
import { useRestoreToken, useTokens } from '@/lib/tokens-api'
import { useRates } from '@/lib/use-rates'
import { cn } from '@/lib/utils'

const route = getRouteApi('/sources/$name')

export type SourceTab = 'overview' | 'rejected' | 'malformed' | 'settings'

/** `/sources/$name` (boards v0.1-06.2 / 06.5 / 06.6): overview, rejected requests, per-source settings. */
export function SourceDetailPage() {
  const { name } = route.useParams()
  const { tab = 'overview' } = route.useSearch()
  const navigate = route.useNavigate()
  const sources = useSources().data
  const settings = useSettings().data
  const activity = useActivity(name).data
  const info = sources?.find((s) => s.name === name)
  const saved = settings?.sources[name] ?? DEFAULT_SOURCE_SETTINGS
  const owner = isOwner(useMe())
  const save = useSaveSource(name)
  const live = isRecent(info?.last_ts ?? null)

  const togglePause = async () => {
    try {
      await save.mutateAsync({ ...saved, paused: !saved.paused })
      toast.success(saved.paused ? `Ingest resumed for ${name}` : `Ingest paused for ${name}`, {
        description: saved.paused
          ? 'New lines are stored again.'
          : 'New lines are dropped (and counted) until you resume.',
      })
    } catch (err) {
      toast.error('Could not change ingest', { description: (err as Error).message })
    }
  }

  const fields = useSourceFields(name).data
  const tabs: [SourceTab, string][] = [
    ['overview', 'Overview'],
    ['rejected', `Rejected ${activity ? fmtCount(activity.rejections.reduce((a, r) => a + r.count, 0)) : ''}`],
    ['malformed', `Malformed ${fields ? fmtCount(fields.malformed_total) : ''}`],
    ['settings', 'Settings'],
  ]

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      <nav className="flex items-center gap-3 text-sm">
        <Link to="/sources" className="flex items-center gap-1.5 hover:underline">
          <ArrowLeftIcon className="size-3.5" /> Sources
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-mono text-muted-foreground">{name}</span>
      </nav>
      <header className="flex items-center gap-3">
        <StatusDot status={saved.paused ? 'warn' : live ? 'ok' : 'idle'} />
        <h1 className="font-semibold text-2xl">{saved.display_name ?? name}</h1>
        {info && (
          <span className="border px-1.5 py-0.5 font-mono text-muted-foreground text-xs">{kindLabel(info.kind)}</span>
        )}
        {saved.paused ? (
          <span className="bg-status-warn/15 px-1.5 py-0.5 font-mono text-status-warn text-xs">paused</span>
        ) : live ? (
          <span className="bg-status-ok/15 px-1.5 py-0.5 font-mono text-status-ok text-xs">live</span>
        ) : null}
        {saved.hidden && (
          <span className="border border-dashed px-1.5 py-0.5 font-mono text-muted-foreground text-xs">hidden</span>
        )}
        <span className="flex-1" />
        <Link to="/guide" search={{ tab: 'check', source: name }}>
          <Button variant="ghost">
            <GaugeIcon /> Check logs
          </Button>
        </Link>
        <Button variant="outline" onClick={() => navigate({ search: { tab: 'settings' }, replace: true })}>
          <PencilIcon /> Edit
        </Button>
        {owner && (
          <Button variant="outline" onClick={togglePause} disabled={save.isPending}>
            {saved.paused ? <PlayIcon /> : <PauseIcon />} {saved.paused ? 'Resume ingest' : 'Pause ingest'}
          </Button>
        )}
        <Button nativeButton={false} render={<Link to="/" search={{ source: name }} />}>
          <RowsIcon /> Open stream
        </Button>
      </header>
      <div className="flex gap-1 border-b" role="tablist" aria-label="Source">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => navigate({ search: { tab: t === 'overview' ? undefined : t }, replace: true })}
            className={cn(
              '-mb-px border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm hover:text-foreground',
              tab === t && 'border-foreground text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {saved.paused && (
        <div role="status" className="border border-status-warn/40 bg-status-warn/10 px-4 py-2.5 text-sm">
          Ingest is paused: new lines from {name} are dropped
          {activity ? ` (${fmtCount(activity.paused_dropped)} since the server started)` : ''}. Stored lines stay until
          they expire.
        </div>
      )}
      {tab === 'overview' && <Overview info={info} name={name} saved={saved} owner={owner} />}
      {tab === 'rejected' && <Rejected name={name} info={info} />}
      {tab === 'malformed' && <MalformedPanel name={name} />}
      {tab === 'settings' && settings && (
        <SourceSettingsForm
          key={JSON.stringify(saved)}
          name={name}
          saved={saved}
          globalOrder={settings.flow_ids.order}
          globalRetention={settings.storage.retention_ms}
        />
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-1 flex-col gap-1 border bg-card px-4 py-3.5">
      <Caps>{label}</Caps>
      <span className="font-mono text-2xl">{value}</span>
      {sub && <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  )
}

const fmtPct = (v: number) => (v === 0 ? '0%' : v < 0.1 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`)
const fmtRate = (r: number | undefined) =>
  r == null ? '—' : `${r < 10 ? r.toFixed(1).replace(/\.0$/, '') : Math.round(r)}/s`

/** Lines per 15 minutes over the window, stacked by level (design 06.2). */
function useDayHistogram(name: string, windowMs: number) {
  const until = Math.ceil(Date.now() / 60_000) * 60_000
  const since = until - windowMs
  const buckets = Math.min(240, Math.max(24, Math.round(windowMs / (15 * 60_000))))
  return useQuery({
    queryKey: ['source-histogram', name, until, windowMs],
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: ({ signal }) =>
      fetchJson(`/api/search?${toQuery({ source: name, since, until, limit: 1, buckets })}`, searchResponse, {
        signal,
      }),
  })
}

export function DayHistogram({ name, windowMs }: { name: string; windowMs: number }) {
  const r = useDayHistogram(name, windowMs).data
  const h = r?.histogram ?? []
  const max = Math.max(1, ...h.map((b) => b.count))
  const span = r ? r.until - r.since : windowMs
  const ticks = r ? [0.25, 0.5, 0.75].map((f) => r.since + span * f) : []
  return (
    <section className="flex flex-col gap-2 border bg-card px-4 py-3" aria-label="Lines per 15 minutes">
      <div className="flex items-center justify-between">
        <Caps>Lines per 15 min · {fmtWindow(windowMs)}</Caps>
        <span className="flex gap-3 font-mono text-[11px] text-muted-foreground">
          <span>info</span>
          <span className="text-status-warn">warn</span>
          <span className="text-status-err">error</span>
        </span>
      </div>
      <div className="flex h-12 items-end gap-px">
        {r
          ? h.map((b, i) => {
              const info = b.count - b.warn - b.error
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position buckets
                  key={i}
                  data-testid="day-bar"
                  title={`${fmtClock(b.start)} · ${fmtCount(b.count)} lines`}
                  className="flex flex-1 flex-col-reverse"
                  style={{ height: b.count ? `${Math.max(6, (b.count / max) * 100)}%` : 0 }}
                >
                  <span className="bg-chart-1" style={{ flexGrow: info }} />
                  <span className="bg-chart-3" style={{ flexGrow: b.warn }} />
                  <span className="bg-chart-2" style={{ flexGrow: b.error }} />
                </span>
              )
            })
          : null}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{r ? `${span >= 86_400_000 ? 'yesterday ' : ''}${fmtClock(r.since)}` : ''}</span>
        {ticks.map((t) => (
          <span key={t}>{fmtClock(t)}</span>
        ))}
        <span>now</span>
      </div>
    </section>
  )
}

function Overview({
  info,
  name,
  saved,
  owner,
}: {
  info?: SourceInfo
  name: string
  saved: SourceSettings
  owner: boolean
}) {
  const settings = useSettings().data
  const health = useHealth().data
  const sources = useSources().data
  const rate = useRates(sources)[name]
  const stats = useStreamStats(name, undefined).data
  const fields = useSourceFields(name).data
  const [removing, setRemoving] = useState(false)
  // The sources list still loading is not "no line yet".
  if (!info)
    return <p className="text-muted-foreground">{sources ? `No line from ${name} yet.` : 'Loading…'}</p>
  const order = saved.id_keys ?? settings?.flow_ids.order ?? []
  const windowMs = saved.retention_ms ?? settings?.storage.retention_ms ?? health?.retention_ms ?? 24 * HOUR
  const total = stats?.total ?? info.lines
  const coverage = new Map((fields?.ids ?? []).map((c) => [c.key, c.coverage]))
  const shownId = order.find((k) => (coverage.get(k) ?? 0) > 0)
  const second = order.find((k) => k !== shownId && (coverage.get(k) ?? 0) > 0)
  const hourAvg = stats ? stats.histogram.reduce((n, b) => n + b.count, 0) / 3600 : null
  const peak = stats ? Math.max(0, ...stats.histogram.map((b) => b.count)) / 60 : null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Stat
          label="Rate"
          value={isRecent(info.last_ts) ? fmtRate(rate) : 'off'}
          sub={hourAvg != null && peak != null ? `avg ${fmtRate(hourAvg)} · peak ${fmtRate(peak)} (1h)` : undefined}
        />
        <Stat
          label="Last line"
          value={info.last_ts ? fmtAgo(info.last_ts) : '—'}
          sub={info.last_ts ? fmtTime(info.last_ts) : undefined}
        />
        <Stat
          label={`Lines ${fmtWindow(windowMs)}`}
          value={fmtCount(total)}
          sub={
            stats && total
              ? `${fmtPct(stats.levels.error / total)} errors · ${fmtPct(stats.levels.warn / total)} warn`
              : undefined
          }
        />
        <div className="flex flex-1 flex-col gap-1 border bg-card px-4 py-3.5">
          <Caps>Flow id</Caps>
          <span className={cn('font-mono text-2xl', shownId ? 'text-brand' : 'text-muted-foreground')}>
            {shownId ?? (fields ? 'none found' : '…')}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {shownId ? `on ${fmtPct(coverage.get(shownId) ?? 0)} of lines` : 'no id key on its lines'}
          </span>
        </div>
      </div>

      <DayHistogram name={name} windowMs={windowMs} />

      <div className="grid grid-cols-[1fr_360px] items-start gap-4">
        <Panel
          title="Fields detected"
          aside={fields ? `${fields.fields.length} fields · from the last ${fmtCount(fields.sampled)} lines` : ''}
        >
          {!fields ? (
            <p className="px-4 py-6 text-muted-foreground text-sm">Reading recent lines…</p>
          ) : fields.fields.length === 0 ? (
            <p className="px-4 py-6 text-muted-foreground text-sm">
              No JSON fields in the last {fmtCount(fields.sampled)} lines: they are kept as raw text.
            </p>
          ) : (
            <table className="w-full font-mono text-xs">
              <tbody>
                {fields.fields.map((f) => (
                  <tr key={f.key} className="h-7 border-border/60 border-b last:border-b-0">
                    <td className="max-w-48 truncate px-4 text-brand">{f.key}</td>
                    <td className="w-14 text-muted-foreground">{f.kind}</td>
                    <td className="w-32">
                      <span className="flex items-center gap-2">
                        <span className="h-1 w-12 bg-muted">
                          <span className="block h-full bg-brand" style={{ width: `${f.coverage * 100}%` }} />
                        </span>
                        <span className="text-muted-foreground">{fmtPct(f.coverage)}</span>
                      </span>
                    </td>
                    <td className="max-w-64 truncate pr-4">{f.sample}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Flow id detected" aside={saved.id_keys ? 'source order' : 'default order'}>
            <p className="px-4 pt-3 text-muted-foreground text-xs">
              {shownId
                ? `${shownId} is on ${fmtPct(coverage.get(shownId) ?? 0)} of lines, so flows stitch by it.${second ? ` ${second} links other lines in.` : ''}`
                : 'None of the id keys appear on its lines, so each line opens as a one-node flow.'}
            </p>
            <ol className="px-4 py-2 font-mono text-xs">
              {order.map((k, i) => (
                <li key={k} className="flex h-7 items-center gap-3 border-border/60 border-b last:border-b-0">
                  <span className="w-3 text-muted-foreground">{i + 1}</span>
                  <span className={cn('flex-1', (coverage.get(k) ?? 0) > 0 ? 'text-brand' : 'text-muted-foreground')}>
                    {k}
                  </span>
                  <span className="text-muted-foreground">{fields ? fmtPct(coverage.get(k) ?? 0) : ''}</span>
                  {k === shownId ? (
                    <CheckIcon className="size-3.5 text-status-ok" aria-label="used" />
                  ) : (
                    <span className="size-3.5" />
                  )}
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Connection">
            <dl className="grid grid-cols-[6rem_1fr] gap-y-2 px-4 py-3 font-mono text-xs">
              <dt className="text-brand">via</dt>
              <dd>{info.kind === 'docker' ? 'docker.sock · this host' : kindLabel(info.kind)}</dd>
              {info.containers.length > 0 && (
                <>
                  <dt className="text-brand">container</dt>
                  <dd className="truncate">{info.containers.join(', ')}</dd>
                </>
              )}
              {info.group && (
                <>
                  <dt className="text-brand">service</dt>
                  <dd>{info.group}</dd>
                </>
              )}
            </dl>
          </Panel>

          {owner && (
            <section className="flex items-center gap-3 border border-status-err/40 px-4 py-3">
              <div className="flex flex-1 flex-col">
                <span className="font-medium text-sm">Remove source</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  stops ingest · deletes {fmtCount(total)} lines
                </span>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setRemoving(true)}>
                <Trash2Icon /> Remove
              </Button>
            </section>
          )}
        </div>
      </div>
      {removing && <RemoveSourceDialog name={name} lines={total} onClose={() => setRemoving(false)} />}
    </div>
  )
}

/**
 * Type-to-confirm remove (design 06.4), one server step: pauses ingest (new
 * lines are dropped), hides it, purges its stored lines and, with the switch
 * on (the default when it has one), revokes the ingest tokens bound to it.
 * The toast's Undo (like a token revoke's) restores the tokens and the
 * source's settings within a minute; deleted lines stay deleted.
 */
export function RemoveSourceDialog({ name, lines, onClose }: { name: string; lines: number; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const remove = useRemoveSource(name)
  const save = useSaveSource(name)
  const restore = useRestoreToken()
  const tokens = useTokens().data
  const bound = (tokens ?? []).filter((t) => t.revoked == null && t.source === name)
  const [revoke, setRevoke] = useState(true)
  const navigate = useNavigate()
  const undo = async (r: RemovedSource) => {
    try {
      for (const t of r.revoked) await restore.mutateAsync(t.id)
      await save.mutateAsync(r.previous)
      toast.success(`${name} is back`, {
        description: `${r.revoked.length ? 'Its token works again and new' : 'New'} lines are stored again. Deleted lines stay deleted.`,
      })
    } catch (err) {
      toast.error('Could not undo', { description: (err as Error).message })
    }
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (typed.trim() !== name) return
    try {
      const r = await remove.mutateAsync({ confirm: name, revoke_tokens: revoke && bound.length > 0 })
      const revokedText = r.revoked.length
        ? ` · ${r.revoked.length === 1 ? `token ${r.revoked[0].preview}` : `${r.revoked.length} tokens`} revoked`
        : ''
      toast.success(`Removed ${name}`, {
        description: `${fmtCount(r.lines)} stored lines deleted${revokedText}; new lines are dropped.`,
        duration: 15_000,
        button: { title: 'Undo', onClick: () => undo(r) },
      })
      onClose()
      navigate({ to: '/sources' })
    } catch (err) {
      toast.error('Could not remove the source', { description: (err as Error).message })
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Remove {name}?</DialogTitle>
            <DialogDescription>
              quiet stops accepting lines from {name} and deletes its {fmtCount(lines)} stored lines. Flows that include
              them will show as partial.{' '}
              {bound.length > 0 ? (
                'The exporter keeps running until you revoke its token.'
              ) : (
                <>
                  A sender using an any-source token keeps running until you revoke it in{' '}
                  <Link to="/settings/ingest-tokens" className="text-brand hover:underline">
                    Ingest tokens
                  </Link>
                  .
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5 text-xs">
            <label htmlFor="confirm-remove">
              Type <code className="font-mono text-foreground">{name}</code> to confirm
            </label>
            <Input
              id="confirm-remove"
              aria-label="Confirm remove"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </div>
          {bound.length > 0 && (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Switch inside is the control
            <label className="flex items-center gap-2.5 text-sm">
              <Switch aria-label="Also revoke its token" checked={revoke} onCheckedChange={setRevoke} />
              <span>
                Also revoke {bound.length === 1 ? 'its token' : `its ${bound.length} tokens`}{' '}
                <span className="font-mono text-muted-foreground text-xs">
                  {bound.map((t) => t.preview).join(', ')}
                </span>
              </span>
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={typed.trim() !== name || remove.isPending}>
              <Trash2Icon /> Remove source
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MalformedRows({ name, max }: { name: string; max?: number }) {
  const f = useSourceFields(name).data
  if (!f) return <p className="px-4 py-6 text-muted-foreground text-sm">Loading…</p>
  const rows = max ? f.malformed.slice(0, max) : f.malformed
  if (rows.length === 0)
    return <p className="px-4 py-6 text-center text-muted-foreground text-sm">No malformed lines from {name}.</p>
  return (
    <ul>
      {rows.map((m) => (
        <li key={m.id} className="border-border/60 border-b last:border-b-0">
          <Link
            to="/line/$lineId"
            params={{ lineId: m.id }}
            className="flex h-8 items-center gap-3 px-4 font-mono text-xs hover:bg-row-hover"
          >
            <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{fmtClock(m.ts)}</span>
            <span
              className={cn(
                'shrink-0 px-1.5',
                m.reason.startsWith('duplicate')
                  ? 'border text-muted-foreground'
                  : 'bg-status-warn/15 text-status-warn',
              )}
            >
              {m.reason}
              {m.reason === 'truncated' ? ` · ${fmtBytes(m.raw.length)}` : ''}
            </span>
            <span className="min-w-0 flex-1 truncate">{m.raw}</span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

function MalformedPanel({ name }: { name: string }) {
  const f = useSourceFields(name).data
  return (
    <Panel
      title="Malformed lines"
      aside={`kept as raw text, shown in the stream as raw rows${f ? ` · ${fmtCount(f.malformed_total)} in the window, newest ${f.malformed.length} here` : ''}`}
    >
      <MalformedRows name={name} />
    </Panel>
  )
}

function Rejected({ name, info }: { name: string; info?: SourceInfo }) {
  const a = useActivity(name).data
  const f = useSourceFields(name).data
  const stats = useStreamStats(name, undefined).data
  const sources = useSources().data
  const rate = useRates(sources)[name]
  const navigate = route.useNavigate()
  if (!a) return <p className="text-muted-foreground">Loading…</p>
  const total = stats?.total ?? info?.lines ?? 0
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Stat
          label="Accepted"
          value={isRecent(info?.last_ts ?? null) ? fmtRate(rate) : '0/s'}
          sub={info?.last_ts ? `last good line ${fmtClock(info.last_ts)}` : 'no line yet'}
        />
        <Stat
          label="Rejected 15 min"
          value={fmtCount(a.rejected_15m)}
          sub={`~${(a.rejected_15m / 900).toFixed(2)} req/s`}
        />
        <Stat
          label={`Malformed ${fmtWindow(health24(stats))}`}
          value={f ? fmtCount(f.malformed_total) : '…'}
          sub={f && total ? `${fmtPct(f.malformed_total / total)} · kept as raw text` : 'kept as raw text'}
        />
        <Stat label={`Lines ${fmtWindow(health24(stats))}`} value={fmtCount(total)} sub="stored" />
      </div>
      <Panel title="Rejected requests" aside="grouped per minute · bodies are not stored · last 24h">
        {a.rejections.length === 0 ? (
          <p className="px-4 py-6 text-center text-muted-foreground text-sm">
            Nothing refused for {name}. Requests that name this source (token or X-Quiet-Source) show up here.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                {['Time', 'Status', 'Reason', 'Endpoint', 'Token', 'Count'].map((h) => (
                  <th key={h} className="px-4 py-2 font-normal">
                    <Caps>{h}</Caps>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.rejections.map((r) => (
                <tr key={`${r.minute}-${r.status}-${r.reason}-${r.token}`} className="border-b last:border-b-0">
                  <td className="px-4 py-2 font-mono">{fmtClock(r.minute)}</td>
                  <td className="px-4 py-2">
                    <span
                      className={cn(
                        'px-1.5 font-mono text-xs',
                        r.status === 401 || r.status >= 500
                          ? 'bg-status-err/15 text-status-err'
                          : 'bg-status-warn/15 text-status-warn',
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">{r.reason}</td>
                  <td className="px-4 py-2 font-mono text-muted-foreground text-xs">/{r.endpoint}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {r.token ?? <span className="text-status-warn">missing</span>}
                  </td>
                  <td className="px-4 py-2 font-mono">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel
        title="Malformed lines"
        aside={
          <span className="flex items-center gap-3">
            kept as raw text, shown in the stream as raw rows
            {f && f.malformed_total > 4 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => navigate({ search: { tab: 'malformed' }, replace: true })}
              >
                View all {fmtCount(f.malformed_total)}
                <ChevronRightIcon />
              </Button>
            )}
          </span>
        }
      >
        <MalformedRows name={name} max={4} />
      </Panel>
    </div>
  )
}

const health24 = (stats: { since: number; until: number } | undefined) =>
  stats ? stats.until - stats.since : 24 * HOUR

const LEVELS: (Level | 'all')[] = ['all', 'debug', 'info', 'warn', 'error']

export function SourceSettingsForm({
  name,
  saved,
  globalOrder,
  globalRetention,
}: {
  name: string
  saved: SourceSettings
  globalOrder: SourceSettings['id_keys'] & {}
  globalRetention: number
}) {
  const owner = isOwner(useMe())
  const save = useSaveSource(name)
  const reset = useResetSource(name)
  const [draft, setDraft] = useState<SourceSettings>(saved)
  const [field, setField] = useState('')
  const [mute, setMute] = useState('')
  const [purging, setPurging] = useState(false)
  // Settings → General's choice, what "Inherit" means here.
  const instanceIncludesMuted = useSettings().data?.muted_search.include ?? false
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const set = (p: Partial<SourceSettings>) => setDraft({ ...draft, ...p })
  const windows = WINDOWS.filter((w) => w.ms <= globalRetention)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    try {
      await save.mutateAsync({ ...draft, display_name: draft.display_name?.trim() || null })
      toast.success(`Settings saved for ${name}`)
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }
  const addField = () => {
    const f = field.trim()
    if (!f || draft.mask_fields.includes(f)) return
    set({ mask_fields: [...draft.mask_fields, f] })
    setField('')
  }
  const addMute = () => {
    const r = parseMute(mute)
    if (!r) return
    if (!draft.muted.some((x) => x.field === r.field && x.value === r.value)) set({ muted: [...draft.muted, r] })
    setMute('')
  }
  const toggleMask = (k: PiiKind, on: boolean) =>
    set({ unmasked: on ? draft.unmasked.filter((x) => x !== k) : [...draft.unmasked, k] })

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label={`Settings for ${name}`}>
      <fieldset disabled={!owner} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Panel title="Identity">
            <div className="flex flex-col gap-2 p-4">
              <label htmlFor="display-name" className="text-sm">
                Display name
              </label>
              <Input
                id="display-name"
                placeholder={name}
                value={draft.display_name ?? ''}
                maxLength={64}
                onChange={(e) => set({ display_name: e.target.value || null })}
              />
              <span className="text-muted-foreground text-xs">
                Shown in the sidebar, stream and flows. Stored lines keep the original name ({name}).
              </span>
              <div className="mt-2 flex items-center justify-between gap-4 text-sm">
                <span className="flex flex-col">
                  <span>Hide from the sidebar</span>
                  <span className="text-muted-foreground text-xs">
                    Still stored, searchable and listed under Sources.
                  </span>
                </span>
                <Switch
                  aria-label="Hide from the sidebar"
                  checked={draft.hidden}
                  onCheckedChange={(v) => set({ hidden: v })}
                />
              </div>
            </div>
          </Panel>
          <Panel
            title="Correlation id order"
            aside={
              draft.id_keys ? (
                <button type="button" className="underline" onClick={() => set({ id_keys: null })}>
                  Reset to instance order
                </button>
              ) : (
                'instance order'
              )
            }
          >
            <div className="flex flex-col gap-2 p-4">
              <IdOrderEditor
                value={draft.id_keys ?? globalOrder}
                onChange={(id_keys) => set({ id_keys })}
                disabled={!owner}
              />
              <span className="text-muted-foreground text-xs">
                The first id found is the one a row shows; every id still counted links the line into flows. Keys you
                remove are ignored for this source (new lines, rows, stitching).
              </span>
            </div>
          </Panel>
          <Panel title="Muted lines" aside={draft.muted.length ? `${draft.muted.length} rules` : undefined}>
            <div className="flex flex-col gap-2 p-4">
              <ul aria-label="Muted lines" className="flex flex-wrap items-center gap-1.5">
                {draft.muted.map((r) => (
                  <li
                    key={`${r.field ?? ''}\u0000${r.value}`}
                    className="flex items-center gap-1 border bg-brand/10 px-1.5 py-0.5 font-mono text-xs"
                  >
                    {r.field ? (
                      <>
                        <span className="text-brand">{r.field}</span>
                        <span className="text-muted-foreground">:</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">text</span>
                    )}
                    <span>{r.value}</span>
                    <button
                      type="button"
                      aria-label={`Unmute ${r.field ? `${r.field}:` : ''}${r.value}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => set({ muted: draft.muted.filter((x) => x !== r) })}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </li>
                ))}
                <li className="flex items-center gap-1.5">
                  <Input
                    aria-label="Mute lines matching"
                    placeholder="path:/api/v1/health or text"
                    className="h-7 w-56 font-mono text-xs"
                    value={mute}
                    onChange={(e) => setMute(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addMute()
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Add muted rule"
                    onClick={addMute}
                    disabled={!mute.trim()}
                  >
                    <PlusIcon /> Add
                  </Button>
                </li>
              </ul>
              <span className="text-muted-foreground text-xs">
                Muted lines are still stored and searchable, just hidden from the stream (and from search unless
                included below) until you click Show muted. <code className="font-mono">field:value</code> matches a
                field (<code>*</code> for any run of characters); anything else matches text in the line.
              </span>
              <div className="flex items-center justify-between gap-4 border-t pt-3 text-sm">
                <span className="flex flex-col">
                  <span>Include muted lines in search</span>
                  <span className="text-muted-foreground text-xs">
                    Shown dimmed and tagged <span className="border px-1 font-mono text-[10px]">muted</span>. The stream
                    still hides them.
                  </span>
                </span>
                <Select
                  value={draft.search_include_muted == null ? 'inherit' : draft.search_include_muted ? 'on' : 'off'}
                  onValueChange={(v) => set({ search_include_muted: v === 'on' ? true : v === 'off' ? false : null })}
                  disabled={!owner}
                >
                  <SelectTrigger aria-label="Include muted lines in search" size="sm" className="w-44">
                    <SelectValue>
                      {(v: string) =>
                        v === 'inherit'
                          ? `Inherit · ${instanceIncludesMuted ? 'on' : 'off'}`
                          : v === 'on'
                            ? 'On'
                            : 'Off'
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Inherit · {instanceIncludesMuted ? 'on' : 'off'}</SelectItem>
                    <SelectItem value="on">On</SelectItem>
                    <SelectItem value="off">Off</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Panel>
          <Panel title="Stream & retention">
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="flex flex-col">
                  <span>Default level filter</span>
                  <span className="text-muted-foreground text-xs">The stream opens on this source with it set.</span>
                </span>
                <Select
                  value={draft.default_level ?? 'all'}
                  onValueChange={(v) => set({ default_level: !v || v === 'all' ? null : (v as Level) })}
                  disabled={!owner}
                >
                  <SelectTrigger aria-label="Default level filter" size="sm" className="w-32">
                    <SelectValue>{(v: string) => (v === 'all' ? 'all levels' : `${v} and above`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l === 'all' ? 'all levels' : `${l} and above`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="flex flex-col">
                  <span>Keep lines for</span>
                  <span className="text-muted-foreground text-xs">
                    Never longer than the instance window ({fmtWindow(globalRetention)}).
                  </span>
                </span>
                <Select
                  value={draft.retention_ms == null ? 'instance' : String(draft.retention_ms)}
                  onValueChange={(v) => set({ retention_ms: !v || v === 'instance' ? null : Number(v) })}
                  disabled={!owner}
                >
                  <SelectTrigger aria-label="Keep lines for" size="sm" className="w-32">
                    <SelectValue>
                      {(v: string) =>
                        v === 'instance' ? `instance (${fmtWindow(globalRetention)})` : fmtSpan(Number(v))
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="instance">instance ({fmtWindow(globalRetention)})</SelectItem>
                    {[HOUR * 6, ...windows.map((w) => w.ms)]
                      .filter((ms, i, xs) => ms < globalRetention && xs.indexOf(ms) === i)
                      .sort((a, b) => a - b)
                      .map((ms) => (
                        <SelectItem key={ms} value={String(ms)}>
                          {fmtSpan(ms)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Panel>
        </div>
        <div className="flex flex-col gap-4">
          <Panel title="Mask personal data" aside="owner only">
            <div className="flex flex-col p-4">
              <span className="pb-2 text-muted-foreground text-xs">
                Masked in exports from this source (and always for members). Lines are stored as received.
              </span>
              {PII_KINDS.map((k) => {
                const on = !draft.unmasked.includes(k)
                return (
                  <div key={k} className="flex items-center gap-3 border-b py-2.5">
                    <span className="flex flex-1 flex-col">
                      <span className="font-mono text-sm">
                        {PII_LABEL[k].label} <span className="text-muted-foreground">→ {PII_LABEL[k].sample}</span>
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{PII_LABEL[k].keys}</span>
                    </span>
                    <span className="font-mono text-muted-foreground text-xs">{on ? 'masked' : 'shown'}</span>
                    <Switch aria-label={`Mask ${k}`} checked={on} onCheckedChange={(v) => toggleMask(k, v)} />
                  </div>
                )
              })}
              {draft.mask_fields.map((f) => (
                <div key={f} className="flex items-center gap-3 border-b py-2.5">
                  <span className="flex-1 font-mono text-sm">{f}</span>
                  <span className="font-mono text-muted-foreground text-xs">masked</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Stop masking ${f}`}
                    onClick={() => set({ mask_fields: draft.mask_fields.filter((x) => x !== f) })}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2 pt-3">
                <Input
                  aria-label="Mask another field"
                  placeholder="Mask another field, e.g. customer.address"
                  className="font-mono text-xs"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addField()
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addField} disabled={!field.trim()}>
                  <PlusIcon /> Add
                </Button>
              </div>
            </div>
          </Panel>
          <Panel className="border-status-warn/40">
            <div className="flex items-center justify-between gap-4 p-4 text-sm">
              <span className="flex flex-col">
                <span className="font-medium">Pause ingest</span>
                <span className="text-muted-foreground text-xs">
                  Stop storing new lines from this source. Lines already stored expire with the window. Undo anytime.
                </span>
              </span>
              <Switch aria-label="Pause ingest" checked={draft.paused} onCheckedChange={(v) => set({ paused: v })} />
            </div>
          </Panel>
          {owner && (
            <Panel className="border-destructive/40">
              <div className="flex items-center justify-between gap-4 p-4 text-sm">
                <span className="flex flex-col">
                  <span className="font-medium">Purge this source's lines</span>
                  <span className="text-muted-foreground text-xs">Deletes every stored line of {name} now.</span>
                </span>
                <Button type="button" variant="destructive" onClick={() => setPurging(true)}>
                  <Trash2Icon /> Purge
                </Button>
              </div>
            </Panel>
          )}
        </div>
      </fieldset>
      {owner && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              try {
                await reset.mutateAsync()
                toast.success(`${name} follows the instance settings again`)
              } catch (err) {
                toast.error('Could not reset', { description: (err as Error).message })
              }
            }}
          >
            Reset all
          </Button>
          <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            Save changes
          </Button>
        </div>
      )}
      <PurgeDialog open={purging} onOpenChange={setPurging} source={name} />
    </form>
  )
}
