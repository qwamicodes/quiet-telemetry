import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRightIcon, CheckIcon, ChevronsUpDownIcon, CopyIcon, PlugIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { LintCheck, LintReport } from '@/gen'
import { useSources } from '@/lib/api'
import { CHECK_TITLE, fixPrompt, SHORT_FIX } from '@/lib/guide'
import { useLint } from '@/lib/lint-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Panel } from './kit'

/** The sources Check my logs can read, and the one in the URL (or the first). */
export function useCheckSource(source?: string) {
  const sources = useSources().data
  const visible = (sources ?? []).filter((s) => !s.hidden)
  const current = source ?? visible[0]?.name ?? null
  const navigate = useNavigate()
  useEffect(() => {
    if (!source && current) navigate({ to: '/guide', search: { tab: 'check', source: current }, replace: true })
  }, [source, current, navigate])
  return { loaded: !!sources, visible, current }
}

/** Header: the source select and Re-check (11.6). */
export function VerifyActions({ source }: { source?: string }) {
  const { visible, current } = useCheckSource(source)
  const lint = useLint(current)
  const navigate = useNavigate()
  if (!visible.length) return null
  return (
    <>
      <label className="relative flex h-8 w-[220px] items-center border border-input bg-background text-[13px]">
        <span className="pointer-events-none pl-2.5 text-muted-foreground text-xs">source</span>
        <select
          aria-label="Source to check"
          value={current ?? ''}
          onChange={(e) => navigate({ to: '/guide', search: { tab: 'check', source: e.target.value } })}
          className="h-full min-w-0 flex-1 appearance-none bg-transparent pr-7 pl-2 outline-none"
        >
          {visible.map((s) => (
            <option key={s.name} value={s.name}>
              {s.display_name ?? s.name}
            </option>
          ))}
        </select>
        <ChevronsUpDownIcon className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
      </label>
      <Button type="button" variant="outline" onClick={() => lint.refetch()}>
        <RefreshCwIcon /> Re-check
      </Button>
    </>
  )
}

const BADGE: Record<LintCheck['status'], string> = {
  pass: 'bg-status-ok/15 text-status-ok',
  fail: 'bg-level-error-muted text-level-error',
  warn: 'bg-level-warn-muted text-level-warn',
  review: 'bg-level-warn-muted text-level-warn',
  optional: 'border text-muted-foreground',
  na: 'border text-muted-foreground',
}
const BAR: Record<LintCheck['status'], string> = {
  pass: 'bg-status-ok',
  fail: 'bg-status-err',
  warn: 'bg-level-warn',
  review: 'bg-status-err',
  optional: 'bg-muted-foreground',
  na: 'bg-muted-foreground',
}

const pct = (share: number | null) => (share == null ? '—' : `${Math.round(share * 100)}%`)

