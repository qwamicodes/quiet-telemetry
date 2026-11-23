/** Wide-event lifecycle and tail sampling adapted from Boris Tane:
 * https://loggingsucks.com/ and logging-best-practices (MIT).
 * Capture/redaction, user SLO rules and job recovery are quiet's agreed adaptations.
 */
export type WideEvent = Record<string, unknown>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Completion = { kind: 'http' | 'job'; completed: boolean; recovered: boolean };
export type Options = {
  service: string;
  env: string;
  /** One startup sink. Receives ONLY bounded, sanitized, single-line JSON. */
  write: (line: string) => void | Promise<void>;
  sampleRate?: number;
  slowMs?: number | ((event: WideEvent) => number | undefined);
  sloFailed?: (event: WideEvent, completion: Completion) => boolean;
  retain?: (event: WideEvent, completion: Completion) => boolean;
  /** Count eligible units here, before sampling. Do not export raw event fields. */
  observe?: (event: WideEvent, completion: Completion) => void;
  onDrop?: (reason: string) => void;
  random?: () => number;
  clock?: () => number;
  trustRequestId?: (request: Request) => boolean;
  path?: (url: URL) => string;
  requestHeaders?: string[];
  responseHeaders?: string[];
  redactKeys?: string[];
  scrubText?: (value: string) => string;
  bodyBytes?: number;
  eventBytes?: number;
  /** Project known parsed values; undefined skips capture. Never read streams here. */
  requestBody?: (path: string, body: unknown) => unknown;
  responseBody?: (path: string, body: unknown) => unknown;
};
const keyName = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const credentials = [
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'passwd',
  'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'apikey', 'xapikey', 'paymenttoken', 'privatekey', 'connectionstring',
  'pwd', 'credential', 'credentials', 'paymentcredentials', 'cardnumber',
  'cvv', 'cvc', 'oauthcode', 'oauthstate',
];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const object = (value: unknown): value is WideEvent => !!value && typeof value === 'object' && !Array.isArray(value);

export function validateOptions(options: Options): void {
  if (!options.service || !options.env) throw new Error('service and env are required');
  const rate = options.sampleRate ?? 1;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('sampleRate must be 0..1');
  for (const size of [options.bodyBytes ?? 8192, options.eventBytes ?? 32768])
    if (!Number.isSafeInteger(size) || size < 64) throw new Error('byte limits must be integers >= 64');
  if (typeof options.slowMs === 'number' && (!Number.isFinite(options.slowMs) || options.slowMs < 0))
    throw new Error('slowMs must be finite and nonnegative');
}
export function reportDrop(options: Options, reason: string): void {
  try { options.onDrop?.(reason); } catch { /* Never leak the original event in fallback logging. */ }
}
export function errorFields(error: unknown): WideEvent {
  if (typeof error === 'string') return { message: error };
  if (error instanceof Error) {
    const fields: WideEvent = {};
    for (const name of new Set([...Object.getOwnPropertyNames(error), 'name', 'message', 'stack'])) {
      const descriptor = Object.getOwnPropertyDescriptor(error, name);
      if (descriptor && 'value' in descriptor) fields[name] = descriptor.value;
    }
    fields.name ??= error.name;
    fields.message ??= error.message;
    return fields;
  }
  return object(error) ? error : { message: 'Non-error value thrown', details: error };
}

