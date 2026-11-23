// Sample canonical completion events for local testing (v0.1.1 contract,
// docs/logging-guide.md). No dependencies.
//   bun deploy/sample/generate.mjs [api|worker|both]
// Env:
//   RATE        requests per second (default 3)
//   QUIET_URL   POST lines to <url>/ingest/ndjson (X-Quiet-Source: sample-api / sample-worker)
//   QUIET_TOKEN an ingest token (qi_…); not needed when quiet runs with QUIET_INGEST_AUTH=open
//   STDOUT_SOURCE  lines of this source go to stdout only (read by quiet's Docker
//                  receiver); the rest are POSTed. Without QUIET_URL everything
//                  goes to stdout.
// Both sources come from one process so a payout job carries the request_id of
// the API request that enqueued it, and flows stitch across sources.
//
// One event per request and one per job attempt, written when the work ends:
// timestamp · level · service/env/version · flow · request_id · method · path ·
// status_code · duration_ms · request/response (headers, body_capture) ·
// business fields · typed error. Credentials are already [REDACTED]; email
// stays visible. No outcome, msg or wideEvents.

const mode = process.argv[2] ?? 'both'
const rate = Number(process.env.RATE ?? 3)
const url = process.env.QUIET_URL
const token = process.env.QUIET_TOKEN
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const ms = (lo, hi) => Math.round(lo + Math.random() * (hi - lo))
const reqId = (n) => `req_${((n * 2654435761) % 0xfffff).toString(16).padStart(5, '0')}`
const SLOW_MS = 1000
const deploy = { env: 'production', version: '1.42.0', commit_sha: 'a1b2c3d' }

// [method, route, flow, status, error?]
const routes = [
  ['GET', '/api/v1/orders', 'list_orders', 200],
  ['GET', '/api/v1/orders', 'list_orders', 200],
  ['POST', '/api/v1/orders', 'create_order', 201],
  ['GET', '/api/v1/orders/:id', 'get_order', 200],
  ['GET', '/api/v1/cases/:id', 'get_case', 200],
  ['POST', '/api/v1/cases/:id/notes', 'add_note', 201],
  ['GET', '/api/v1/me', 'get_session', 200],
  ['DELETE', '/api/v1/sessions/me', 'end_session', 204],
  ['POST', '/api/v1/payouts', 'create_payout', 201],
  ['GET', '/api/v1/dealers/:id/payouts', 'list_payouts', 200],
  ['GET', '/api/v1/health', 'health', 200],
  [
    'POST',
    '/api/v1/webhooks/paystack',
    'verify_signature',
    401,
    { name: 'WebhookError', code: 'INVALID_SIGNATURE', message: 'signature does not match', reason: 'invalid_signature' },
  ],
  [
    'POST',
    '/api/v1/payments/charge',
    'charge_card',
    402,
    { name: 'PaymentError', code: 'CARD_DECLINED', message: 'card declined', reason: 'insufficient_funds', details: { provider: 'paystack' } },
  ],
  [
    'GET',
    '/api/v1/reports/:id',
    'build_report',
    500,
    { name: 'ReportError', code: 'REPORT_BUILD_FAILED', message: 'renderer timed out', reason: 'renderer_timeout', details: { renderer: 'pdf' } },
  ],
]

const out = []
const stdoutSource = process.env.STDOUT_SOURCE
process.stdout.on('error', () => process.exit(0)) // e.g. piped into `head`
function emit(source, line) {
  const text = JSON.stringify(line)
  if (!url || source === stdoutSource) console.log(text)
  else out.push([source, text])
}

