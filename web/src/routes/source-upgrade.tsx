import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { CheckIcon, ChevronsUpDownIcon, RefreshCwIcon } from 'lucide-react'
import { GuideTabs } from '@/components/guide/guide-tabs'
import { Button } from '@/components/ui/button'
import type { FormatReport } from '@/gen'
import { useSources } from '@/lib/api'
import { fmtCount } from '@/lib/format'
import { CHANGE_COPY, upgradePrompt, useSourceFormat } from '@/lib/log-format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const route = getRouteApi('/sources/$name/upgrade')

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const caps = 'font-mono text-[11px] text-muted-foreground uppercase leading-3.5 tracking-[0.06em]'

function FieldMap({ r }: { r: FormatReport }) {
  const head = cn(caps, 'h-9 border-b py-0 text-left align-middle font-normal')
  return (
    <section aria-label="Field map" className="min-w-0 flex-1 border bg-card">
      <table className="w-full table-fixed">
        <colgroup>
          <col className="w-[256px]" />
          <col />
          <col className="w-[116px]" />
        </colgroup>
        <thead>
          <tr>
            <th className={cn(head, 'pl-3.5')}>Your code writes</th>
            <th className={cn(head, 'pl-3 normal-case')}>v0.1.1 EXPECTS</th>
            <th className={cn(head, 'pr-3.5 text-right')}>Records</th>
          </tr>
        </thead>
        <tbody>
          {r.changes.map((c) => {
            const copy = CHANGE_COPY[c.id]
            return (
              <tr key={c.id} className="border-b align-top last:border-b-0">
                <td className="py-2.5 pl-3.5 font-mono text-level-warn text-xs leading-4.5">
                  {copy?.writes ?? c.from}
                </td>
                <td className="py-2.5 pl-3">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-foreground text-xs leading-4.5">{copy?.expects ?? c.to}</span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {copy?.why}
                      {!c.old_format && ' Advice: not needed for the tag.'}
                    </span>
                  </span>
                </td>
                <td className="py-2.5 pr-3.5 text-right font-mono text-foreground text-xs tabular-nums leading-4.5">
                  {fmtCount(c.count)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function AgentCard({ label, r }: { label: string; r: FormatReport }) {
  const navigate = useNavigate()
  const prompt = upgradePrompt(label, r)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      toast.success('Upgrade prompt copied')
    } catch {
      toast.error('Could not copy', { description: 'Select the text and copy it by hand.' })
    }
  }
  return (
    <section aria-label="Upgrade with your agent" className="flex w-[340px] shrink-0 flex-col border bg-card">
      <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <h2 className="font-medium text-[13px] leading-4.5">Upgrade with your agent</h2>
        <span className="font-mono text-[11px] text-muted-foreground leading-3.5">changes only</span>
      </header>
      <pre className="whitespace-pre-wrap p-3 font-mono text-foreground text-xs leading-4.5">{prompt}</pre>
      <div className="flex gap-2 border-t p-3">
        <Button size="sm" onClick={copy}>
          Copy upgrade prompt
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: '/guide', search: { tab: 'agent', step: 'review' } })}
        >
          Full prompt
        </Button>
      </div>
    </section>
  )
}

/** After the deploy: how much of the sample already uses v0.1.1. */
function AfterDeploy({ r }: { r: FormatReport }) {
  const share = r.sample ? r.new / r.sample : 0
  return (
    <section aria-label="Rollout" className="flex flex-col gap-2.5 border px-4 py-3.5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium text-[13px] leading-4.5">After you deploy</h2>
        <span className="font-mono text-[11px] text-muted-foreground leading-3.5">
          re-checked every 30 s · or Re-check now
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Records using v0.1.1"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="flex h-1.5 bg-muted"
      >
        <div className="bg-brand" style={{ width: `${share * 100}%` }} />
      </div>
      <p className="text-muted-foreground text-xs leading-4">
        {fmtCount(r.new)} of {fmtCount(r.sample)} records use v0.1.1. Both formats show side by side while you roll out;
        the source drops its v0.1.0 tag when no old records arrive for 24 hours.
      </p>
    </section>
  )
}

/**
 * Upgrade a v0.1.0 source (v0.1.1-00.3), inside the Guide with Check my logs
 * active: what the code writes → what v0.1.1 expects with counts from the
 * newest 5,000 records, a changes-only prompt, and rollout after the deploy.
 */
export function SourceUpgradePage() {
  const { name } = route.useParams()
  const navigate = useNavigate()
  const sources = useSources().data ?? []
  const info = sources.find((s) => s.name === name)
  const q = useSourceFormat(name)
  const r = q.data
  const label = info?.display_name ?? name
  const visible = sources.filter((s) => !s.hidden)
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-[1192px] flex-col gap-4 px-8 pt-7 pb-8">
        <div className="flex flex-col gap-4">
          <header className="flex items-end justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="font-semibold text-xl leading-6 tracking-tight">Upgrade {label} to v0.1.1</h1>
              <p className="text-muted-foreground text-sm">
                Your existing logs keep working. Update the code you already wrote so new checks, redaction markers and
                goals apply.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="relative flex h-8 w-[220px] items-center border border-input bg-card text-xs">
                <span className="pointer-events-none pl-2.5 text-muted-foreground">source</span>
                <select
                  aria-label="Source to upgrade"
                  value={name}
                  onChange={(e) => navigate({ to: '/sources/$name/upgrade', params: { name: e.target.value } })}
                  className="h-full min-w-0 flex-1 appearance-none bg-transparent pr-7 pl-2 font-medium outline-none"
                >
                  {(visible.some((s) => s.name === name) ? visible : [...visible, { name, display_name: null }]).map(
                    (s) => (
                      <option key={s.name} value={s.name}>
                        {s.display_name ?? s.name}
                      </option>
                    ),
                  )}
                </select>
                <ChevronsUpDownIcon className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
              </label>
              <Button variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
                <RefreshCwIcon className={cn(q.isFetching && 'animate-spin')} /> Re-check
              </Button>
            </div>
          </header>
          <GuideTabs active="check" search={{ source: name }} />
        </div>

        {q.isError && <p className="text-sm text-status-err">Couldn't read this source's records.</p>}
        {!r && !q.isError && <p className="text-muted-foreground text-sm">Reading the newest records…</p>}

        {r && (
          <>
            <div className="flex items-center gap-2">
              {r.tag && (
                <span
                  className={cn(
                    'flex h-4.5 items-center px-1.5 font-medium font-mono text-[11px] leading-3',
                    r.tag === 'v0.1.0' ? 'bg-level-warn-muted text-level-warn' : 'bg-status-ok/15 text-status-ok',
                  )}
                >
                  {r.tag} format
                </span>
              )}
              <span className="font-mono text-[11px] text-muted-foreground leading-3.5">
                {fmtCount(r.sample)} received records · checked {clock(r.now)} · {fmtCount(r.old)} use v0.1.0 fields
              </span>
            </div>
            {r.changes.length ? (
              <div className="flex items-start gap-4">
                <FieldMap r={r} />
                <AgentCard label={label} r={r} />
              </div>
            ) : (
              <p className="flex items-center gap-2 border bg-card px-4 py-3 text-sm [&_svg]:size-4 [&_svg]:text-status-ok">
                <CheckIcon /> {label} already writes v0.1.1 events.
              </p>
            )}
            <AfterDeploy r={r} />
          </>
        )}
      </div>
    </div>
  )
}
