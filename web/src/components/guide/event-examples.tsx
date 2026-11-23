import { CheckIcon, CopyIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Caps } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Code } from './kit'

/** The annotated request error: [line, marker]. */
const EXAMPLE: [string, number?][] = [
  ['{'],
  ['  "timestamp": "2026-10-21T14:07:31.123Z",', 1],
  ['  "level": "error",', 2],
  ['  "service": "legivent-api",', 3],
  ['  "env": "production",'],
  ['  "version": "1.42.0",'],
  ['  "commit_sha": "a1b2c3d",'],
  ['  "flow": "create_order",', 4],
  ['  "request_id": "req_8f2a7d",', 5],
  ['  "order": { "id": "ord_1182" },'],
  ['  "method": "POST",'],
  ['  "path": "/api/v1/orders",'],
  ['  "status_code": 500,', 6],
  ['  "duration_ms": 3412,'],
  ['  "response": { "headers": {}, "body_capture": "disabled" },'],
  ['  "user_id": "usr_77b2e1",'],
  ['  "error": {', 7],
  ['    "name": "OrderError",'],
  ['    "code": "ORDER_CREATE_FAILED",'],
  ['    "message": "inventory unavailable",'],
  ['    "details": { "dependency": "inventory" },'],
  ['    "reason": "dependency_failure"'],
  ['  },'],
  ['  "request": {'],
  ['    "route": "/api/v1/orders",'],
  ['    "headers": {', 8],
  ['      "authorization": "[REDACTED]",'],
  ['      "content-type": "application/json"'],
  ['    },'],
  ['    "body_capture": "disabled"', 9],
  ['  }'],
  ['}'],
]

const FIELDS: [string, string, string][] = [
  [
    'timestamp',
    'Stream · time',
    'UTC completion time. duration_ms is measured monotonically; it describes this request or attempt.',
  ],
  [
    'level',
    'Filter bar',
    'Recorded error or HTTP ≥400 → error; slow success → warn; ordinary success → info. Four filters.',
  ],
  [
    'service · env · version · commit_sha',
    'Field card',
    'Identity group at the top of the field card; tells two deploys apart.',
  ],
  [
    'flow · method · path',
    'Stream · Flow',
    'Flow labels the business action in Stream and Flow. Add it directly to the event; no separate calls or outcome.',
  ],
  [
    'request_id · job_id',
    'Flow',
    'Correlates records using scoped ids. Parent links come from explicit request or queue evidence.',
  ],
  [
    'status_code · duration_ms',
    'Timing',
    'Actual HTTP status and measured duration. An error overrides a slow-success warning.',
  ],
  [
    'error · message · reason · details',
    'Field card · Error',
    'Keep safe error fields typed. reason and details may be strings, objects, arrays or scalars.',
  ],
  [
    'request · response',
    'Field card',
    'Approved headers and optional bodies. Disabled and truncated are explicit; missing capture is unknown.',
  ],
  [
    'body_capture',
    'Field card',
    'Disabled: capture off. Truncated: safe preview shortened. Missing: unknown. Redacted values stay removed in every view.',
  ],
]

const DO = [
  'Build one completion event; emit after tail sampling',
  'Keep scoped native ids; propagate known parents only',
  'Structured errors; preserve reason and details types',
  'Business flow: create_order',
  'Approved request and response fields',
]
const DONT = [
  'console.log scattered through handlers',
  'Both time and timestamp, or two timestamp keys',
  'error.message holding stringified JSON',
  'The full provider payload and flattened copies',
  'Passwords, tokens, cookies and configured secrets',
]

