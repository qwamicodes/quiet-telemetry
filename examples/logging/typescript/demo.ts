import { Elysia } from 'elysia';
import { wideEventMiddleware } from './elysia';
import { wideEventWorker, type Options } from './logging';

// Illustrative user settings, not targets selected automatically by quiet.
const options: Options = {
  service: 'orders-api', env: 'development', write: line => console.log(line),
  sampleRate: 0.1, slowMs: 500,
  sloFailed: (event, boundary) => boundary.kind === 'http' && event.path === '/orders' &&
    (!boundary.completed || event.status_code !== 201 || event.error != null || Number(event.duration_ms) >= 500),
  requestHeaders: ['content-type','authorization'],
  redactKeys: ['payment_token'],
  // Metrics should use bounded labels, never IDs or the whole event.
  observe: (_event, _boundary) => { /* update unsampled counters/histograms here */ },
  onDrop: reason => console.error(JSON.stringify({level:'warn',message:'Logging health',reason})),
};
const logging = wideEventMiddleware(options);
const app = new Elysia().use(logging.plugin)
  .post('/orders', ({ wideEvent, status }) => {
    wideEvent.flow = 'create_order';
    wideEvent.order = {id:'ord_example', total_cents:4999};
    wideEvent.user = {id:'usr_example',email:'demo@example.test'};
    return status(201, {order_id:'ord_example'});
  })
  .get('/handled', ({wideEvent}) => {
    wideEvent.flow = 'charge_card';
    wideEvent.error = {code:'PAYMENT_DECLINED',reason:'insufficient_funds',details:'Bank declined'};
    return {accepted:false};
  })
  .get('/throws', () => { throw new Error('Example failure'); });

// Uses documented app.handle; no private Elysia .wrap API. No WebSocket routes.
if (import.meta.main) {
  const server = Bun.serve({port:3100,fetch:logging.fetch(request => app.handle(request))});
  console.error(`Example listening at ${server.url}`);
}

export async function workerDemo() {
  const queueFacts = {job_id:'job_example',attempt:2,request_id:'req_example',flow:'deliver_order'};
  await wideEventWorker(queueFacts, async event => {
    event.order = {id:'ord_example'};
    // In real code, await the actual processor / completion boundary here.
  }, {...options,service:'order-worker',sampleRate:0}, () => true);
  // true above is fixture evidence of a completed retry. A real queue adapter
  // must establish that fact using its native retry/completion semantics.
}
