import { describe, expect, it } from 'vitest'
import type { LogLine } from '@/gen'
import { activityCounts, buildActivity, type JobRow } from '@/lib/activity'

let id = 0
const ev = (source: string, fields: Record<string, unknown>, level: LogLine['level'] = 'info'): LogLine => {
  id++
  const ids: LogLine['ids'] = []
  if (fields.request_id) ids.push({ key: 'request_id', value: String(fields.request_id) })
  if (fields.job_id) ids.push({ key: 'job_id', value: String(fields.job_id) })
  return {
    id,
    ts: 1_792_000_000_000 + id * 1000,
    received: 0,
    source,
    level,
    display_id: ids[0] ?? null,
    ids,
    msg: '',
    fields,
    raw: '',
  }
}

const request = ev('api', {
  flow: 'create_payout',
  request_id: 'req_1',
  method: 'POST',
  path: '/api/v1/payouts',
  status_code: 201,
  duration_ms: 112,
})
const job = { flow: 'settle_dealer_payout', queue: 'payouts', job_id: 'payout-88-1300', request_id: 'req_1' }
const fail = (attempt: number, extra: Record<string, unknown> = {}) =>
  ev(
    'worker',
    { ...job, attempt, duration_ms: 640, error: { code: 'X', reason: 'insufficient_float' }, ...extra },
    'error',
  )
const ok = (attempt: number) => ev('worker', { ...job, attempt, duration_ms: 200 })

const jobOf = (lines: LogLine[], opened = { key: 'request_id' as const, value: 'req_1' }) =>
  buildActivity(lines, opened).main.find((r): r is JobRow => r.kind === 'job') as JobRow

describe('buildActivity (v0.1.1-04.x)', () => {
  it('a request and its job: request row first, attempts inside the job', () => {
    const a = buildActivity([request, fail(1, { retry: { backoff_ms: 2000 } }), ok(2)], {
      key: 'request_id',
      value: 'req_1',
    })
    expect(a.main.map((r) => r.kind)).toEqual(['request', 'job'])
    expect(a.main[0]).toMatchObject({ label: '201 · Created', tone: 'ok', duration: 112 })
    const j = a.main[1] as JobRow
    expect(j).toMatchObject({ state: 'completed_after_retry', label: 'Completed after retry', exec: 200, lastN: 2 })
    expect(j.attempts.map((x) => x.title)).toEqual(['Attempt 1', 'Attempt 2'])
    expect(j.attempts[0]).toMatchObject({ detail: 'insufficient_float', tone: 'err' })
    expect(a.completions).toBe(3)
    expect(activityCounts(a)).toBe('1 request · 1 job')
  })

  it('job states come only from the events', () => {
    expect(jobOf([ok(1)]).label).toBe('Completed')
    expect(jobOf([fail(1), fail(2), fail(3, { retries_left: 0 })])).toMatchObject({
      state: 'failed',
      label: 'Failed · 3 attempts',
      tone: 'err',
    })
    expect(jobOf([fail(1, { retry: { backoff_ms: 2000 } })]).label).toBe('Retry scheduled')
    // A failed attempt alone doesn't prove the job is finished.
    expect(jobOf([fail(1)])).toMatchObject({ state: 'not_observed', label: 'Completion not observed' })
  })

  it('opened by job id: the job first, its request under Related request', () => {
    const a = buildActivity([request, fail(1), fail(2, { retries_left: 0 })], {
      key: 'job_id',
      value: 'payout-88-1300',
    })
    expect(a.main.map((r) => r.kind)).toEqual(['job'])
    expect(a.related).toHaveLength(1)
    // Opened by the job: the related request isn't counted (04.2).
    expect(activityCounts(a)).toBe('1 job · 2 attempts')
    expect(activityCounts(a, { related: true })).toBe('1 request · 1 job')
  })

  it('child jobs only with an explicit parent link', () => {
    const child = ev('inventory', {
      flow: 'reserve_stock',
      queue: 'inventory',
      job_id: 'stock-1182',
      parent_job_id: 'payout-88-1300',
      duration_ms: 90,
    })
    const sibling = ev('notify', {
      flow: 'send_receipt',
      queue: 'notifications',
      job_id: 'receipt-1182',
      request_id: 'req_1',
    })
    const a = buildActivity([request, ok(1), child, sibling], { key: 'request_id', value: 'req_1' })
    const top = a.main.filter((r): r is JobRow => r.kind === 'job')
    expect(top.map((j) => j.jobId)).toEqual(['payout-88-1300', 'receipt-1182'])
    expect(top[0].children.map((c) => c.jobId)).toEqual(['stock-1182'])
    // Lifecycle only, no completion: unknown, not "queued".
    expect(top[1].label).toBe('Completion not observed')
  })

  it('reads v0.1.0 job lines and leaves other events apart', () => {
    const picked = ev('worker', { phase: 'picked_up', job_id: 'payout:1', request_id: 'req_1' })
    const attempt0 = fail(0, { job_id: 'payout:1', queue: undefined })
    const moved = ev('worker', { phase: 'moved_to_failed', job_id: 'payout:1' }, 'error')
    const tick = ev('cron', { flow: 'tick' })
    const a = buildActivity([picked, attempt0, moved, tick], null)
    const j = a.main.find((r): r is JobRow => r.kind === 'job') as JobRow
    expect(j.attempts.map((x) => x.title)).toEqual(['picked_up', 'Attempt 0', 'moved_to_failed'])
    expect(j.state).toBe('failed')
    expect(a.other.map((o) => o.title)).toEqual(['tick'])
  })
})
