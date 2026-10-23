import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MutedNote } from '@/components/muted-note'
import type { LogLine, MuteRule, SettingsResponse } from '@/gen'
import {
  defaultOption,
  draftRule,
  effectiveRules,
  isMuted,
  matchesMute,
  methodOf,
  muteOptions,
  parseMute,
  pickRoute,
  routePath,
  ruleTarget,
  ruleText,
  sameRule,
  storedAs,
  useMuted,
  useSearchMuted,
} from '@/lib/mute'
import { DEFAULT_SOURCE_SETTINGS, SETTINGS_KEY } from '@/lib/settings-api'

const line = (id: number, source: string, fields: Record<string, unknown> | null, raw?: string): LogLine => ({
  id,
  ts: id,
  received: id,
  source,
  level: 'info',
  display_id: null,
  ids: [],
  msg: String(fields?.msg ?? raw ?? ''),
  fields: fields ?? undefined,
  raw: raw ?? JSON.stringify(fields),
})

const health = line(1, 'api', { msg: 'GET', path: '/api/v1/health', status: 200 })
const healthz = line(2, 'api', { msg: 'GET', path: '/api/v1/healthz', http: { ua: 'kube-probe/1.29' } })
const order = line(3, 'api', { msg: 'POST', path: '/api/v1/orders', status: 201 })
const text = line(4, 'web', null, 'GET /metrics 200 Prometheus/2.5')

const legacy = (field: string | null, value: string): MuteRule => ({
  ...draftRule(field ? (field === 'msg' ? 'message' : 'field') : 'text', value, { field }),
  id: `mr_${field}_${value}`,
})

describe('muted-lines rules: shapes (06.14–06.17, 03.19)', () => {
  it('parses field:value and plain text (old editor input)', () => {
    expect(parseMute(' path:/api/v1/health ')).toMatchObject({ shape: 'field', field: 'path', value: '/api/v1/health' })
    expect(parseMute('http.ua:kube-probe*')).toMatchObject({ field: 'http.ua', value: 'kube-probe*' })
    expect(parseMute('kube-probe')).toMatchObject({ shape: 'text', field: null, value: 'kube-probe' })
    expect(parseMute('"GET /metrics"')).toMatchObject({ shape: 'text', value: 'GET /metrics' })
    expect(parseMute('msg:"heartbeat ok"')).toMatchObject({ shape: 'message', value: 'heartbeat ok' })
    // A URL is text, not a field called `https`.
    expect(parseMute('https://x.io/a')).toMatchObject({ shape: 'text', value: 'https://x.io/a' })
    expect(parseMute('  ')).toBeNull()
  })

  it('legacy field and text rules match exactly as before', () => {
    const exact = legacy('path', '/api/v1/health')
    expect(matchesMute(health, exact)).toBe(true)
    expect(matchesMute(healthz, exact)).toBe(false)
    expect(matchesMute(healthz, legacy('path', '/api/v1/health*'))).toBe(true)
    expect(matchesMute(healthz, legacy('http.ua', 'KUBE-PROBE*'))).toBe(true)
    expect(matchesMute(order, legacy('status', '201'))).toBe(true)
    expect(matchesMute(order, legacy('path', '/api/v1/(orders)'))).toBe(false)
    expect(matchesMute(text, legacy(null, 'prometheus'))).toBe(true)
    expect(matchesMute(text, legacy('path', '*'))).toBe(false)
    expect(matchesMute(text, legacy('source', 'web'))).toBe(true)
    expect(isMuted(order, [exact, legacy(null, 'kube')])).toBe(false)
    expect(isMuted(healthz, [exact, legacy(null, 'kube')])).toBe(true)
  })

  it('route rules: pick order, query/host dropped, any route field, * within a segment', () => {
    const probe = line(9, 'api', { msg: 'request completed', method: 'get', path: '/api/v1/health?probe=1' })
    expect(pickRoute(probe)).toEqual({ key: 'path', raw: '/api/v1/health?probe=1', path: '/api/v1/health' })
    expect(methodOf(probe)).toBe('GET')
    const pino = line(10, 'api', { req: { url: 'https://x.io/api/v1/health#a', method: 'HEAD' } })
    expect(pickRoute(pino)?.key).toBe('req.url')
    const both = line(11, 'api', { route: '/orders/:id', path: '/orders/7' })
    expect(pickRoute(both)?.path).toBe('/orders/:id')
    const r = draftRule('route', '/api/v1/health')
    expect(matchesMute(probe, r)).toBe(true)
    expect(matchesMute(pino, r)).toBe(true)
    expect(matchesMute(healthz, r)).toBe(false)
    expect(matchesMute(both, draftRule('route', '/orders/7'))).toBe(true)
    const seg = draftRule('route', '/api/v1/orders/*')
    expect(matchesMute(line(12, 'api', { path: '/api/v1/orders/42' }), seg)).toBe(true)
    expect(matchesMute(line(13, 'api', { path: '/api/v1/orders/42/items' }), seg)).toBe(false)
    expect(routePath('https://x.io')).toBe('/')
    expect(matchesMute(text, r)).toBe(false)
  })

  it('method + route and exact message', () => {
    const get = line(20, 'api', { msg: 'request completed', method: 'GET', path: '/api/v1/ping' })
    const head = line(21, 'api', { msg: 'request completed', method: 'HEAD', path: '/api/v1/ping' })
    const mr = draftRule('method_route', '/api/v1/ping', { method: 'GET' })
    expect(matchesMute(get, mr)).toBe(true)
    expect(matchesMute(head, mr)).toBe(false)
    const msg = draftRule('message', 'Request completed')
    expect(matchesMute(get, msg) && matchesMute(head, msg)).toBe(true)
    expect(matchesMute(line(22, 'api', { msg: 'request completed slowly' }), msg)).toBe(false)
    expect(ruleText(mr)).toBe('GET /api/v1/ping')
    expect(storedAs(mr)).toBe('path:/api/v1/ping method:GET')
    expect(ruleText(msg)).toBe('msg:"Request completed"')
    expect(ruleTarget(draftRule('route', '/x', { field: 'path' }))).toBe('/x')
  })

  it('row options: route any method (default), method + route, message; no route falls back to the message', () => {
    const probe = line(9, 'api', { msg: 'request completed', method: 'GET', path: '/api/v1/health?probe=1' })
    const opts = muteOptions(probe)
    expect(opts.map((o) => o.label)).toEqual([
      'Mute route · any method',
      'Mute GET /api/v1/health only',
      'Mute this exact message',
    ])
    expect(defaultOption(opts).rule).toMatchObject({
      shape: 'route',
      value: '/api/v1/health',
      field: 'path',
      origin: 'hover',
    })
    const beat = muteOptions(line(30, 'worker', null, 'heartbeat ok'))
    expect(beat[0].disabled).toBe('no route field on this line')
    expect(defaultOption(beat).rule).toMatchObject({ shape: 'message', value: 'heartbeat ok' })
    expect(muteOptions(probe, 'global')[0].rule.scope).toBe('global')
  })

  it('effective rules: global ∪ source, paused rules and "Don\'t apply here" left out', () => {
    const g = { ...draftRule('route', '/metrics', { scope: 'global' }), id: 'g1' }
    const g2 = { ...draftRule('route', '/off', { scope: 'global' }), id: 'g2', enabled: false }
    const own = { ...draftRule('message', 'x'), id: 's1' }
    const paused = { ...draftRule('message', 'y'), id: 's2', enabled: false }
    const data = {
      muted_global: [g, g2],
      sources: {
        api: { ...DEFAULT_SOURCE_SETTINGS, muted: [own, paused] },
        web: { ...DEFAULT_SOURCE_SETTINGS, muted_global_off: [{ id: 'g1', by: 'esi', at: 1 }] },
      },
    } as unknown as SettingsResponse
    expect(effectiveRules(data, 'api').map((r) => r.id)).toEqual(['g1', 's1'])
    expect(effectiveRules(data, 'web')).toEqual([])
    expect(effectiveRules(data, 'new-source').map((r) => r.id)).toEqual(['g1'])
    expect(sameRule(draftRule('route', '/METRICS'), g)).toBe(true)
  })
})

