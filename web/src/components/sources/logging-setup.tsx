import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Card } from '@/components/sources/redaction'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SourceSettings } from '@/gen'
import { type Goal, SAMPLE_RATES, STACKS, stackById, useSetup, useStack } from '@/lib/guide'
import { cn } from '@/lib/utils'

const box =
  'flex min-h-8 items-center border border-input bg-background px-2.5 py-[7px] font-mono text-xs leading-[18px]'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] leading-4">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-xs leading-[18px]">{hint}</span>}
    </div>
  )
}

/** A read-only value in the board's input box. */
function Shown({ label, children, example }: { label: string; children: ReactNode; example?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 border-b py-2.5">
      <span className="text-xs leading-4">{label}</span>
      <output aria-label={label} className={cn(box, example && 'text-muted-foreground')}>
        {children}
      </output>
    </div>
  )
}

function CaptureRow({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[13px] leading-[18px]">{title}</span>
        <span className="text-muted-foreground text-xs leading-[18px]">{sub}</span>
      </div>
      {children}
    </div>
  )
}

const fixed = cn(box, 'w-[130px] shrink-0 justify-center py-1')

const unit = (g: Goal) => ({ ms: 'ms', seconds: 's', minutes: 'min' })[g.unit]

/** "status < 400 · no error · duration < 500 ms" for a goal's success rule. */
export function goodLine(g: Goal): string {
  const time = `${g.kind === 'job' ? 'within' : 'duration <'} ${g.limit} ${unit(g)}`
  const ok = g.kind === 'job' ? 'completed · no error' : 'status < 400 · no error'
  if (g.matters === 'success') return ok
  if (g.matters === 'speed') return time
  return `${ok} · ${time}`
}

/**
 * Sources → a source → Logging setup (v0.1.1-06.4): the choices that fill
 * the Guide's agent prompt for this source. Nothing here changes the app or
 * the server; the prompt does, once it is applied in the codebase.
 */
export function LoggingSetup({ name, saved }: { name: string; saved: SourceSettings }) {
  const [setup, update] = useSetup()
  const [stack, setStack] = useStack()
  const goal = setup.goals.find((g) => g.scope.includes(name)) ?? setup.goals[0]
  const more = setup.goals.length - (goal ? 1 : 0)
  const hidden = saved.redact_pii.filter((k) => k === 'email' || k === 'phone')
  const custom = saved.redact_fields.length
  const sensitive = [
    'Credentials removed',
    custom ? `${custom} custom ${custom === 1 ? 'field' : 'fields'}` : null,
    hidden.length === 2
      ? 'email and phone redacted'
      : hidden.length === 1
        ? `${hidden[0]} redacted, ${hidden[0] === 'email' ? 'phone' : 'email'} visible`
        : 'email and phone visible',
  ]
    .filter(Boolean)
    .join('; ')

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card title="Your runtime">
          <Field label="Language / framework" hint="Example selection. Use the framework already in your codebase.">
            <Select value={stack} onValueChange={(v) => v && setStack(v as typeof stack)}>
              <SelectTrigger aria-label="Language / framework" className="h-8 w-full font-mono text-[13px]">
                <SelectValue>{(v: string) => stackById(v).label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STACKS.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Queue / worker" hint="One completion event per request or job attempt.">
            <Input
              aria-label="Queue / worker"
              placeholder="BullMQ"
              className="h-8 font-mono text-[13px]"
              value={setup.queue}
              maxLength={80}
              onChange={(e) => update({ queue: e.target.value })}
            />
          </Field>
        </Card>
        <Card
          title={goal ? 'Your SLOs & sampling' : 'Your SLOs & sampling · example'}
          aside={
            <Link
              to="/guide"
              search={{ tab: 'agent', step: 'setup', source: name }}
              className="flex h-6 shrink-0 items-center px-2 font-medium text-muted-foreground text-xs hover:text-foreground"
            >
              {goal ? 'Edit goals' : 'Browse templates'}
            </Link>
          }
        >
          <div className="flex flex-col gap-1">
            <Shown label="Scope & eligible work" example={!goal}>
              {goal
                ? `${goal.scope || goal.appliesTo || name} · every completed ${goal.kind === 'job' ? 'job' : 'request'}`
                : 'POST /api/v1/orders · every completed request'}
            </Shown>
            <Shown label={goal?.kind === 'job' ? 'Good job' : 'Good request'} example={!goal}>
              {goal ? goodLine(goal) : 'status < 400 · no error · duration < 500 ms'}
            </Shown>
            <Shown label="Target & window" example={!goal}>
              {goal ? `${goal.target}% · rolling ${goal.period} days` : '99.9% · rolling 30 days'}
            </Shown>
            <div className="flex flex-col gap-1.5 border-b py-2.5">
              <span className="text-xs leading-4">Sample other completion events</span>
              <Select value={String(setup.sample)} onValueChange={(v) => v && update({ sample: Number(v) })}>
                <SelectTrigger aria-label="Sample other completion events" className="h-8 w-full font-mono text-xs">
                  <SelectValue>{(v: string) => `${v}%${v === '100' ? ' · keep every event' : ''}`}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SAMPLE_RATES.map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {more > 0 && (
            <p className="font-mono text-[11px] text-muted-foreground">
              +{more} more {more === 1 ? 'goal' : 'goals'} in the guide
            </p>
          )}
          <p className="text-muted-foreground text-xs leading-[18px]">
            Keep errors, HTTP ≥400, warnings, SLO misses and forced events. Measure every eligible completion before
            sampling.
          </p>
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <Card
          title="Request & response capture"
          sub="Metadata on; bodies off unless you opt in per route."
          chip="in your app"
        >
          <div className="flex flex-col">
            <CaptureRow title="Headers" sub="Request and response · credentials removed">
              <Select value={setup.headers} onValueChange={(v) => v && update({ headers: v as typeof setup.headers })}>
                <SelectTrigger aria-label="Headers" className="h-7 w-[130px] font-mono text-xs">
                  <SelectValue>{(v: string) => (v === 'approved' ? 'On' : 'Off')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approved">On</SelectItem>
                  <SelectItem value="none">Off</SelectItem>
                </SelectContent>
              </Select>
            </CaptureRow>
            <CaptureRow title="Request body" sub="Enable only for selected routes">
              <span className={fixed}>Off</span>
            </CaptureRow>
            <CaptureRow title="Response body" sub="Choose safe fields when enabling capture">
              <span className={fixed}>Off</span>
            </CaptureRow>
            <CaptureRow title="Body / event limits" sub="Serialized UTF-8 · edit in the guide prompt">
              <span className={fixed}>8 KB / 32 KB</span>
            </CaptureRow>
            <CaptureRow title="Sensitive data" sub={sensitive}>
              <Link
                to="/sources/$name"
                params={{ name }}
                search={{ tab: 'settings' }}
                className={cn(fixed, 'hover:bg-accent')}
              >
                Use policy
              </Link>
            </CaptureRow>
          </div>
          <p className="text-muted-foreground text-xs leading-[18px]">
            Skip files and streams. Redact before emission; keep valid JSON and mark shortened bodies as truncated.
          </p>
        </Card>
        <Card
          title="Apply through the guide"
          sub="These choices fill the setup prompt. Review it in Guide, then apply it in your codebase. Nothing changes in the app yet."
        />
      </div>
    </div>
  )
}
