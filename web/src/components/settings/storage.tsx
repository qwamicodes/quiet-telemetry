import { AlertTriangleIcon, Trash2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Caps, PageHeader, Panel, ReadOnlyNote, SettingRow } from '@/components/settings/kit'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { StorageReport } from '@/gen'
import { useSources } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { kindLabel } from '@/lib/connect'
import { fmtBytes, fmtClock, fmtCount, fmtDay, fmtWindow } from '@/lib/format'
import {
  HOUR,
  ORIGIN_LABEL,
  usePurge,
  useSaveStorage,
  useSettings,
  useStorage,
  useSystem,
  WINDOWS,
} from '@/lib/settings-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const NEAR = 0.9

/** `2d 13h`, `24h`, `40m`. */
export function fmtSpan(ms: number): string {
  const h = Math.floor(ms / HOUR)
  if (h >= 48) return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h / 24}d`
  if (h >= 1) return `${h}h`
  return `${Math.max(1, Math.floor(ms / 60_000))}m`
}

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : fmtBytes(b))

/** The hourly partitions across the window: filled = stored, amber = next to go, hatched = dropped by the cap. */
function HourStrip({ r, capping }: { r: StorageReport; capping: boolean }) {
  const window = r.settings.retention_ms
  const nowHour = Math.floor(r.now / HOUR) * HOUR
  const first = nowHour - window + HOUR
  const byStart = new Map(r.hours.map((h) => [h.start, h]))
  const max = Math.max(1, ...r.hours.map((h) => h.bytes))
  const oldest = r.hours.find((h) => h.lines > 0)?.start ?? null
  const cells = []
  for (let t = first; t <= nowHour; t += HOUR) cells.push(t)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-5 gap-px" role="img" aria-label={`${r.hours.length} hourly partitions stored`}>
        {cells.map((t) => {
          const h = byStart.get(t)
          const dropped = !h && capping && oldest != null && t < oldest
          return (
            <span
              key={t}
              title={
                h ? `${fmtDay(t)} ${fmtClock(t)} · ${fmtCount(h.lines)} lines · ${fmtBytes(h.bytes)}` : fmtClock(t)
              }
              className={cn(
                'min-w-0.5 flex-1',
                h
                  ? t === oldest
                    ? 'bg-status-warn'
                    : 'bg-brand'
                  : dropped
                    ? 'bg-[repeating-linear-gradient(45deg,var(--muted-foreground)_0_1px,transparent_1px_4px)] opacity-50'
                    : 'bg-muted',
              )}
              style={h && t !== oldest ? { opacity: 0.35 + 0.65 * (h.bytes / max) } : undefined}
            />
          )
        })}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>
          {fmtDay(first)} {fmtClock(first)}
        </span>
        {oldest != null && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 bg-status-warn" /> next to {capping ? 'drop' : 'expire'} ·{' '}
            {fmtClock(oldest)} hour
          </span>
        )}
        <span>now · {fmtClock(r.now)}</span>
      </div>
    </div>
  )
}

function PurgeDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  source?: string
}) {
  const purge = usePurge()
  const [typed, setTyped] = useState('')
  const word = source ?? 'purge'
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (typed.trim() !== word) return
    try {
      const r = await purge.mutateAsync({ source, confirm: typed.trim() })
      toast.success(`Purged ${fmtCount(r.lines)} lines`, {
        description: source
          ? `Every stored line of ${source} is gone.`
          : 'The database is empty; new lines keep arriving.',
      })
      setTyped('')
      onOpenChange(false)
    } catch (err) {
      toast.error('Could not purge', { description: (err as Error).message })
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{source ? `Purge every line of ${source}?` : 'Purge every stored line?'}</DialogTitle>
            <DialogDescription>
              {source
                ? 'Its stored lines leave search, flows and exports now. The source stays and keeps sending.'
                : 'Search, flows and exports start empty. Sources, settings, members and tokens stay.'}{' '}
              This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5 text-xs">
            <label htmlFor="confirm-purge">
              Type <code className="font-mono text-foreground">{word}</code> to confirm
            </label>
            <Input
              id="confirm-purge"
              aria-label="Confirm purge"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Keep them
            </Button>
            <Button type="submit" variant="destructive" disabled={typed.trim() !== word || purge.isPending}>
              <Trash2Icon /> Purge
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { PurgeDialog }

/** Settings → Storage (boards v0.1-07.3 / 07.4). */
export function Storage() {
  const r = useStorage().data
  const settings = useSettings().data
  const system = useSystem().data
  const sources = useSources().data
  const owner = isOwner(useMe())
  const save = useSaveStorage()
  const [capGb, setCapGb] = useState<string | null>(null)
  const [purging, setPurging] = useState(false)

  if (!r || !settings) return <p className="text-muted-foreground">Loading…</p>
  const st = r.settings
  const capping = system?.disk.state === 'full'
  const warn = r.ratio >= NEAR || capping
  const reaches = r.oldest ? r.now - r.oldest : null
  const shrunk = capping && reaches != null && reaches < st.retention_ms - HOUR
  const kinds = new Map((sources ?? []).map((s) => [s.name, s.kind]))
  const top = r.sources[0]
  const capValue = capGb ?? String(+(st.max_disk / 1e9).toFixed(2))

  const setWindow = async (ms: number | null) => {
    try {
      await save.mutateAsync({ retention_ms: ms })
      toast.success(ms ? `Searchable window: ${fmtWindow(ms)}` : 'Window follows the flag again')
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }
  const saveCap = async (e: FormEvent) => {
    e.preventDefault()
    const n = Number(capValue)
    if (!Number.isFinite(n) || n < 0.01) return toast.error('Disk cap: at least 0.01 GB')
    try {
      await save.mutateAsync({ max_disk: Math.round(n * 1e9) })
      setCapGb(null)
      toast.success(`Disk cap: ${n} GB`)
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }
  const raiseCap = () => {
    setCapGb(String(Math.ceil((st.max_disk * 2) / 1e9)))
    document.getElementById('disk-cap')?.focus()
  }

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader
        title="Storage"
        sub={
          r.store === 'sqlite'
            ? `SQLite on this host · ${r.path ?? 'quiet.db'}`
            : 'In memory only (--store memory): lines are gone on restart'
        }
        aside={
          <span className="flex items-center gap-1.5">
            <StatusDot status={shrunk ? 'warn' : 'ok'} />
            {shrunk && reaches != null
              ? `window reaches back ${fmtSpan(reaches)}`
              : r.oldest
                ? `oldest line ${fmtSpan(r.now - r.oldest)} ago`
                : 'nothing stored yet'}
          </span>
        }
      />
      {!owner && <ReadOnlyNote />}

      {warn && (
        <div role="alert" className="flex items-start gap-3 border border-status-warn/40 bg-status-warn/10 px-4 py-3">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-warn" />
          <div className="flex flex-1 flex-col gap-1">
            <span className="font-medium">
              Disk is at {Math.round(r.ratio * 100)}% of the {gb(st.max_disk)} cap
            </span>
            <span className="text-muted-foreground text-xs leading-relaxed">
              {capping
                ? 'quiet is dropping the oldest hour first to stay under it.'
                : 'At the cap quiet drops the oldest hour first.'}
              {top && ` ${top.source} is ${Math.round(top.share * 100)}% of the volume;`} muting its noisy lines or
              raising the cap {shrunk ? `gives the ${fmtWindow(st.retention_ms)} window back` : 'keeps the full window'}
              .
            </span>
          </div>
          {owner && (
            <Button size="sm" onClick={raiseCap}>
              Raise cap
            </Button>
          )}
        </div>
      )}

      <Panel>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between">
            <span className="flex items-baseline gap-2">
              <span className={cn('font-mono text-2xl', warn && 'text-status-warn')}>{gb(r.used)}</span>
              <span className="font-mono text-muted-foreground text-xs">of {gb(st.max_disk)} disk cap</span>
            </span>
            <span className={cn('font-mono text-xs', warn ? 'text-status-warn' : 'text-muted-foreground')}>
              {Math.round(r.ratio * 100)}%
            </span>
          </div>
          <div className="relative h-2 bg-muted" aria-hidden>
            <div
              className={cn('h-full', warn ? 'bg-status-warn' : 'bg-brand')}
              style={{ width: `${Math.min(100, r.ratio * 100)}%` }}
            />
            <span className="absolute -top-1 -bottom-1 w-px bg-muted-foreground" style={{ left: `${NEAR * 100}%` }} />
          </div>
          <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
            <span>0</span>
            <span>90% · warning</span>
          </div>
          <HourStrip r={r} capping={capping} />
          <p className="text-muted-foreground text-xs leading-relaxed">
            Lines are stored in hourly partitions. When an hour leaves the window, or the disk cap is hit, the oldest
            hour is dropped first, whole.{' '}
            {r.bytes_per_hour != null &&
              (r.cap_in_ms != null
                ? `At the recent ${fmtBytes(r.bytes_per_hour)}/h the cap is reached in about ${fmtSpan(r.cap_in_ms)}, before the window fills.`
                : `At the recent ${fmtBytes(r.bytes_per_hour)}/h the window settles near ${fmtBytes(r.steady_bytes ?? 0)}, under the cap.`)}
          </p>
        </div>
      </Panel>

      <div>
        <SettingRow
          label="Searchable window"
          hint={
            <>
              How long lines stay searchable and stitchable into flows. Whichever limit hits first wins.
              {r.bytes_per_hour != null &&
                ` Est. at today's volume: ${WINDOWS.map((w) => `${w.label} ≈ ${fmtBytes((r.bytes_per_hour ?? 0) * (w.ms / HOUR))}`).join(' · ')}.`}
            </>
          }
          under={
            <>
              {ORIGIN_LABEL[st.retention_origin]} {fmtWindow(st.retention_ms)}
              {st.retention_origin === 'setting' && owner && (
                <>
                  {' · '}
                  <button type="button" className="underline" onClick={() => setWindow(null)}>
                    use flag ({fmtWindow(st.flag_retention_ms)})
                  </button>
                </>
              )}
            </>
          }
        >
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Searchable window"
            disabled={!owner || save.isPending}
            value={[String(st.retention_ms)]}
            onValueChange={(v) => v[0] && Number(v[0]) !== st.retention_ms && setWindow(Number(v[0]))}
          >
            {WINDOWS.map((w) => (
              <ToggleGroupItem key={w.ms} value={String(w.ms)} aria-label={w.label} className="px-3 font-mono">
                {w.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <SettingRow
          label="Disk cap"
          hint="Hard ceiling for stored lines. At the cap, quiet drops the oldest hour first, never the newest."
          htmlFor="disk-cap"
          under={
            <>
              {r.fs_free != null && `${gb(r.fs_free)} free on the data volume · `}
              {ORIGIN_LABEL[st.max_disk_origin]}
            </>
          }
        >
          <form className="flex gap-2" onSubmit={saveCap}>
            <div className="flex h-8 items-center border border-input">
              <input
                id="disk-cap"
                inputMode="decimal"
                className="h-full w-16 bg-transparent px-2 font-mono text-sm outline-none"
                value={capValue}
                disabled={!owner}
                onChange={(e) => setCapGb(e.target.value)}
              />
              <span className="pr-2 font-mono text-muted-foreground text-xs">GB</span>
            </div>
            {owner && (
              <Button type="submit" variant="outline" disabled={capGb == null || save.isPending}>
                Save
              </Button>
            )}
          </form>
        </SettingRow>
        <SettingRow
          label="At the cap"
          hint="The oldest whole hour is dropped first, so search reaches back less far until volume falls. The live stream is never affected."
        >
          <span className="font-mono text-xs">drop oldest hour</span>
        </SettingRow>
      </div>

      <Panel title="Volume by source" aside={`${fmtCount(r.lines)} lines · ${gb(r.used)}`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              {['Source', 'Lines in window', 'On disk', 'Share'].map((h) => (
                <th key={h} className="px-4 py-2 font-normal">
                  <Caps>{h}</Caps>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.sources.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  Nothing stored yet.
                </td>
              </tr>
            )}
            {r.sources.map((s) => {
              const kind = kinds.get(s.source)
              return (
                <tr key={s.source} className="border-b last:border-b-0">
                  <td className="px-4 py-2">
                    {settings.sources[s.source]?.display_name ?? s.source}{' '}
                    {kind && <span className="font-mono text-muted-foreground text-xs">{kindLabel(kind)}</span>}
                  </td>
                  <td className="px-4 py-2 font-mono">{fmtCount(s.lines)}</td>
                  <td className="px-4 py-2 font-mono">{r.store === 'sqlite' ? gb(s.disk) : fmtBytes(s.bytes)}</td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-32 bg-muted">
                        <span className="block h-full bg-brand" style={{ width: `${s.share * 100}%` }} />
                      </span>
                      <span className="font-mono text-muted-foreground text-xs">{Math.round(s.share * 100)}%</span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Panel>

      {owner && (
        <div className="flex items-center justify-between gap-6 border border-destructive/40 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Purge stored lines</span>
            <span className="text-muted-foreground text-xs">
              Deletes every stored line now. Sources, settings, members and tokens stay.
            </span>
          </div>
          <Button variant="destructive" onClick={() => setPurging(true)}>
            <Trash2Icon /> Purge now
          </Button>
        </div>
      )}
      <PurgeDialog open={purging} onOpenChange={setPurging} />
    </div>
  )
}