async function flush() {
  if (!url || out.length === 0) return
  const bySource = new Map()
  for (const [s, t] of out.splice(0)) bySource.set(s, [...(bySource.get(s) ?? []), t])
  for (const [source, lines] of bySource) {
    try {
      await fetch(`${url.replace(/\/$/, '')}/ingest/ndjson`, {
        method: 'POST',
        headers: { 'x-quiet-source': source, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: lines.join('\n'),
      })
    } catch (e) {
      console.error(`ingest failed: ${e.message}`)
    }
  }
}

// error for a recorded error or HTTP >= 400, warn for a slow success, info
// otherwise (health checks log at debug).
function levelFor(status, duration, flow, error) {
  if (error || status >= 400) return 'error'
  if (duration >= SLOW_MS) return 'warn'
  return flow === 'health' ? 'debug' : 'info'
}

// One HTTP request = one completion event.
function apiEvent(n) {
  const [method, route, flow, base, baseError] = pick(routes)
  const invalid = Math.random() < 0.04 && base < 400
  const status = invalid ? 422 : base
  const error = invalid
    ? { name: 'ValidationError', code: 'INVALID_INPUT', message: 'request body failed validation', details: { field: 'amount' } }
    : baseError
  const id = 1000 + (n % 300)
  const path = route.replace(':id', String(flow === 'list_payouts' ? 88 : id))
  const slow = flow === 'list_payouts' && Math.random() < 0.4
  const duration = status === 500 ? ms(2800, 3600) : slow ? ms(1100, 2100) : flow === 'health' ? ms(1, 4) : ms(9, 160)
  const request_id = reqId(n)
  const business =
    flow === 'create_order' || flow === 'get_order'
      ? { order: { id: `ord_${id}` } }
      : flow === 'create_payout' || flow === 'list_payouts'
        ? { dealer: { id: 80 + (n % 9) } }
        : flow === 'get_session'
          ? { user: { id: `usr_${(n % 97).toString(16)}`, email: `dealer${n % 97}@example.com` } }
          : {}
  emit('sample-api', {
    timestamp: new Date().toISOString(),
    level: levelFor(status, duration, flow, error),
    service: 'sample-api',
    ...deploy,
    flow,
    request_id,
    method,
    path,
    status_code: status,
    duration_ms: duration,
    ...business,
    request: {
      route,
      headers: {
        authorization: '[REDACTED]',
        'content-type': 'application/json',
        'user-agent': pick(['legivent-web/2.3', 'okhttp/4.12', 'curl/8.7']),
      },
      ...(method === 'GET' && route.endsWith('orders') ? { query: { page: '1', limit: '50' } } : {}),
      body_capture: 'disabled',
    },
    response: { headers: { 'content-type': 'application/json', 'x-request-id': request_id }, body_capture: 'disabled' },
    ...(error ? { error } : {}),
  })
  return { flow, status, request_id }
}

// A payout job: one completion event per attempt, numbered from 1 as the queue
// reports it. Failed attempts schedule a retry with backoff; the last one
// fails for good. A job enqueued by a request carries its request_id; a
// standalone job (worker mode) has none.
async function payoutJob(n, request_id) {
  const job_id = `payout-${80 + (n % 9)}-${n % 10000}`
  const base = {
    service: 'sample-worker',
    ...deploy,
    flow: 'settle_dealer_payout',
    queue: 'payouts',
    job_id,
    ...(request_id ? { request_id } : {}),
    dealer: { id: 80 + (n % 9) },
  }
  const fails = pick([0, 0, 0, 1, 2, 3])
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(ms(50, 200))
    const duration = attempt <= fails ? ms(300, 2100) : ms(80, 600)
    const queue_wait_ms = attempt === 1 ? ms(5, 120) : 2000 * 2 ** (attempt - 2)
    if (attempt <= fails) {
      const final = attempt === attempts
      const code = pick(['TRANSFER_TIMEOUT', 'INSUFFICIENT_FLOAT'])
      emit('sample-worker', {
        timestamp: new Date().toISOString(),
        level: 'error',
        ...base,
        attempt,
        duration_ms: duration,
        queue_wait_ms,
        error: {
          name: 'TransferError',
          code,
          message: 'paystack transfer failed',
          reason: code === 'TRANSFER_TIMEOUT' ? 'upstream_timeout' : 'insufficient_float',
          details: { provider: 'paystack' },
        },
        ...(final ? { retries_left: 0 } : { retry: { backoff_ms: 2000 * 2 ** (attempt - 1) } }),
      })
      if (final) return
      continue
    }
    emit('sample-worker', {
      timestamp: new Date().toISOString(),
      level: 'info',
      ...base,
      attempt,
      duration_ms: duration,
      queue_wait_ms,
    })
    return
  }
}

const sleep = (t) => new Promise((r) => setTimeout(r, t))

let n = Math.floor(Date.now() / 1000)
console.log(`sample generator: mode=${mode} rate=${rate}/s${url ? ` ingest=${url}` : ''}`)
setInterval(flush, 500)
setInterval(() => {
  n++
  if (mode === 'api' || mode === 'both') {
    const r = apiEvent(n)
    // A created payout enqueues its settlement job with the same request_id.
    if (mode === 'both' && r.flow === 'create_payout' && r.status < 400) payoutJob(n, r.request_id)
  }
  // Worker-only mode: standalone jobs with no parent request.
  if (mode === 'worker' && n % 3 === 0) payoutJob(n)
}, 1000 / rate)
