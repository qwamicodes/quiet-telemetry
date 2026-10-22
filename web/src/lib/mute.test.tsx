import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MutedNote } from '@/components/muted-note'
import type { LogLine, MuteRule } from '@/gen'
import { isMuted, matchesMute, parseMute, useMuted, useSearchMuted } from '@/lib/mute'
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

describe('muted-lines rules (06.3)', () => {
  it('parses field:value and plain text', () => {
    expect(parseMute(' path:/api/v1/health ')).toEqual({ field: 'path', value: '/api/v1/health' })
    expect(parseMute('http.ua:kube-probe*')).toEqual({ field: 'http.ua', value: 'kube-probe*' })
    expect(parseMute('kube-probe')).toEqual({ field: null, value: 'kube-probe' })
    expect(parseMute('"GET /metrics"')).toEqual({ field: null, value: 'GET /metrics' })
    // A URL is text, not a field called `https`.
    expect(parseMute('https://x.io/a')).toEqual({ field: null, value: 'https://x.io/a' })
    expect(parseMute('  ')).toBeNull()
  })

  it('matches a field exactly or with * wildcards, dot paths, and text anywhere in the raw line', () => {
    const exact: MuteRule = { field: 'path', value: '/api/v1/health' }
    expect(matchesMute(health, exact)).toBe(true)
    expect(matchesMute(healthz, exact)).toBe(false)
    expect(matchesMute(healthz, { field: 'path', value: '/api/v1/health*' })).toBe(true)
    expect(matchesMute(healthz, { field: 'http.ua', value: 'KUBE-PROBE*' })).toBe(true)
    expect(matchesMute(order, { field: 'status', value: '201' })).toBe(true)
    expect(matchesMute(order, { field: 'path', value: '/api/v1/(orders)' })).toBe(false)
    expect(matchesMute(text, { field: null, value: 'prometheus' })).toBe(true)
    expect(matchesMute(text, { field: 'path', value: '*' })).toBe(false)
    expect(matchesMute(text, { field: 'source', value: 'web' })).toBe(true)
    expect(isMuted(order, [exact, { field: null, value: 'kube' }])).toBe(false)
    expect(isMuted(healthz, [exact, { field: null, value: 'kube' }])).toBe(true)
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
        api: { ...DEFAULT_SOURCE_SETTINGS, muted: [{ field: 'path', value: '/api/v1/health*' }] },
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