function CheckRow({ c }: { c: LintCheck }) {
  const fix = c.status === 'pass' && c.id !== 'job_scope' ? '' : SHORT_FIX[c.id]
  const reviewLow = c.status === 'review' && c.share != null && c.share < 0.8
  // A review row reads green when most records pass; low coverage reads like a miss.
  const bar = c.status === 'review' ? (reviewLow ? 'bg-status-err' : 'bg-status-ok') : BAR[c.status]
  return (
    <tr
      aria-label={CHECK_TITLE[c.id] ?? c.title}
      className={cn(
        'border-b last:border-b-0',
        c.status === 'fail' && 'bg-row-error',
        reviewLow && 'bg-level-warn-muted/60',
      )}
    >
      <td className="w-[208px] px-3 py-2.5 text-[13px]">{CHECK_TITLE[c.id] ?? c.title}</td>
      <td className="w-[196px] px-3">
        <span className="flex items-center gap-2 font-mono text-[11px]">
          <span className="relative h-1 w-16 bg-border">
            {c.share != null && (
              <span className={cn('absolute inset-y-0 left-0', bar)} style={{ width: `${c.share * 100}%` }} />
            )}
          </span>
          <span
            className={cn(
              'w-9',
              c.status === 'pass' && 'text-status-ok',
              c.status === 'fail' && 'text-level-error',
              c.status === 'warn' && 'text-level-warn',
              c.status === 'review' && (reviewLow ? 'text-level-error' : 'text-status-ok'),
              (c.status === 'optional' || c.share == null) && 'text-muted-foreground',
            )}
          >
            {pct(c.share)}
          </span>
          <span className={cn('px-1.5 py-0.5', BADGE[c.status])}>{c.status}</span>
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-[11px]">
        <span className="block">{c.detail}</span>
        {fix && (
          <span className={cn('block', c.status === 'optional' ? 'text-muted-foreground' : 'text-brand')}>→ {fix}</span>
        )}
      </td>
    </tr>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warn' | 'muted' }) {
  return (
    <div className="flex flex-col gap-1.5 border bg-card px-4 py-3.5">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{label}</span>
      <span
        className={cn(
          'font-mono text-2xl',
          tone === 'warn' && 'text-level-warn',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
    </div>
  )
}

const BEYOND: [string, string][] = [
  [
    'Completion and isolation',
    'Success, 4xx/5xx, throws, aborts, streams and concurrent requests: one completion event per execution, actual status, no leaked context.',
  ],
  [
    'Retention and delivery',
    'At 0% normal sampling, verify errors, SLO misses, forced events and confirmed recovery in the sink. Force a known success for delivery checks.',
  ],
  [
    'Capture and redaction',
    'Test approved headers and body opt-ins, nested credentials, reason/details, UTF-8 byte limits and disabled/truncated states. Raw, Copy and export must use the same safe data.',
  ],
  [
    'SLOs and queue evidence',
    'Reconcile unsampled eligible/good counts with source evidence. Test attempts, retries, child links and missing completion. Job deadlines need durable tracking; SLA reports need the agreed full period.',
  ],
]

function FixWithAgent({ r, onFullPrompt }: { r: LintReport; onFullPrompt: () => void }) {
  const text = fixPrompt(r.source, r.checks)
  const [done, setDone] = useState(false)
  return (
    <Panel title="Fix with your agent" aside="review findings">
      <pre className="whitespace-pre-wrap px-3.5 py-3 font-mono text-[11px] leading-[17px]" data-testid="fix-prompt">
        {text}
      </pre>
      <div className="flex gap-2 px-3.5 pb-3.5">
        <Button
          type="button"
          size="sm"
          variant={done ? 'outline' : 'default'}
          className={cn(done && 'border-status-ok/60 text-status-ok')}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setDone(true)
              setTimeout(() => setDone(false), 1500)
            } catch {
              toast.error('Could not copy', { description: 'Select the fix prompt and copy it by hand.' })
            }
          }}
        >
          {done ? <CheckIcon /> : <CopyIcon />} {done ? 'Copied' : 'Copy fix prompt'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onFullPrompt}>
          Full prompt
        </Button>
      </div>
    </Panel>
  )
}

/**
 * Failing fields · excerpt (11.6): a few records each failing check saw,
 * failures first. Excerpts are the stored record, redacted again by the
 * server, so a credential never shows here.
 */