const CASES: [string, string, string][] = [
  ['Request succeeds', 'info · 201 · 180 ms', 'Eligible and good; sample at 10%.'],
  ['Request is slow', 'warn · 201 · 620 ms', 'Retain. Bad for the configured <500 ms request SLO.'],
  [
    'Request fails or aborts',
    'error · 4xx / 5xx / abort',
    'Retain. An abort has no invented status; eligible and bad.',
  ],
  [
    'Safe body opt-in',
    'same level as the request',
    'Only approved route fields; redact before size limits. Email and phone stay visible.',
  ],
  [
    'Job attempt fails',
    'error · native attempt 1',
    'Retain. Record failure and retry evidence; do not label the logical job finished.',
  ],
  [
    'Retry recovers',
    'info · native attempt 2',
    'Retain confirmed recovery. Failed attempts remain errors; job SLO is separate.',
  ],
  [
    'Child job / standalone job',
    'own event · native job id',
    'Link a child only with explicit parent evidence. A standalone job needs no request id.',
  ],
  [
    'Missing terminal evidence',
    'unknown · no invented event',
    'Show incomplete evidence. Accepted-job SLOs use durable tracking and deadlines.',
  ],
  ['Cron run', 'one completion · run id', 'Use its configured objective; ordinary success may be sampled.'],
  [
    'Forced retention',
    'same level · always retained',
    'An explicit business rule or force flag retains the event without changing severity.',
  ],
  [
    'Multiple services',
    'one event per service',
    'Share trusted correlation ids. Only the configured boundary counts toward its SLO.',
  ],
  [
    'Stream completes / disconnects',
    'actual duration · actual status',
    'Finish at the local body boundary. Record disconnect errors; no fabricated completion after a crash.',
  ],
  [
    'Queue cancellation / timeout',
    'use authoritative queue evidence',
    'A cancellation request is not confirmation. Keep observed attempt errors and configured SLO treatment.',
  ],
]

const attempt = (n: number, ts: string, extra: string[]) =>
  [
    '{',
    `  "timestamp": "${ts}",`,
    `  "level": "${n === 1 ? 'error' : 'info'}",`,
    '  "service": "order-worker",',
    '  "env": "production",',
    '  "flow": "deliver_order",',
    '  "request_id": "req_8f2a7d",',
    '  "queue": "orders",',
    '  "job_id": "job_456",',
    `  "attempt": ${n},`,
    `  "duration_ms": ${n === 1 ? 350 : 200},`,
    '  "order": {',
    '    "id": "ord_1182"',
    `  }${extra.length ? ',' : ''}`,
    ...extra,
    '}',
  ].join('\n')

const ATTEMPT_1 = attempt(1, '2026-11-17T14:31:00.000Z', [
  '  "error": {',
  '    "code": "PROVIDER_UNAVAILABLE",',
  '    "message": "Delivery provider unavailable",',
  '    "reason": "upstream_unavailable",',
  '    "details": {',
  '      "provider": "delivery"',
  '    }',
  '  }',
])
const ATTEMPT_2 = attempt(2, '2026-11-17T14:31:05.200Z', [])

