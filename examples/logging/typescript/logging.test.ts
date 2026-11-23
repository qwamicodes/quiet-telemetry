import { describe, test, expect } from 'bun:test';
import { Elysia, t } from 'elysia';
import { wideEventMiddleware } from './elysia';
import { finish, sanitize, serializeEvent, shouldSample, wideEventWorker, type Completion, type Options, type WideEvent } from './logging';
const completed: Completion = {kind:'http',completed:true,recovered:false};
function fixture(overrides: Partial<Options> = {}) {
  const lines: WideEvent[] = [], measured: WideEvent[] = [], drops: string[] = [];
  const options: Options = {service:'test',env:'test',write:s => { lines.push(JSON.parse(s)); },observe:e => measured.push({...e}),onDrop:r => drops.push(r),...overrides};
  return {lines,measured,drops,options};
}
function setup(overrides: Partial<Options> = {}) {
  const f = fixture(overrides), logging = wideEventMiddleware(f.options);
  const app = new Elysia().use(logging.plugin)
    .get('/ok/:id', async ({wideEvent,params}) => {
      wideEvent.flow = 'read'; wideEvent.user = {id:params.id};
      await Bun.sleep(params.id === 'a' ? 10 : 1);
      return {ok:true};
    })
    .get('/handled', ({wideEvent,status}) => {wideEvent.error={code:'DECLINED',details:['a',false,12,null]}; return status(302,'redirect');})
    .get('/throws', () => {throw new Error('boom');})
    .get('/bad-request', ({status}) => status(400,{invalid:true}))
    .post('/body', ({body,wideEvent,status}) => {wideEvent.customer={email:'demo@example.test',msisdn:'+15555550123'};return status(201,body);},{body:t.Object({password:t.String(),note:t.String()})});
  return {...f,app,handle:logging.fetch(request=>app.handle(request)),logging};
}
describe('middleware',()=>{
  test('isolates concurrent events, actual status, response IDs and once at body completion',async()=>{
    const f=setup();
    const [a,b]=await Promise.all(['a','b'].map(id=>f.handle(new Request('http://localhost/ok/'+id))));
    expect(f.lines).toHaveLength(0);
    await Promise.all([a.text(),b.text()]);
    expect(f.lines).toHaveLength(2);
    expect(new Set(f.lines.map(e=>(e.user as WideEvent).id))).toEqual(new Set(['a','b']));
    expect(new Set(f.lines.map(e=>e.request_id)).size).toBe(2);
    expect(f.lines.every(e=>e.status_code===200 && e.level==='info')).toBe(true);
    expect(f.lines.some(e=>e.request_id===a.headers.get('x-request-id'))).toBe(true);
  });
  test('zero sampling still measures ordinary success and retains 4xx, thrown error, handled redirect',async()=>{
    const f=setup({sampleRate:0});
    for(const path of ['/ok/a','bad-request','throws','handled','missing']){
      const response=await f.handle(new Request('http://localhost/'+path.replace(/^\//,'')));await response.text();
    }
    expect(f.measured).toHaveLength(5);expect(f.lines).toHaveLength(4);
    expect(f.lines.map(e=>e.status_code)).toEqual([400,500,302,404]);
    expect(f.lines[2]!.error).toEqual({code:'DECLINED',details:['a',false,12,null]});
  });
  test('validation errors before handler are recorded with actual 422',async()=>{
    const f=setup({sampleRate:0});const response=await f.handle(new Request('http://localhost/body',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));await response.text();
    expect(response.status).toBe(422);expect(f.lines).toHaveLength(1);expect(f.lines[0]!.status_code).toBe(422);
  });
  test('capture projections, nested redaction and UTF8 body bound do not alter response',async()=>{
    const f=setup({bodyBytes:64,requestHeaders:['authorization','content-type'],requestBody:(_p,b)=>b,responseBody:(_p,b)=>b});
    const original={password:'secret-sentinel',note:'界'.repeat(100)};
    const r=await f.handle(new Request('http://localhost/body',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer sentinel'},body:JSON.stringify(original)}));
    expect(await r.json()).toEqual(original);
    const line=JSON.stringify(f.lines[0]);expect(line).not.toContain('secret-sentinel');expect(line).not.toContain('Bearer sentinel');expect(line).toContain('demo@example.test');
    const request=f.lines[0]!.request as WideEvent;expect(request.body_capture).toBe('truncated');expect(Buffer.byteLength(JSON.stringify(request.body))).toBeLessThanOrEqual(64);
  });
  test('untrusted IDs are replaced; configured trusted IDs are validated',async()=>{
    for(const [trust,id,accepted] of [[false,'req_trusted',false],[true,'req_trusted',true],[true,'bad id',false]] as const){
      const f=setup({trustRequestId:()=>trust});const r=await f.handle(new Request('http://localhost/ok/a',{headers:{'x-request-id':id}}));await r.text();
      expect(r.headers.get('x-request-id')===id).toBe(accepted);
    }
  });
  test('body cancellation emits once and does not invent successful completion',async()=>{
    const f=fixture({sampleRate:0});const m=wideEventMiddleware(f.options);
    let cancelled=false;
    const handle=m.fetch(()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}})));
    const r=await handle(new Request('http://localhost/stream'));expect(f.lines).toHaveLength(0);
    await r.body!.cancel();expect(cancelled).toBe(true);expect(f.lines).toHaveLength(1);expect(f.lines[0]!.level).toBe('error');expect(f.lines[0]!.status_code).toBe(200);
  });
  test('request abort + cancellation still emits once',async()=>{
    const f=fixture({sampleRate:0}), m=wideEventMiddleware(f.options), controller=new AbortController();
    const r=await m.fetch(()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));}})))(new Request('http://localhost/stream',{signal:controller.signal}));
    controller.abort();await r.body!.cancel();expect(f.lines).toHaveLength(1);
  });
  test('an early abort does not remove context while the handler is still running',async()=>{
    const f=setup({sampleRate:0}), controller=new AbortController();
    const handle=f.logging.fetch(async request=>{await Bun.sleep(10);return f.app.handle(request);});
    const promise=handle(new Request('http://localhost/ok/a',{signal:controller.signal}));
    controller.abort();const response=await promise;
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true});expect(f.lines).toHaveLength(1);
  });
  test('response projections receive the body inside an Elysia status result',async()=>{
    const f=setup({responseBody:(_path,b)=>({note:(b as {note:string}).note})});
    const response=await f.handle(new Request('http://localhost/body',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'secret',note:'hello'})}));
    await response.text();expect((f.lines[0]!.response as WideEvent).body).toEqual({note:'hello'});
  });
  test('sink exceptions never change the successful response',async()=>{
    const f=setup({write(){throw new Error('sink down');}});const r=await f.handle(new Request('http://localhost/ok/a'));
    expect(await r.json()).toEqual({ok:true});expect(r.status).toBe(200);expect(f.drops).toContain('logging_failed');
  });
  test('rejected async sink is observed without rejecting the response',async()=>{
    const f=setup({write:async()=>{throw new Error('sink down');}});
    const response=await f.handle(new Request('http://localhost/ok/a'));expect(await response.json()).toEqual({ok:true});
    await Bun.sleep(0);expect(f.drops).toContain('logging_failed');
  });
  test('routes not opted into capture stay disabled',async()=>{
    const f=setup({requestBody:()=>undefined,responseBody:()=>undefined});
    const response=await f.handle(new Request('http://localhost/ok/a'));await response.text();
    expect((f.lines[0]!.request as WideEvent).body_capture).toBe('disabled');
    expect((f.lines[0]!.response as WideEvent).body_capture).toBe('disabled');
  });
  test('files bypass body projection and stay unchanged',async()=>{
    let projections=0;
    const f=fixture({responseBody:()=>{projections++;return {unsafe:'file'};}});
    const m=wideEventMiddleware(f.options), app=new Elysia().use(m.plugin).get('/file',()=>new Blob(['original']));
    const response=await m.fetch(request=>app.handle(request))(new Request('http://localhost/file'));
    expect(await response.text()).toBe('original');expect(projections).toBe(0);
    expect(f.lines[0]!.response).not.toHaveProperty('body');
  });
});
describe('sampling and sanitization',()=>{
  test('exact slow boundary, SLO criteria and business retention',()=>{
    const f=fixture({sampleRate:0,slowMs:500,sloFailed:e=>e.flow==='bad',retain:e=>e.flow==='vip'});
    expect(shouldSample({status_code:200,duration_ms:499},f.options,completed)).toBe(false);
    expect(shouldSample({status_code:200,duration_ms:500},f.options,completed)).toBe(true);
    expect(shouldSample({status_code:200,flow:'bad'},f.options,completed)).toBe(true);
    expect(shouldSample({status_code:200,flow:'vip'},f.options,completed)).toBe(true);
    let time=500;const event:WideEvent={status_code:200};finish(event,0,{...f.options,clock:()=>time},completed);expect(f.lines[0]!.level).toBe('warn');
  });
  test('recursive custom masking, cycles, getters, errors and no mutation',()=>{
    const source:WideEvent={customer:{email:'demo@example.test',phone:'123',custom_secret:'sentinel'},items:[{ACCESS_TOKEN:'hidden'}]};source.self=source;
    Object.defineProperty(source,'throwing',{get(){throw new Error('getter should not run');}});
    const safe=sanitize(source,{...fixture().options,redactKeys:['custom-secret']}) as WideEvent;
    expect(JSON.stringify(safe)).not.toContain('sentinel');expect(JSON.stringify(safe)).not.toContain('hidden');expect(JSON.stringify(safe)).toContain('demo@example.test');expect(safe.self).toBe('[CIRCULAR]');expect((source.customer as WideEvent).custom_secret).toBe('sentinel');
    expect(sanitize({'set-cookie':['a=secret','b=secret']},fixture().options)).toEqual({'set-cookie':['[REDACTED]','[REDACTED]']});
  });
  test('a failing slow predicate keeps the completion and measurement',()=>{
    const f=fixture({sampleRate:0,slowMs:()=>{throw new Error('bad policy');},clock:()=>1});
    finish({status_code:200},0,f.options,completed);
    expect(f.lines).toHaveLength(1);expect(f.measured).toHaveLength(1);expect(f.drops).toContain('sampling_failed');
  });
  test('bounds full events without invalid JSON; oversized core reports drop',()=>{
    const f=fixture({eventBytes:512});
    const line=serializeEvent({timestamp:'now',level:'info',service:'a',env:'test',request_id:'r',status_code:200,duration_ms:1,notes:'界'.repeat(2000)},f.options)!;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(512);expect(JSON.parse(line).request_id).toBe('r');
    finish({flow:'x'.repeat(2000)},0,{...f.options,clock:()=>1},completed);expect(f.drops).toContain('event_too_large');
  });
});
test('jobs retain failures and confirmed recovery at 0%, no HTTP fields, unchanged SLO counts',async()=>{
  const f=fixture({sampleRate:0});
  await expect(wideEventWorker({job_id:'j',attempt:0},async()=>{throw new Error('failed');},f.options)).rejects.toThrow('failed');
  await wideEventWorker({job_id:'j',attempt:1},async e=>{e.order={id:'o'};},f.options,()=>true);
  await wideEventWorker({job_id:'first',attempt:0},async()=>{},f.options);
  expect(f.lines).toHaveLength(2);expect(f.measured).toHaveLength(3);expect(f.lines[1]!.level).toBe('info');expect(f.lines[1]).not.toHaveProperty('status_code');expect(f.lines[1]).not.toHaveProperty('request_id');
});