function FailingFields({ r }: { r: LintReport }) {
  const order: Record<LintCheck['status'], number> = { fail: 0, warn: 1, review: 2, optional: 3, pass: 4, na: 5 }
  const rows = r.checks
    .filter((c) => c.failing.length > 0)
    .sort((a, b) => order[a.status] - order[b.status])
    .slice(0, 4)
  if (!rows.length) return null
  return (
    <Panel title="Failing fields" aside="excerpt · sanitized">
      <ul className="flex flex-col">
        {rows.map((c) => {
          const f = c.failing[0]
          return (
            <li key={c.id} className="flex flex-col gap-1.5 border-b px-3.5 py-3 last:border-b-0">
              <span className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="truncate">{CHECK_TITLE[c.id] ?? c.title}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {c.failing.length > 1 ? `${c.failing.length} shown` : `line ${f.line_id}`}
                </span>
              </span>
              <span
                className={cn('font-mono text-[11px]', c.status === 'fail' ? 'text-level-error' : 'text-level-warn')}
              >
                {f.note}
              </span>
              <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-all border bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground leading-[16px]">
                {f.excerpt}
              </pre>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/** Verify your logs (v0.1.1-11.6, the Check my logs tab). */
export function VerifyLogs({ source, onFullPrompt }: { source?: string; onFullPrompt: () => void }) {
  const { loaded, visible, current } = useCheckSource(source)
  const lint = useLint(current)

  if (loaded && visible.length === 0)
    return (
      <div className="flex flex-col items-start gap-3 border border-dashed p-6">
        <span className="font-medium">No sources yet</span>
        <span className="text-muted-foreground text-sm">
          Connect a source, send a few requests, then check its lines.
        </span>
        <Link to="/connect">
          <Button type="button">
            <PlugIcon /> Connect a source
          </Button>
        </Link>
      </div>
    )

  const r = lint.data
  if (!r)
    return (
      <p className="font-mono text-muted-foreground text-xs">
        {lint.isError ? `Could not check ${current}.` : `Checking ${current ?? ''}…`}
      </p>
    )
  const checks = r.checks.filter((c) => c.status !== 'na')
  const by = (id: string) => r.checks.find((c) => c.id === id)
  const parent = by('job_request_id')
  const typed = by('error_object')
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2.5 font-mono text-[11px] text-muted-foreground">
        <span className="bg-brand/15 px-1.5 py-0.5 text-brand">v0.1.1 · sample result</span>
        {r.sampled.toLocaleString()} received records · same rules as the prompt · sample checks do not measure delivery
        or SLO coverage
      </p>
      {r.sampled === 0 ? (
        <div className="flex items-center justify-between border border-dashed px-4 py-3 text-sm">
          <span>{current} has no records in the window yet.</span>
          <Link to="/" search={{ source: current ?? undefined }} className="flex items-center gap-1 text-brand">
            Open stream <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      ) : null}
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Checks" value={`${checks.length} checks`} sub="sample checks · not a health score" />
        <Stat label="Lines read" value={r.sampled.toLocaleString()} sub={`newest records · ${r.source}`} />
        <Stat
          label="Request-linked jobs"
          value={parent && parent.status !== 'na' ? pct(parent.share) : '—'}
          sub={parent && parent.status !== 'na' ? 'standalone jobs may omit it' : 'no job records in the sample'}
          tone={parent && parent.status !== 'na' ? 'muted' : undefined}
        />
        <Stat
          label="Typed error fields"
          value={typed && typed.status !== 'na' ? pct(typed.share) : '—'}
          sub={
            typed && typed.status !== 'na' ? (typed.detail.split(' · ').pop() ?? '') : 'no error records in the sample'
          }
          tone={typed && typed.status !== 'na' && typed.status !== 'pass' ? 'warn' : undefined}
        />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4">
        <section aria-label="Checks" className="border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
                <th className="px-3 py-2 font-normal">Check</th>
                <th className="px-3 py-2 font-normal">In this sample</th>
                <th className="px-3 py-2 font-normal">What quiet saw · fix</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <CheckRow key={c.id} c={c} />
              ))}
            </tbody>
          </table>
        </section>
        <aside className="flex flex-col gap-4">
          <FixWithAgent r={r} onFullPrompt={onFullPrompt} />
          <FailingFields r={r} />
        </aside>
      </div>
      <section aria-label="Verify beyond this sample" className="border bg-card">
        <h3 className="border-b px-3.5 py-3 text-[13px]">
          Verify beyond this sample<span className="text-muted-foreground"> · run in your codebase before rollout</span>
        </h3>
        <table className="w-full text-[13px]">
          <tbody>
            {BEYOND.map(([k, v]) => (
              <tr key={k} className="border-b last:border-b-0">
                <td className="w-[206px] px-3.5 py-3 align-top">{k}</td>
                <td className="px-3.5 py-3 text-muted-foreground">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
