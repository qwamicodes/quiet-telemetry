import { useQuery } from '@tanstack/react-query'
import { LockIcon, PlusIcon, XIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { PiiKind, RedactionPreview, SourceSettings } from '@/gen'
import { fetchJson } from '@/lib/api'
import { piiKind } from '@/lib/settings-api'
import { cn } from '@/lib/utils'

/** A card with the boards' inline title (13px semibold) and subtitle, no header bar. */
export function Card({
  title,
  sub,
  chip,
  aside,
  children,
  className,
}: {
  title: ReactNode
  sub?: ReactNode
  /** A small outlined mono tag on the right (`new records`, `in your app`). */
  chip?: string
  /** Anything else on the right of the title (a button). */
  aside?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-2.5 border bg-card p-4', className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold text-[13px] leading-[18px]">{title}</h3>
          {sub && <p className="text-muted-foreground text-xs leading-[18px]">{sub}</p>}
        </div>
        {chip && (
          <span className="flex h-[18px] shrink-0 items-center border px-1.5 font-medium font-mono text-[11px] text-muted-foreground leading-3">
            {chip}
          </span>
        )}
        {aside}
      </div>
      {children}
    </section>
  )
}

/** The groups shown as rows; others a source turned on through the API show too. */
const SHOWN_PII: PiiKind[] = ['email', 'phone']

const PII_ROW: Record<PiiKind, { keys: string; sample: string }> = {
  email: { keys: 'email · customer.email · user.email', sample: 'ama@example.com' },
  phone: { keys: 'phone · msisdn · user.msisdn', sample: '+233205550118' },
  name: { keys: 'first_name · last_name · customer_name', sample: 'Ama Mensah' },
  ip: { keys: 'ip · ip_address · client_ip', sample: '102.176.65.12' },
  user_agent: { keys: 'user_agent', sample: 'okhttp/4.12' },
}

function Row({
  name,
  to,
  keys,
  state,
  control,
}: {
  name: string
  to: string
  keys: ReactNode
  state: string
  control: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 border-b py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-center gap-2">
          <span className="font-medium font-mono text-[13px] leading-[18px]">{name}</span>
          <span className="font-mono text-[11px] text-syntax-string leading-[14px]">→ {to}</span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground leading-[14px]">{keys}</div>
      </div>
      <span className="shrink-0 text-muted-foreground text-xs leading-4">{state}</span>
      <span className="flex h-[18px] w-8 shrink-0 items-center justify-center">{control}</span>
    </div>
  )
}

type Policy = Pick<SourceSettings, 'redact_fields' | 'redact_pii'>

/**
 * Sources → a source → Settings: what is removed before storage, indexing
 * and live delivery (v0.1.1-06.3, 06.5). Credentials and auth headers are
 * always removed (`server/src/redact.rs`); custom fields and the personal-data
 * groups are per source. Existing records are never rewritten.
 */
export function RedactPanel({
  draft,
  set,
  disabled,
  onPreview,
}: {
  draft: Policy
  set: (p: Partial<Policy>) => void
  disabled?: boolean
  /** Opens the Redaction preview; unset on the preview itself. */
  onPreview?: () => void
}) {
  const [field, setField] = useState('')
  // Switching custom fields off keeps the list in this draft, so switching back restores it.
  const [parked, setParked] = useState<string[]>([])
  const custom = draft.redact_fields.length ? draft.redact_fields : parked
  const add = () => {
    const f = field.trim()
    if (!f) return
    if (!draft.redact_fields.includes(f)) set({ redact_fields: [...draft.redact_fields, f] })
    setField('')
  }
  const pii = (k: PiiKind, on: boolean) =>
    set({ redact_pii: on ? [...draft.redact_pii, k] : draft.redact_pii.filter((x) => x !== k) })
  const extra = draft.redact_pii.filter((k) => !SHOWN_PII.includes(k))

  return (
    <Card
      title="Redact sensitive data"
      sub="Remove values before storage, indexing and live delivery."
      chip="new records"
    >
      <div className="flex flex-col">
        <Row
          name="credentials"
          to="[REDACTED]"
          keys="password · token · api_key · secret"
          state="Required"
          control={<LockIcon aria-label="Always redacted" className="size-3 text-muted-foreground" />}
        />
        <Row
          name="headers"
          to="[REDACTED]"
          keys="authorization · cookie · set-cookie"
          state="Required"
          control={<LockIcon aria-label="Always redacted" className="size-3 text-muted-foreground" />}
        />
        <Row
          name="custom fields"
          to="[REDACTED]"
          keys={
            custom.length ? (
              <span className="flex flex-wrap gap-x-1">
                {custom.map((f, i) => (
                  <span key={f} className="group inline-flex items-center gap-0.5">
                    {i > 0 && <span aria-hidden>·</span>}
                    {f}
                    {!disabled && draft.redact_fields.includes(f) && (
                      <button
                        type="button"
                        aria-label={`Stop redacting ${f}`}
                        className="opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => set({ redact_fields: draft.redact_fields.filter((x) => x !== f) })}
                      >
                        <XIcon className="size-3" />
                      </button>
                    )}
                  </span>
                ))}
              </span>
            ) : (
              'none yet · add a key or field path below'
            )
          }
          state={draft.redact_fields.length ? 'Redact' : 'Off'}
          control={
            <Switch
              aria-label="Redact custom fields"
              checked={draft.redact_fields.length > 0}
              disabled={disabled || custom.length === 0}
              onCheckedChange={(on) => {
                if (on) {
                  set({ redact_fields: parked })
                  setParked([])
                } else {
                  setParked(draft.redact_fields)
                  set({ redact_fields: [] })
                }
              }}
            />
          }
        />
        {[...SHOWN_PII, ...extra].map((k) => {
          const on = draft.redact_pii.includes(k)
          return (
            <Row
              key={k}
              name={k}
              to={on ? '[REDACTED]' : PII_ROW[k].sample}
              keys={PII_ROW[k].keys}
              state={on ? 'Redact' : 'Visible'}
              control={
                <Switch
                  aria-label={`Redact ${k}`}
                  checked={on}
                  disabled={disabled}
                  onCheckedChange={(v) => pii(k, v)}
                />
              }
            />
          )
        })}
      </div>
      {!disabled && (
        <div className="flex gap-2">
          <Input
            aria-label="Add a sensitive key or field path"
            placeholder="Add a sensitive key or field path"
            className="h-8 font-mono text-[13px]"
            value={field}
            maxLength={128}
            onChange={(e) => setField(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="h-8"
            aria-label="Add sensitive key"
            onClick={add}
            disabled={!field.trim()}
          >
            <PlusIcon /> Add
          </Button>
        </div>
      )}
      <p className="text-muted-foreground text-xs leading-[18px]">
        Applies to request, response, context and errors. Removed values cannot be revealed. Existing records are
        unchanged.
      </p>
      {onPreview && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onPreview}>
            Preview with sample data
          </Button>
        </div>
      )}
    </Card>
  )
}

const redactionPreview = z.object({
  event: z.record(z.string(), z.unknown()),
  removed: z.number(),
  preserved: z.array(piiKind),
}) satisfies z.ZodType<RedactionPreview>

/** The synthetic event after a draft policy ran over it (`POST /api/sources/:name/redaction-preview`). */
export function useRedactionPreview(name: string, policy: Policy, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['redaction-preview', name, policy.redact_fields, policy.redact_pii],
    queryFn: () =>
      fetchJson(`/api/sources/${encodeURIComponent(name)}/redaction-preview`, redactionPreview, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redact_fields: policy.redact_fields, redact_pii: policy.redact_pii }),
      }),
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