describe('useMuted', () => {
  let client: QueryClient
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    )
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
    client.setQueryData(SETTINGS_KEY, {
      sources: {
        api: { ...DEFAULT_SOURCE_SETTINGS, muted: [legacy('path', '/api/v1/health*')] },
        web: { ...DEFAULT_SOURCE_SETTINGS, muted: [] },
      },
    } as never)
  })
  afterEach(() => vi.unstubAllGlobals())
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  it('hides each source’s muted lines, counts them, and shows them on request', () => {
    const lines = [health, healthz, order, text]
    const { result, rerender } = renderHook(({ show }) => useMuted(lines, show), {
      wrapper,
      initialProps: { show: false },
    })
    expect(result.current.muted).toBe(2)
    expect(result.current.visible.map((l) => l.id)).toEqual([3, 4])
    rerender({ show: true })
    expect(result.current.muted).toBe(2)
    expect(result.current.visible).toBe(lines)
  })

  it('search hides them unless the source or the instance includes them; the override wins', () => {
    const lines = [health, healthz, order, text]
    const { result, rerender } = renderHook(({ o }) => useSearchMuted(lines, o), {
      wrapper,
      initialProps: { o: undefined as 'include' | 'hide' | undefined },
    })
    expect(result.current).toMatchObject({ muted: 2, hidden: 2, included: false })
    expect(result.current.visible.map((l) => l.id)).toEqual([3, 4])
    rerender({ o: 'include' })
    expect(result.current).toMatchObject({ muted: 2, hidden: 0, included: true })
    expect(result.current.visible).toBe(lines)
    expect([...result.current.mutedIds]).toEqual([1, 2])

    // The instance includes them; api inherits, so no override is needed.
    client.setQueryData(SETTINGS_KEY, (d: never) => ({
      ...(d as object),
      muted_search: { include: true, origin: 'setting', flag: false },
    }))
    rerender({ o: undefined })
    expect(result.current).toMatchObject({ hidden: 0, included: true })
    rerender({ o: 'hide' })
    expect(result.current).toMatchObject({ hidden: 2, included: false })
    // api says off for itself: hidden again without an override.
    client.setQueryData(SETTINGS_KEY, (d: { sources: Record<string, object> }) => ({
      ...d,
      sources: { ...d.sources, api: { ...d.sources.api, search_include_muted: false } },
    }))
    rerender({ o: undefined })
    expect(result.current).toMatchObject({ hidden: 2, included: false })
  })

  it('in search, an included note reads "N muted lines included · Hide"', () => {
    const onToggle = vi.fn()
    render(<MutedNote count={3} shown={false} included onToggle={onToggle} />)
    expect(screen.getByTestId('muted-note')).toHaveTextContent('3 muted lines included')
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(onToggle).toHaveBeenCalled()
  })

  it('the note says how many and toggles', () => {
    const onToggle = vi.fn()
    render(<MutedNote count={12} shown={false} onToggle={onToggle} />)
    expect(screen.getByTestId('muted-note')).toHaveTextContent('12 muted')
    fireEvent.click(screen.getByRole('button', { name: 'Show muted' }))
    expect(onToggle).toHaveBeenCalled()
  })
})
