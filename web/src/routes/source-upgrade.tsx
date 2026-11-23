import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeftIcon, CheckIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { CopyButton } from '@/components/copy-button'
import type { FormatReport } from '@/gen'
import { useSources } from '@/lib/api'
import { fmtCount } from '@/lib/format'
import { upgradePrompt, useSourceFormat } from '@/lib/log-format'
import { cn } from '@/lib/utils'

const route = getRouteApi('/sources/$name/upgrade')

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)
const hour = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col border bg-card">
      <header className="flex h-10 items-center gap-3 border-b px-4">
        <h2 className="flex-1 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

function FieldMap({ r }: { r: FormatReport }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b text-left font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          <th className="px-4 py-2 font-normal">Your code writes</th>
          <th className="px-4 py-2 font-normal">v0.1.1 expects</th>
          <th className="px-4 py-2 text-right font-normal">Records</th>
        </tr>
      </thead>
      <tbody>
        {r.changes.map((c) => (
          <tr key={c.id} className="border-border/60 border-b last:border-b-0">
            <td className="px-4 py-2.5 font-mono text-status-warn">{c.from}</td>
            <td className="px-4 py-2.5">
              <span className="font-mono text-foreground">{c.to}</span>
              {!c.old_format && <span className="ml-2 text-muted-foreground text-xs">advice</span>}
            </td>
            <td className="px-4 py-2.5 text-right font-mono text-muted-foreground tabular-nums">
              {fmtCount(c.count)} <span className="text-[11px]">· {pct(c.count, r.sample)}%</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Old vs new records per hour, oldest first (rollout after a deploy). */
function Rollout({ r }: { r: FormatReport }) {
  const max = Math.max(1, ...r.rollout.map((b) => b.old + b.new))
  const last = r.rollout[r.rollout.length - 1]
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-2xl tabular-nums">{last ? pct(last.new, last.old + last.new) : 0}%</span>
        <span className="text-muted-foreground text-xs">v0.1.1 records in the latest hour</span>
      </div>
      <div role="img" aria-label="Old and new format records per hour" className="flex h-24 items-end gap-1">
        {r.rollout.map((b) => (
          <div
            key={b.start}
            className="flex flex-1 flex-col justify-end"
            title={`${hour(b.start)} · ${b.new} new · ${b.old} old`}
          >
            <div className="bg-brand" style={{ height: `${(b.new / max) * 96}px` }} />
            <div className="bg-status-warn/70" style={{ height: `${(b.old / max) * 96}px` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{r.rollout[0] ? hour(r.rollout[0].start) : ''}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2 bg-brand" /> v0.1.1
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 bg-status-warn/70" /> v0.1.0
          </span>
        </span>
        <span>{last ? hour(last.start) : ''}</span>
      </div>
      <p className="text-muted-foreground text-xs">
        The <span className="font-mono">v0.1.0</span> tag clears 24 hours after the last old-format record.
      </p>
    </div>
  )
}

/**
 * Upgrade a v0.1.0 source (v0.1.1-00.3): what the code writes → what v0.1.1
 * expects with counts from the newest 5,000 records, a changes-only prompt,
 * and rollout progress after the deploy.
 */
export function SourceUpgradePage() {
  const { name } = route.useParams()
  const info = useSources().data?.find((s) => s.name === name)
  const q = useSourceFormat(name)
  const r = q.data
  const label = info?.display_name ?? name
  const upToDate = r?.changes.every((c) => !c.old_format)
  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      <nav className="flex items-center gap-3 text-sm">
        <Link to="/sources/$name" params={{ name }} className="flex items-center gap-1.5 hover:underline">
          <ArrowLeftIcon className="size-3.5" /> {label}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-mono text-muted-foreground">upgrade</span>
      </nav>
      <header className="flex flex-col gap-1.5">
        <h1 className="flex items-center gap-3 font-semibold text-2xl">
          Upgrade {label} to v0.1.1
          {r?.tag && (
            <span
              className={cn(
                'px-1.5 py-0.5 font-mono text-xs',
                r.tag === 'v0.1.0' ? 'bg-status-warn/15 text-status-warn' : 'bg-status-ok/15 text-status-ok',
              )}
            >
              {r.tag}
            </span>
          )}
        </h1>
        <p className="text-muted-foreground text-sm">
          {r
            ? `What your code writes → what v0.1.1 expects, from the newest ${fmtCount(r.sample)} records. Records already sent keep working.`
            : 'Reading the newest records…'}
        </p>
      </header>

      {q.isError && <p className="text-sm text-status-err">Couldn't read this source's records.</p>}

      {r && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-5">
            <Card
              title="Field map"
              aside={
                <span className="font-mono text-[11px] text-muted-foreground">
                  {fmtCount(r.old)} v0.1.0 · {fmtCount(r.new)} v0.1.1 · {fmtCount(r.other)} other
                </span>
              }
            >
              {r.changes.length ? (
                <FieldMap r={r} />
              ) : (
                <p className="flex items-center gap-2 px-4 py-4 text-sm [&_svg]:size-4 [&_svg]:text-status-ok">
                  <CheckIcon /> {label} already writes v0.1.1 events.
                </p>
              )}
            </Card>
            {r.changes.length > 0 && (
              <Card
                title="Upgrade prompt · changes only"
                aside={<CopyButton text={upgradePrompt(label, r)} label="Copy prompt" what="Upgrade prompt" />}
              >
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5">
                  {upgradePrompt(label, r)}
                </pre>
              </Card>
            )}
          </div>
          <div className="flex flex-col gap-5">
            <Card title="Rollout">
              {r.rollout.length ? (
                <Rollout r={r} />
              ) : (
                <p className="px-4 py-4 text-muted-foreground text-sm">No JSON events in the sample yet.</p>
              )}
            </Card>
            {upToDate && (
              <p className="text-muted-foreground text-xs">
                Nothing left to change for the tag. Anything listed as advice is optional.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
