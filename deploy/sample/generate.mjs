// Sample canonical log lines for local testing. No dependencies.
//   bun deploy/sample/generate.mjs [api|worker|both]
// Env:
//   RATE        requests per second (default 3)
//   QUIET_URL   POST lines to <url>/ingest/ndjson (X-Quiet-Source: sample-api / sample-worker)
//   QUIET_TOKEN an ingest token (qi_…); not needed when quiet runs with QUIET_INGEST_AUTH=open
//   STDOUT_SOURCE  lines of this source go to stdout only (read by quiet's Docker
//                  receiver); the rest are POSTed. Without QUIET_URL everything
//                  goes to stdout.
// Both sources come from one process so a worker job's data.request_id matches
// the API request that enqueued it, and flows stitch across sources.

const mode = process.argv[2] ?? 'both'
const rate = Number(process.env.RATE ?? 3)
const url = process.env.QUIET_URL
const token = process.env.QUIET_TOKEN
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const ms = (lo, hi) => Math.round(lo + Math.random() * (hi - lo))
const reqId = (n) => `req_${(n * 2654435761 % 0xfffff).toString(16).padStart(5, '0')}`

const routes = [
  ['GET', '/api/v1/orders', 'list_orders', 200],
  ['POST', '/api/v1/orders', 'create_order', 201],
  ['GET', '/api/v1/orders/:id', 'get_order', 200],
  ['POST', '/api/v1/payouts', 'create_payout', 201],
  ['GET', '/api/v1/health', 'health', 200],
  ['POST', '/api/v1/webhooks/paystack', 'verify_signature', 401],
  ['GET', '/api/v1/reports/:id', 'build_report', 500],
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

// One HTTP request = one canonical line (wideEvents.calls = what it did).
function apiLine(n) {
  const [method, route, op, base] = pick(routes)
  const status = Math.random() < 0.05 && base < 400 ? 422 : base
  const path = route.replace(':id', String(1000 + (n % 300)))
  const calls = [
    { name: 'db.query', target: 'postgres', duration_ms: ms(1, 30), ok: true },
    ...(op === 'create_payout' || op === 'create_order'
      ? [{ name: 'queue.enqueue', target: 'bullmq', queue: op === 'create_payout' ? 'payouts' : 'orders', job_id: `${op === 'create_payout' ? 'payout' : 'order'}:${n}`, duration_ms: ms(1, 5), ok: true }]
      : []),
    ...(op === 'verify_signature' ? [{ name: 'paystack.verify', target: 'paystack', duration_ms: ms(5, 40), ok: false, error: 'bad signature' }] : []),
  ]
  const duration = calls.reduce((a, c) => a + c.duration_ms, ms(2, 20)) * (status === 500 ? 40 : 1)
  emit('sample-api', {
    level: status >= 500 ? 50 : status >= 400 ? 40 : op === 'health' ? 20 : 30,
    time: Date.now(),
    service: 'sample-api',
    request_id: reqId(n),
    method,
    path,
    route,
    status,
    duration_ms: duration,
    msg: `${op} → ${status}`,
    wideEvents: { flow: op, calls, outcome: status < 400 ? 'ok' : 'failed' },
    ...(status >= 500 ? { error: { message: 'report timed out', code: 'REPORT_TIMEOUT' } } : {}),
  })
}

// A job picked up, retried with backoff, then completed or moved to failed.
async function workerJob(n) {
  const job_id = `payout:${n}`
  const request_id = reqId(n)
  const base = { service: 'sample-worker', queue: 'payouts', job_id, data: { request_id, dealer_id: 80 + (n % 9) } }
  emit('sample-worker', { level: 30, time: Date.now(), ...base, phase: 'picked_up', msg: 'job picked up', attempt: 0 })
  const fails = pick([0, 0, 0, 1, 2, 3])
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(ms(50, 200))
    if (attempt < fails) {
      emit('sample-worker', {
        level: attempt === 2 ? 50 : 40,
        time: Date.now(),
        ...base,
        phase: 'settle_dealer_payout',
        attempt,
        outcome: 'failed',
        duration_ms: ms(300, 2100),
        err: { code: pick(['TRANSFER_TIMEOUT', 'INSUFFICIENT_FLOAT']), message: 'paystack transfer failed' },
        msg: attempt === 2 ? 'job failed' : 'job attempt failed, retrying',
        backoff_ms: 2000 * 2 ** attempt,
      })
      continue
    }
    emit('sample-worker', { level: 30, time: Date.now(), ...base, phase: 'settle_dealer_payout', attempt, outcome: 'completed', duration_ms: ms(80, 600), msg: 'job completed' })
    return
  }
  emit('sample-worker', { level: 50, time: Date.now(), ...base, phase: 'moved_to_failed', msg: 'moved to failed', retries_left: 0 })
}

const sleep = (t) => new Promise((r) => setTimeout(r, t))

let n = Math.floor(Date.now() / 1000)
console.log(`sample generator: mode=${mode} rate=${rate}/s${url ? ` ingest=${url}` : ''}`)
setInterval(flush, 500)
setInterval(() => {
  n++
  if (mode === 'api' || mode === 'both') apiLine(n)
  // Roughly one in three requests enqueues a payout job with the same request_id.
  if ((mode === 'worker' || mode === 'both') && n % 3 === 0) workerJob(n)
}, 1000 / rate)
