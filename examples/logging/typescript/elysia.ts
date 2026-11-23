import { Elysia, ElysiaCustomStatusResponse } from 'elysia';
import { captureHeaders, errorFields, finish, reportDrop, validateOptions, type Options, type WideEvent } from './logging';

function unsupportedBody(value: unknown): boolean {
  return value instanceof Response || value instanceof ReadableStream || value instanceof Blob ||
    value instanceof ArrayBuffer || ArrayBuffer.isView(value) ||
    !!(value && typeof value === 'object' &&
      (Symbol.asyncIterator in value || Symbol.iterator in value && !Array.isArray(value)));
}

/** Elysia adaptation of Boris Tane's wideEventMiddleware. The outer Fetch wrapper
 * observes local body consumption (not client acknowledgement). It is needed in
 * addition to the plugin: after-handle/after-response alone cannot prove EOF.
 */
export function wideEventMiddleware(options: Options) {
  validateOptions(options);
  const events = new WeakMap<Request, WideEvent>();
  const plugin = new Elysia({ name: 'wide-event-reference' })
    .derive({ as: 'global' }, ({ request }) => {
      const wideEvent = events.get(request);
      if (!wideEvent) throw new Error('Install the middleware fetch wrapper with the plugin');
      return { wideEvent };
    })
    .onBeforeHandle({ as: 'global' }, ({ request, body }) => {
      const event = events.get(request);
      if (!event || !options.requestBody) return;
      const section = event.request as WideEvent;
      if (unsupportedBody(body)) return;
      try {
        const projected = options.requestBody(String(event.path), body);
        if (projected !== undefined) { delete section.body_capture; section.body = projected; }
        else section.body_capture = 'disabled';
      } catch { reportDrop(options, 'request_projection_failed'); }
    })
    .onAfterHandle({ as: 'global' }, ({ request, responseValue }) => {
      const event = events.get(request);
      if (!event || !options.responseBody) return;
      const section = event.response as WideEvent;
      const value = responseValue instanceof ElysiaCustomStatusResponse ? responseValue.response : responseValue;
      // Only already-materialized JSON values: never read/clone a Response or stream.
      if (unsupportedBody(value)) {
        delete section.body_capture;
        return;
      }
      try {
        const projected = options.responseBody(String(event.path), value);
        if (projected !== undefined) { delete section.body_capture; section.body = projected; }
        else section.body_capture = 'disabled';
      } catch { reportDrop(options, 'response_projection_failed'); }
    })
    .onError({ as: 'global' }, ({ request, error }) => {
      const event = events.get(request);
      if (event) event.error = errorFields(error);
    });

  function fetch<Rest extends unknown[]>(handle: (request: Request, ...rest: Rest) => Response | Promise<Response>) {
    return async (request: Request, ...rest: Rest): Promise<Response> => {
      const url = new URL(request.url);
      const started = (options.clock ?? performance.now.bind(performance))();
      let path = url.pathname;
      try { path = options.path?.(url) ?? path; } catch { path = '[OMITTED]'; reportDrop(options, 'path_projection_failed'); }
      let trusted = false;
      try { trusted = options.trustRequestId?.(request) ?? false; } catch { reportDrop(options, 'id_policy_failed'); }
      const incoming = request.headers.get('x-request-id');
      const requestId = trusted && incoming && /^[A-Za-z0-9_.-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
      const event: WideEvent = {
        request_id: requestId, method: request.method, path,
        request: { headers: captureHeaders(request.headers, options.requestHeaders ?? ['content-type']), ...(options.requestBody ? {} : { body_capture: 'disabled' }) },
        response: { ...(options.responseBody ? {} : { body_capture: 'disabled' }) },
      };
      events.set(request, event);
      let ended = false;
      let handlerSettled = false;
      let finalStatus: number | undefined;
      let responseHeaders: Record<string, string | string[]> = {};
      const done = (completed: boolean, error?: unknown) => {
        if (ended) return;
        ended = true;
        request.signal.removeEventListener('abort', abort);
        // Handlers cannot override middleware-owned HTTP identity or final status.
        Object.assign(event, {request_id:requestId,method:request.method,path});
        if (finalStatus === undefined) delete event.status_code; else event.status_code = finalStatus;
        if (!event.response || typeof event.response !== 'object') event.response = {};
        (event.response as WideEvent).headers = responseHeaders;
        if (error !== undefined) event.error = errorFields(error);
        finish(event, started, options, {kind:'http',completed,recovered:false});
        if (handlerSettled) events.delete(request);
      };
      const abort = () => done(false, {name:'AbortError',message:'Request aborted'});
      request.signal.addEventListener('abort', abort, {once:true});
      try {
        const response = await handle(request, ...rest);
        handlerSettled = true;
        if (ended) events.delete(request);
        finalStatus = response.status;
        const headers = new Headers(response.headers);
        headers.set('x-request-id', requestId);
        responseHeaders = captureHeaders(headers, options.responseHeaders ?? ['content-type','x-request-id']);
        if (request.signal.aborted) abort();
        if (response.status === 101 || response.type === 'opaque') {
          done(false, {message:'Response completion unsupported by Fetch adapter'});
          return response;
        }
        if (!response.body) {
          done(true);
          return new Response(null, {status:response.status,statusText:response.statusText,headers});
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) { done(true); controller.close(); reader.releaseLock(); }
              else controller.enqueue(chunk.value);
            } catch (error) { done(false, error); controller.error(error); }
          },
          async cancel() {
            done(false, {name:'AbortError',message:'Response body cancelled'});
            await reader.cancel();
          },
        }, {highWaterMark:0});
        return new Response(body, {status:response.status,statusText:response.statusText,headers});
      } catch (error) {
        handlerSettled = true;
        done(false, error);
        events.delete(request);
        throw error;
      }
    };
  }
  return { plugin, fetch };
}
