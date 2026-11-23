import { describe, expect, it } from 'vitest'
import type { Level, LogLine } from '@/gen'
import { previewFields, redactedCount, rowParts } from '@/lib/row'

const line = (level: Level | null, fields: Record<string, unknown> | null, msg = ''): LogLine => ({
  id: 1,
  ts: 1_792_000_000_000,
  received: 1_792_000_000_000,
  source: 'api',
  level,
  display_id: null,
  ids: [],
  msg,
  fields: fields ?? undefined,
  raw: fields ? JSON.stringify(fields) : msg,
})

const http = (status_code: number, extra: Record<string, unknown> = {}) => ({
  flow: 'list_orders',
  method: 'GET',
  path: '/api/v1/orders',
  status_code,
  duration_ms: 39,
  request: { route: '/api/v1/orders', headers: { authorization: '[REDACTED]' }, body_capture: 'disabled' },
  ...extra,
})

describe('rowParts (v0.1.1-03.x)', () => {
  it('reads REQUEST and FLOW · RESULT from a completion event', () => {
    const p = rowParts(line('info', http(200)))
    expect(p).toMatchObject({ method: 'GET', path: '/api/v1/orders', event: 'list_orders', outcome: '200', tone: 'ok' })
    expect(p.outcomeKey).toBe('status_code')
    expect(p.extra).toEqual([])
  })

  it('keeps the status and adds the error reason: 401 · invalid_signature', () => {
    const p = rowParts(
      line(
        'error',
        http(401, {
          flow: 'verify_signature',
          method: 'POST',
          path: '/api/v1/webhooks/paystack',
          error: { code: 'INVALID_SIGNATURE', reason: 'invalid_signature' },
        }),
      ),
    )
    expect(p.event).toBe('verify_signature')
    expect(p.outcome).toBe('401')
    expect(p.tone).toBe('err')
    expect(p.extra).toEqual(['invalid_signature'])
    expect(p.extraTone).toBe('err')
  })

  it('falls back to the error code when there is no reason', () => {
    const p = rowParts(line('error', http(500, { error: { code: 'REPORT_BUILD_FAILED', message: 'boom' } })))
    expect(p.extra).toEqual(['REPORT_BUILD_FAILED'])
  })

  it('a slow success keeps its green status: 200 · slow', () => {
    const p = rowParts(line('warn', http(200, { duration_ms: 1912 })))
    expect(p.outcome).toBe('200')
    expect(p.tone).toBe('ok')
    expect(p.extra).toEqual(['slow'])
    expect(p.extraTone).toBe('warn')
  })

  it('a 201 names the resource it created: 201 · order 1181', () => {
    const p = rowParts(line('info', http(201, { flow: 'create_order', method: 'POST', order: { id: 'ord_1181' } })))
    expect(p.extra).toEqual(['order 1181'])
    expect(p.tone).toBe('ok')
  })

  it('a 4xx is an error even when logged at info', () => {
    expect(rowParts(line('info', http(404))).tone).toBe('err')
  })

  it('reads a job attempt: JOB name, flow → reason · attempt', () => {
    const job = {
      flow: 'settle_dealer_payout',
      queue: 'payouts',
      job_id: 'payout-88-1300',
      attempt: 2,
      duration_ms: 640,
    }
    const failed = rowParts(line('error', { ...job, error: { code: 'TRANSFER_TIMEOUT', reason: 'upstream_timeout' } }))
    expect(failed).toMatchObject({
      name: 'payouts',
      event: 'settle_dealer_payout',
      outcome: 'upstream_timeout',
      tone: 'err',
    })
    expect(failed.path).toBeUndefined()
    expect(failed.extra).toEqual(['attempt 2'])
    const last = rowParts(line('error', { ...job, attempt: 3, retries_left: 0, error: { code: 'X' } }))
    expect(last.extra).toEqual(['attempt 3', 'final'])
    const ok = rowParts(line('info', { ...job, attempt: 1 }))
    expect(ok).toMatchObject({ outcome: 'ok', tone: 'ok' })
  })

  it('still reads v0.1.0 lines', () => {
    const p = rowParts(
      line('error', {
        status: 500,
        method: 'GET',
        path: '/r/1',
        msg: 'build_report → 500',
        wideEvents: { flow: 'build_report' },
        outcome: 'failed',
      }),
    )
    expect(p).toMatchObject({ event: 'build_report', outcome: '500', tone: 'err' })
    const plain = rowParts(line(null, null, 'plain text'))
    expect(plain).toMatchObject({ event: 'plain text', tone: 'muted' })
  })
})

describe('previewFields (v0.1.1-03.5)', () => {
  it('shows ids, status, flow, path, error and capture first', () => {
    const f = previewFields(
      line(
        'error',
        http(500, {
          request_id: 'req_8f2a7d',
          flow: 'build_report',
          error: { code: 'REPORT_BUILD_FAILED', reason: 'renderer_timeout' },
          response: { headers: {}, body_capture: 'disabled' },
        }),
      ),
    ).map(([k]) => k)
    expect(f.slice(0, 9)).toEqual([
      'request_id',
      'status_code',
      'duration_ms',
      'flow',
      'method',
      'path',
      'error.reason',
      'error.code',
      'request.headers',
    ])
    expect(f).toContain('request.body_capture')
    expect(f).toContain('response.body_capture')
    expect(f).not.toContain('request')
  })

  it('counts redacted values anywhere', () => {
    expect(redactedCount({ authorization: '[REDACTED]', cookie: '[REDACTED]', accept: '*/*' })).toBe(2)
    expect(redactedCount([{ a: { b: '[REDACTED]' } }])).toBe(1)
    expect(redactedCount('x')).toBe(0)
  })
})
