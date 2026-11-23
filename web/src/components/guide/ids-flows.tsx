import { InfoIcon, TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Code } from './kit'

function Svc({ name, kind, className }: { name: string; kind: string; className?: string }) {
  return (
    <span className={cn('absolute flex items-center gap-2 font-mono text-xs', className)}>
      <span className="font-medium">{name}</span>
      <span className="border px-1.5 py-0.5 text-[10px] text-muted-foreground">{kind}</span>
    </span>
  )
}

function Node({
  title,
  sub,
  right,
  tone,
  className,
}: {
  title: string
  sub: string
  right?: string
  tone: 'brand' | 'ok' | 'err'
  className?: string
}) {
  return (
    <div
      className={cn(
        'absolute flex flex-col gap-1 border px-3 py-2 font-mono text-xs',
        tone === 'brand' && 'border-brand bg-brand/10 outline outline-1 outline-brand/40 outline-offset-2',
        tone === 'ok' && 'border-status-ok/50 bg-status-ok/10',
        tone === 'err' && 'border-status-err/50 bg-row-error',
        className,
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn('size-1.5 rounded-full', tone === 'err' ? 'bg-status-err' : 'bg-status-ok')} aria-hidden />
        <span className="flex-1 font-medium">{title}</span>
        {right && <span className="text-status-err">{right}</span>}
      </span>
      <span
        className={cn(tone === 'err' ? 'text-status-err' : tone === 'ok' ? 'text-status-ok' : 'text-muted-foreground')}
      >
        {sub}
      </span>
    </div>
  )
}

function Chip({
  children,
  className,
  tone = 'brand',
}: {
  children: ReactNode
  className?: string
  tone?: 'brand' | 'warn' | 'muted'
}) {
  return (
    <span
      className={cn(
        'absolute border px-1.5 py-0.5 font-mono text-[11px]',
        tone === 'brand' && 'border-brand/60 text-brand',
        tone === 'warn' && 'border-level-warn/60 text-level-warn',
        tone === 'muted' && 'text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** request → service → job → attempts, as on v0.1.0-11.4 (native job ids). */
function FlowDiagram() {
  return (
    <section aria-label="Request to job" className="relative h-[404px] overflow-hidden border bg-card">
      <svg className="absolute inset-0 size-full text-brand" aria-hidden>
        <path d="M 272 84 H 300 V 194 H 380" fill="none" stroke="currentColor" />
        <path d="M 300 194 V 322 H 330" fill="none" stroke="currentColor" />
        <path d="M 574 322 H 598 M 842 322 H 866" fill="none" stroke="var(--level-warn)" strokeDasharray="3 3" />
      </svg>
      <Svc name="legivent-api" kind="docker" className="top-6 left-6" />
      <Node
        tone="brand"
        title="POST /api/v1/payouts"
        sub="req_8f2a5b · 201 · 112ms"
        className="top-[56px] left-6 w-[248px]"
      />
      <Chip className="top-[124px] left-[104px]">x-request-id: req_8f2a5b</Chip>
      <Svc name="payments-svc" kind="otlp" className="top-[134px] left-[380px]" />
      <Node
        tone="ok"
        title="POST /internal/transfers"
        sub="req_8f2a5b · 200 · 38ms"
        className="top-[166px] left-[380px] w-[260px]"
      />
      <Chip tone="muted" className="top-[174px] left-[700px]">
        hop 0 · same request_id
      </Chip>
      <Chip className="top-[258px] left-[124px]">job data {'{ request_id }'}</Chip>
      <Svc name="order-worker" kind="docker · BullMQ" className="top-[264px] left-[330px]" />
      <Chip tone="muted" className="top-[266px] left-[866px]">
        hop 1 · same job_id
      </Chip>
      <Node
        tone="err"
        title="payout-88-1300"
        right="800ms"
        sub="attempt 0 · timeout"
        className="top-[296px] left-[330px] w-[244px]"
      />
      <Node
        tone="err"
        title="payout-88-1300"
        right="640ms"
        sub="attempt 1 · insufficient_float"
        className="top-[296px] left-[598px] w-[244px]"
      />
      <Node
        tone="err"
        title="payout-88-1300"
        right="2.1s"
        sub="attempt 2 · moved_to_failed"
        className="top-[296px] left-[866px] w-[244px]"
      />
      <Chip tone="warn" className="top-[364px] left-[546px]">
        backoff 2s
      </Chip>
      <Chip tone="warn" className="top-[364px] left-[814px]">
        backoff 4s
      </Chip>
      <div className="absolute top-4 right-4 flex flex-col gap-1 border bg-background px-3 py-2.5 font-mono text-[11px]">
        <span className="text-muted-foreground uppercase tracking-[0.06em]">Opened: req_8f2a5b</span>
        <span>hop 0 · lines carrying req_8f2a5b</span>
        <span>hop 1 · ids found on them (payout-88-1300)</span>
        <span>hop 2 · a follow-up job's own retries</span>
        <span className="text-muted-foreground">limits · 2 hops · 64 ids · 1,000 lines</span>
      </div>
    </section>
  )
}

const STEPS: { title: string; code: string; caption: string }[] = [
  {
    title: '1 · At the edge',
    code: `const request_id =\n  headers['x-request-id'] ?? \`req_\${id()}\`\nset.headers['x-request-id'] = request_id`,
    caption:
      'Generate it, or accept the incoming one. Keep it in request context (AsyncLocalStorage, contextvars) and return it as a response header.',
  },
  {
    title: '2 · Calling your own services',
    code: `await fetch(\`\${PAYMENTS}/internal/transfers\`, {\n  headers: { 'x-request-id': request_id },\n})`,
    caption: 'Forward x-request-id; the receiving service reuses it, so both services land in the same flow.',
  },
  {
    title: '3 · Enqueueing a job',
    code: "const job = await payouts.add('settle',\n  { dealer_id: 88, request_id })\n// worker: preserve native identity\nwideEvent.job_id = job.id\nwideEvent.queue = payouts.name\nwideEvent.request_id = job.data.request_id",
    caption:
      'One canonical event per attempt. Queue evidence supplies retry, completion and cancellation states. Propagate request_id when present; standalone jobs need no invented request.',
  },
]

/** Ids & flows (v0.1.0-11.4): keep native job ids with their queue and service. */
export function IdsFlows() {
  return (
    <div className="flex flex-col gap-6">
      <FlowDiagram />
      <div className="grid grid-cols-3 items-start gap-4">
        {STEPS.map((s) => (
          <section key={s.title} aria-label={s.title} className="flex flex-col gap-3">
            <h3 className="text-[13px]">{s.title}</h3>
            <Code className="bg-background">{s.code}</Code>
            <p className="text-muted-foreground text-xs leading-relaxed">{s.caption}</p>
          </section>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <section
          aria-label="Preserve native ids and their scope"
          className="flex gap-3 border border-level-warn/50 bg-level-warn-muted px-4 py-3"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-level-warn" />
          <div className="flex flex-col gap-1">
            <h3 className="text-[13px]">Preserve native ids and their scope</h3>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Keep the queue's native job_id with its queue and service scope. Matching ids correlate records; only
              explicit parent links establish causality.
            </p>
          </div>
        </section>
        <section
          aria-label="Use existing trace context"
          className="flex gap-3 border border-brand/50 bg-brand/5 px-4 py-3"
        >
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-brand" />
          <div className="flex flex-col gap-1">
            <h3 className="text-[13px]">Use existing trace context</h3>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Include trace_id and span_id when instrumentation provides them. Missing spans or parent links must not
              create an invented execution chain.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