const preservedLine = (kinds: PiiKind[]) =>
  kinds.length === 2 ? 'email and phone preserved' : kinds.length === 1 ? `${kinds[0]} preserved` : 'nothing preserved'

/** 06.5 left: the sanitized sample event. */
export function SanitizedSample({ preview }: { preview?: RedactionPreview }) {
  return (
    <Card title="Sanitized sample event">
      <p data-testid="redaction-summary" className="text-muted-foreground text-xs leading-[18px]">
        {preview ? (
          <>
            {preview.removed} {preview.removed === 1 ? 'value' : 'values'} removed · {preservedLine(preview.preserved)}
            <br />
            Bodies enabled for this synthetic route example.
          </>
        ) : (
          'Running the policy over the sample…'
        )}
      </p>
      {preview ? (
        <pre
          data-testid="sanitized-sample"
          className="overflow-x-auto border bg-code px-3 py-3 font-mono text-xs leading-5 whitespace-pre-wrap"
        >
          {compactJson(preview.event)}
        </pre>
      ) : (
        <Skeleton className="h-96" />
      )}
    </Card>
  )
}

/**
 * Pretty JSON like the board draws it: small objects (no nested objects, a
 * few keys) stay on one line, and short scalar pairs share a line.
 */
export function compactJson(v: unknown, indent = 0): string {
  const pad = '  '.repeat(indent + 1)
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return JSON.stringify(v)
  const entries = Object.entries(v as Record<string, unknown>)
  const flat = entries.every(([, x]) => x === null || typeof x !== 'object')
  const inline = `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(', ')} }`
  if (indent > 0 && flat && inline.length <= 50) return inline
  const lines: string[] = []
  let cur = ''
  for (const [k, x] of entries) {
    const part = `${JSON.stringify(k)}: ${compactJson(x, indent + 1)}`
    const short = x === null || typeof x !== 'object'
    if (short && cur && cur.length + part.length + 2 <= 50 && !part.includes('\n')) {
      cur += `, ${part}`
      continue
    }
    if (cur) lines.push(cur)
    cur = part
    if (!short) {
      lines.push(cur)
      cur = ''
    }
  }
  if (cur) lines.push(cur)
  return `{\n${lines.map((l) => pad + l).join(',\n')}\n${'  '.repeat(indent)}}`
}

/** 06.5 right, under the policy. */
export function SampleOnly() {
  return (
    <Card
      title="Sample only"
      sub="Uses synthetic values and the current policy. Live records are unchanged; this is not proof that every secret can be detected."
    />
  )
}
