import { CopyIcon, ExternalLinkIcon, RefreshCwIcon } from 'lucide-react'
import { CopyButton } from '@/components/copy-button'
import { Caps, PageHeader } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { About as AboutInfo, DockerStatus, GeneralSettings } from '@/gen'
import {
  bumpKind,
  clearUpdateCache,
  compareVersions,
  REPO_URL,
  type Release,
  releaseBullets,
  UPDATE_COMMAND,
  useAbout,
  useLatestRelease,
} from '@/lib/about-api'
import { isOwner, useMe } from '@/lib/auth-api'
import { fmtBytes, fmtDay, fmtTime, getDisplayTimeZone, publicOrigin } from '@/lib/format'
import { useSaveGeneral, useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'

/** `1d 3h`, `3h 12m`, `4m`. */
export function fmtUptime(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${Math.max(0, m)}m`
}

const dockerLine = (d: DockerStatus) =>
  d.state === 'connected'
    ? `docker.sock · ${d.containers} ${d.containers === 1 ? 'container' : 'containers'}`
    : d.state === 'unavailable'
      ? `unavailable · ${d.error}`
      : d.state

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-1 flex-col gap-1 border bg-card px-4 py-3.5">
      <Caps>{label}</Caps>
      <span className="font-mono text-2xl">{value}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
    </div>
  )
}

function UpdateCallout({ latest, running }: { latest: Release; running: string }) {
  const bullets = releaseBullets(latest.body)
  return (
    <section
      aria-label="Update available"
      className="flex flex-col gap-3 border border-brand/50 bg-brand/5 px-4 py-3.5"
    >
      <div className="flex items-center gap-2">
        <RefreshCwIcon className="size-3.5 text-brand" />
        <span className="font-medium">{latest.tag_name.replace(/^v?/, 'v')} is available</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {latest.published_at ? `· released ${fmtDay(Date.parse(latest.published_at))} ` : ''}·{' '}
          {bumpKind(latest.tag_name, running)}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<a href={latest.html_url} target="_blank" rel="noreferrer" />}
        >
          Changelog <ExternalLinkIcon />
        </Button>
      </div>
      {bullets.length > 0 && (
        <ul className="flex flex-col gap-1 text-[13px]">
          {bullets.map((b) => (
            <li key={b} className="flex gap-2">
              <span className="text-muted-foreground">-</span>
              {b}
            </li>
          ))}
        </ul>
      )}
      <Caps>Update on the host</Caps>
      <div className="border bg-background">
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">shell</span>
          <CopyButton text={UPDATE_COMMAND} what="Command" variant="ghost" />
        </div>
        <pre className="overflow-x-auto px-3 py-3 font-mono text-[13px]">{UPDATE_COMMAND}</pre>
      </div>
      <p className="text-muted-foreground text-xs">
        Updates are never applied from the browser. Lines in the window survive the restart; the stream reconnects by
        itself.
      </p>
    </section>
  )
}

function UpdateStatus({ on, running }: { on: boolean; running: string }) {
  const latest = useLatestRelease(on)
  if (!on) return null
  if (latest.isPending) return <p className="font-mono text-muted-foreground text-xs">Checking GitHub releases…</p>
  if (latest.isError)
    return (
      <p className="font-mono text-muted-foreground text-xs">Could not check for updates: {latest.error.message}</p>
    )
  if (compareVersions(latest.data.tag_name, running) > 0)
    return <UpdateCallout latest={latest.data} running={running} />
  return (
    <p className="font-mono text-muted-foreground text-xs">
      v{running} is the latest release ({latest.data.tag_name}).
    </p>
  )
}

export function debugInfo(a: AboutInfo, general: GeneralSettings | undefined): string {
  return [
    `quiet v${a.version}${a.commit ? ` (${a.commit})` : ''}${a.built ? ` built ${a.built}` : ''}`,
    `uptime ${fmtUptime(a.now - a.started)}`,
    `store ${a.store} · sqlite ${a.sqlite_version} · ${fmtBytes(a.db_bytes)}`,
    `docker ${dockerLine(a.docker)}`,
    `data dir ${a.data_dir ?? '—'}`,
    `live clients ${a.live_clients} · members ${a.members}`,
    `timezone ${general?.timezone ?? '—'} · public url ${general?.public_url ?? '(browser address)'}`,
    `browser ${navigator.userAgent}`,
  ].join('\n')
}

/** Settings → About (board v0.1-07.6). */
export function About() {
  const a = useAbout().data
  const general = useSettings().data?.general
  const owner = isOwner(useMe())
  const save = useSaveGeneral()
  const checkOn = general?.check_updates ?? false

  const setCheck = async (on: boolean) => {
    if (!general) return
    try {
      await save.mutateAsync({ ...general, check_updates: on })
      if (!on) clearUpdateCache()
    } catch (err) {
      toast.error('Could not save', { description: (err as Error).message })
    }
  }
  const copyDebug = async () => {
    if (!a) return
    try {
      await navigator.clipboard.writeText(debugInfo(a, general))
      toast.success('Debug info copied', { description: 'Paste it into an issue. It has no log lines or secrets.' })
    } catch {
      toast.error('Could not copy', { description: 'Your browser blocked the clipboard.' })
    }
  }
  const tz = getDisplayTimeZone()

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader title="About" sub="quiet · a calm realtime log viewer" />
      <div className="flex gap-3">
        <Stat
          label="Running"
          value={a ? `v${a.version}` : '…'}
          sub={
            a
              ? [a.built ? `built ${fmtDay(Date.parse(a.built))}` : 'dev build', a.commit].filter(Boolean).join(' · ')
              : ''
          }
        />
        <Stat
          label="Uptime"
          value={a ? fmtUptime(a.now - a.started) : '…'}
          sub={a ? `since ${fmtDay(a.started)} ${fmtTime(a.started).slice(0, 5)}` : ''}
        />
        <Stat
          label="Database"
          value={a ? fmtBytes(a.db_bytes) : '…'}
          sub={a ? (a.store === 'sqlite' ? `sqlite ${a.sqlite_version} · wal` : `${a.store} store`) : ''}
        />
        <Stat
          label="Live clients"
          value={a ? String(a.live_clients) : '…'}
          sub={a ? `websocket · ${a.members} ${a.members === 1 ? 'member' : 'members'}` : ''}
        />
      </div>

      <UpdateStatus on={checkOn} running={a?.version ?? '0.0.0'} />

      <section className="border bg-card px-4 py-3.5" aria-label="This instance">
        <h3 className="pb-2 font-medium">This instance</h3>
        <dl className="grid grid-cols-[140px_1fr] font-mono text-[13px]">
          {(
            [
              ['public url', general?.public_url ?? `${publicOrigin()} (browser address)`, !general?.public_url],
              ['docker', a ? dockerLine(a.docker) : '…', true],
              ['data dir', a?.data_dir ?? 'in memory (no data dir)', !a?.data_dir],
              ['timezone', tz === 'local' ? `local · ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : tz, true],
            ] as const
          ).map(([k, v, muted]) => (
            <div key={k} className="contents">
              <dt className="border-b py-1.5 text-brand">{k}</dt>
              <dd className={muted ? 'border-b py-1.5 text-muted-foreground' : 'border-b py-1.5'}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="flex items-start justify-between gap-6 border-b pb-4">
        <div className="flex flex-col gap-0.5">
          <label htmlFor="check-updates" className="font-medium">
            Check for updates daily
          </label>
          <span className="text-muted-foreground text-xs">
            Each browser that opens this page asks GitHub for the latest release, at most once a day. Nothing about your
            logs is sent, and the server never calls out.
          </span>
        </div>
        <Switch
          id="check-updates"
          aria-label="Check for updates daily"
          checked={checkOn}
          disabled={!owner || !general || save.isPending}
          onCheckedChange={(v) => setCheck(Boolean(v))}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer" />}
        >
          Docs <ExternalLinkIcon />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}
        >
          GitHub <ExternalLinkIcon />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<a href={`${REPO_URL}/blob/main/LICENSE.md`} target="_blank" rel="noreferrer" />}
        >
          License · FSL-1.1-MIT <ExternalLinkIcon />
        </Button>
        <Button variant="ghost" size="sm" onClick={copyDebug} disabled={!a}>
          <CopyIcon /> Copy debug info
        </Button>
      </div>
    </div>
  )
}