/** Structural redaction is not a universal detector for secrets inside arbitrary text. */
export function sanitize(value: unknown, options: Options): Json {
  const keys = new Set([...credentials, ...(options.redactKeys ?? []).map(keyName)]);
  const active = new WeakSet<object>();
  let remaining = 10000;
  function visit(input: unknown, depth: number): Json {
    if (--remaining < 0 || depth > 16) return '[TRUNCATED]';
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'string') {
      // Omit unbounded strings rather than cutting through an unknown secret.
      if (input.length > 65536) return '[OMITTED]';
      return options.scrubText ? options.scrubText(input) : input;
    }
    if (typeof input === 'bigint') return String(input);
    if (typeof input !== 'object' || !input) return '[UNSUPPORTED]';
    if (active.has(input)) return '[CIRCULAR]';
    active.add(input);
    try {
      if (Array.isArray(input)) return input.slice(0, 1000).map(v => visit(v, depth + 1));
      const source = input instanceof Error ? errorFields(input) : input;
      const result: Record<string, Json> = Object.create(null);
      for (const name of Object.getOwnPropertyNames(source).slice(0, 1000)) {
        if (name.length > 128 || /[\x00-\x1f]/.test(name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, name);
        if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) continue;
        result[name] = keys.has(keyName(name))
          ? Array.isArray(descriptor.value) ? descriptor.value.slice(0, 1000).map(() => '[REDACTED]') : '[REDACTED]'
          : visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { active.delete(input); }
  }
  return visit(value, 0);
}
function shrink(value: Json): Json {
  if (typeof value === 'string') {
    if (value === '[REDACTED]') return value;
    return value.length > 16 ? value.slice(0, Math.floor(value.length / 2)) : null;
  }
  if (Array.isArray(value)) return value.length > 1 ? value.slice(0, Math.floor(value.length / 2)) : [];
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 1) return Object.fromEntries(entries.slice(0, Math.floor(entries.length / 2)));
    if (entries.length) return { [entries[0]![0]]: shrink(entries[0]![1]) };
  }
  return null;
}
function fit(value: Json, limit: number): Json {
  for (let i = 0; i < 32 && bytes(value) > limit; i++) value = shrink(value);
  return bytes(value) <= limit ? value : null;
}
export function serializeEvent(event: WideEvent, options: Options): string | undefined {
  const safe = sanitize(event, options) as Record<string, Json>;
  const bodyLimit = options.bodyBytes ?? 8192;
  const eventLimit = options.eventBytes ?? 32768;
  for (const side of ['request', 'response']) {
    const section = safe[side];
    if (section && !Array.isArray(section) && typeof section === 'object' && 'body' in section) {
      const original = section.body!;
      section.body = fit(original, bodyLimit);
      if (JSON.stringify(original) !== JSON.stringify(section.body)) section.body_capture = 'truncated';
    }
  }
  if (bytes(safe) > eventLimit) {
    for (const side of ['request', 'response']) {
      const section = safe[side];
      if (section && !Array.isArray(section) && typeof section === 'object' && 'body' in section) {
        delete section.body;
        section.body_capture = 'truncated';
      }
    }
  }
  const core = new Set(['timestamp','level','service','env','request_id','method','path','status_code','duration_ms','flow','error','job_id','attempt']);
  for (const key of Object.keys(safe).filter(key => !core.has(key)).sort((a,b) => bytes(safe[b]) - bytes(safe[a]))) {
    if (bytes(safe) <= eventLimit) break;
    if (key === 'request' || key === 'response') {
      const section = safe[key];
      safe[key] = object(section) && section.body_capture ? { body_capture: section.body_capture as Json } : {};
    } else delete safe[key];
  }
  if (bytes(safe) > eventLimit) return undefined;
  return JSON.stringify(safe);
}
function slow(event: WideEvent, options: Options): boolean {
  const threshold = typeof options.slowMs === 'function' ? options.slowMs(event) : options.slowMs;
  return threshold !== undefined && Number.isFinite(threshold) && threshold >= 0 && Number(event.duration_ms) >= threshold;
}
export function shouldSample(event: WideEvent, options: Options, completion: Completion): boolean {
  if (event.error != null || Number(event.status_code) >= 400 || event.level === 'error' || event.level === 'warn') return true;
  if (slow(event, options) || (completion.kind === 'job' && completion.completed && completion.recovered)) return true;
  if (options.sloFailed?.(event, completion) || options.retain?.(event, completion)) return true;
  return (options.random ?? Math.random)() < (options.sampleRate ?? 1);
}
/** Middleware-owned finalization, never called from business handlers. */
export function finish(event: WideEvent, start: number, options: Options, completion: Completion): void {
  try {
    event.timestamp = new Date().toISOString();
    event.duration_ms = Math.max(0, (options.clock ?? performance.now.bind(performance))() - start);
    event.service = options.service;
    event.env = options.env;
    if (event.error != null) event.error = errorFields(event.error);
    const success = completion.completed && (completion.kind === 'job' || (Number(event.status_code) >= 200 && Number(event.status_code) < 400));
    let isSlow = false;
    try { isSlow = slow(event, options); } catch { reportDrop(options, 'sampling_failed'); }
    event.level = event.error != null || Number(event.status_code) >= 400 || !completion.completed ? 'error' : success && isSlow ? 'warn' : success ? 'info' : 'warn';
    try { options.observe?.(event, completion); } catch { reportDrop(options, 'measurement_failed'); }
    let retain = true;
    try { retain = shouldSample(event, options, completion); } catch { reportDrop(options, 'sampling_failed'); }
    if (!retain) return;
    const line = serializeEvent(event, options);
    if (line === undefined) { reportDrop(options, 'event_too_large'); return; }
    const written = options.write(line);
    if (written) void Promise.resolve(written).catch(() => reportDrop(options, 'logging_failed'));
  } catch { reportDrop(options, 'logging_failed'); }
}
export function captureHeaders(headers: Headers, names: string[]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  for (const name of names) {
    const key = name.toLowerCase();
    if (key === 'set-cookie' && headers.getSetCookie().length) result[key] = headers.getSetCookie();
    else if (headers.has(key)) result[key] = headers.get(key)!;
  }
  return result;
}
/** Queue-neutral adaptation. A real queue adapter supplies native identity and recovery evidence. */
export async function wideEventWorker<T>(
  metadata: WideEvent,
  process: (event: WideEvent) => Promise<T>,
  options: Options,
  confirmedRecovery: () => boolean = () => false,
): Promise<T> {
  validateOptions(options);
  const event: WideEvent = structuredClone(metadata);
  for (const key of ['method','path','status_code','request','response']) delete event[key];
  const start = (options.clock ?? performance.now.bind(performance))();
  let completed = false;
  try { const result = await process(event); completed = true; return result; }
  catch (error) { event.error = errorFields(error); throw error; }
  finally {
    let recovered = false;
    try { recovered = completed && confirmedRecovery(); } catch { reportDrop(options, 'recovery_evidence_failed'); }
    finish(event, start, options, {kind:'job',completed,recovered});
  }
}