/** Event examples (v0.1.1-11.5, "The canonical line" tab). */
export function EventExamples() {
  const [copied, setCopied] = useState(false)
  const json = EXAMPLE.map(([l]) => l).join('\n')
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-[minmax(0,452px)_minmax(0,1fr)] items-start gap-6">
        <section aria-label="Example event" className="border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <span className="font-mono text-xs">request error · POST /api/v1/orders</span>
            <Button
              type="button"
              size="sm"
              variant={copied ? 'outline' : 'default'}
              className={cn(copied && 'border-status-ok/60 text-status-ok')}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(json)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                } catch {
                  toast.error('Could not copy', { description: 'Select the JSON and copy it by hand.' })
                }
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre className="py-2 font-mono text-[11px] leading-[16.8px]">
            {EXAMPLE.map(([l, n], i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                key={i}
                className={cn('flex items-center px-2.5', n && 'bg-row-selected')}
              >
                <span className={cn('flex-1 whitespace-pre', n && 'text-syntax-key')}>{l}</span>
                {n && (
                  <span className="flex size-3.5 items-center justify-center bg-brand font-mono text-[9px] text-brand-foreground">
                    {n}
                  </span>
                )}
              </span>
            ))}
          </pre>
        </section>
        <div className="flex flex-col gap-4">
          <section aria-label="Fields">
            <Caps className="pb-2">Field → what quiet does with it</Caps>
            <ol className="flex flex-col">
              {FIELDS.map(([f, where, what], i) => (
                <li key={f} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 border-b py-2">
                  <span className="mt-0.5 flex size-3.5 items-center justify-center bg-brand font-mono text-[9px] text-brand-foreground">
                    {i + 1}
                  </span>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[11px] text-syntax-key">{f}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{where}</span>
                  </span>
                  <span />
                  <span className="pt-1 text-muted-foreground text-[11px] leading-relaxed">{what}</span>
                </li>
              ))}
            </ol>
          </section>
          <div className="grid grid-cols-2 gap-3">
            <DoDont title="Do" items={DO} ok />
            <DoDont title="Don't" items={DONT} />
          </div>
        </div>
      </div>

      <section aria-label="In stream" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Caps>In stream</Caps>
          <span className="font-mono text-[10px] text-muted-foreground">
            Open the row for fields; Flow opens with an activity list. Timing is a separate view.
          </span>
        </div>
        <div className="flex h-8 items-center gap-3 border bg-row-error px-3 font-mono text-xs shadow-[inset_2px_0_0_var(--status-err)]">
          <span className="text-muted-foreground">14:07:31</span>
          <span className="bg-level-error-muted px-1.5 text-[11px] text-level-error">error</span>
          <span className="text-muted-foreground">POST</span>
          <span>/api/v1/orders</span>
          <span className="text-level-error">create_order → 500</span>
          <span className="ml-auto text-muted-foreground">req_8f2a7d</span>
          <span className="text-level-error">3.4s</span>
        </div>
      </section>

      <section aria-label="How each case is logged" className="border bg-card">
        <h3 className="border-b px-3.5 py-3 text-[13px]">
          How each case is logged
          <span className="text-muted-foreground"> · uses the configured request SLO and 10% sampling example</span>
        </h3>
        <table className="w-full text-xs">
          <tbody>
            {CASES.map(([c, how, what]) => (
              <tr key={c} className="border-b last:border-b-0">
                <td className="w-[174px] px-3.5 py-2.5">{c}</td>
                <td className="w-[222px] px-3.5 font-mono text-[11px] text-muted-foreground">{how}</td>
                <td className="px-3.5 text-muted-foreground">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="A failed attempt and confirmed recovery" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[13px]">A failed attempt and confirmed recovery</h3>
          <p className="text-muted-foreground text-xs">
            Two separate JSON records for one job. This example queue numbers attempts from 1; use your queue's own
            fields and semantics.
          </p>
        </div>
        <div className="grid grid-cols-2 items-start gap-4">
          {(
            [
              ['Attempt 1 · error · retained', ATTEMPT_1],
              ['Attempt 2 · info · recovery retained', ATTEMPT_2],
            ] as const
          ).map(([t, j]) => (
            <section key={t} aria-label={t} className="border bg-card">
              <div className="border-b px-3 py-2 font-mono text-xs">{t}</div>
              <Code className="border-0 bg-transparent text-[11px]">{j}</Code>
            </section>
          ))}
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          The adapter supplies confirmed retry and completion evidence separately. Attempt 2 alone does not prove
          recovery. Both events are retained even at 0% sampling; the HTTP SLO does not apply to either attempt. Expand
          the job in Flow to read each event and any evidenced child jobs.
        </p>
      </section>
    </div>
  )
}

function DoDont({ title, items, ok = false }: { title: string; items: string[]; ok?: boolean }) {
  return (
    <section aria-label={title} className="border bg-card p-3">
      <h3 className={cn('pb-2 text-[13px]', ok ? 'text-status-ok' : 'text-level-error')}>{title}</h3>
      <ul className="flex flex-col">
        {items.map((x) => (
          <li key={x} className="flex gap-2 border-b py-1.5 text-[11px] last:border-b-0">
            {ok ? (
              <CheckIcon className="mt-0.5 size-3 shrink-0 text-status-ok" />
            ) : (
              <XIcon className="mt-0.5 size-3 shrink-0 text-level-error" />
            )}
            {x}
          </li>
        ))}
      </ul>
    </section>
  )
}
