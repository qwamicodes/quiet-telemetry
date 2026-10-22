import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeftIcon, PauseIcon, PlayIcon, PlusIcon, RowsIcon, Trash2Icon, XIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { IdOrderEditor } from '@/components/settings/id-order'
import { Caps, Panel } from '@/components/settings/kit'
import { fmtSpan, PurgeDialog } from '@/components/settings/storage'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { Level, PiiKind, SourceInfo, SourceSettings } from '@/gen'
import { useSources } from '@/lib/api'
import { isOwner, useMe } from '@/lib/auth-api'
import { kindLabel } from '@/lib/connect'
import { fmtAgo, fmtClock, fmtCount, fmtTime, fmtWindow, isRecent } from '@/lib/format'
import {
  DEFAULT_SOURCE_SETTINGS,
  HOUR,
  PII_KINDS,
  PII_LABEL,
  useActivity,
  useResetSource,
  useSaveSource,
  useSettings,
  WINDOWS,
} from '@/lib/settings-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const route = getRouteApi('/sources/$name')

export type SourceTab = 'overview' | 'rejected' | 'settings'

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

  const tabs: [SourceTab, string][] = [
    ['overview', 'Overview'],
    ['rejected', `Rejected ${activity ? fmtCount(activity.rejections.reduce((a, r) => a + r.count, 0)) : ''}`],
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
      {tab === 'overview' && <Overview info={info} name={name} saved={saved} />}
      {tab === 'rejected' && <Rejected name={name} />}
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

function Overview({ info, name, saved }: { info?: SourceInfo; name: string; saved: SourceSettings }) {
  const settings = useSettings().data
  if (!info) return <p className="text-muted-foreground">No line from {name} yet.</p>
  const order = saved.id_keys ?? settings?.flow_ids.order ?? []
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Stat label="Lines stored" value={fmtCount(info.lines)} sub="in the searchable window" />
        <Stat
          label="Last line"
          value={info.last_ts ? fmtAgo(info.last_ts) : '—'}
          sub={info.last_ts ? fmtTime(info.last_ts) : undefined}
        />
        <Stat
          label="Window"
          value={fmtWindow(saved.retention_ms ?? settings?.storage.retention_ms ?? 24 * HOUR)}
          sub={saved.retention_ms ? 'shorter than the instance' : 'as the instance'}
        />
        <Stat label="Flow id" value={order[0] ?? '—'} sub={saved.id_keys ? 'source order' : 'instance order'} />
      </div>
      <Panel title="Connection">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 px-4 py-3 font-mono text-xs">
          <dt className="text-brand">via</dt>
          <dd>{info.kind === 'docker' ? 'docker.sock · this host' : kindLabel(info.kind)}</dd>
          {info.containers.length > 0 && (
            <>
              <dt className="text-brand">containers</dt>
              <dd>{info.containers.join(', ')}</dd>
            </>
          )}
          {info.group && (
            <>
              <dt className="text-brand">group</dt>
              <dd>{info.group}</dd>
            </>
          )}
        </dl>
      </Panel>
    </div>
  )
}

function Rejected({ name }: { name: string }) {
  const a = useActivity(name).data
  if (!a) return <p className="text-muted-foreground">Loading…</p>
  return (
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
  )
}

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
  const [purging, setPurging] = useState(false)
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
