import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLine } from '@/gen'
import { applyFrame, applyFrames, backoff, streamKey, streamUrl, useStream } from './use-stream'

const line = (id: number): LogLine => ({
  id,
  ts: id,
  received: id,
  source: 'api',
  level: 'info',
  display_id: null,
  ids: [],
  msg: `m${id}`,
  raw: '',
})

describe('applyFrame', () => {
  it('backlog replaces, lines append, cap trims oldest', () => {
    let s = applyFrame([line(9)], { type: 'backlog', lines: [line(1), line(2)] }, 3)
    expect(s.map((l) => l.id)).toEqual([1, 2])
    s = applyFrame(s, { type: 'lines', lines: [line(3), line(4)] }, 3)
    expect(s.map((l) => l.id)).toEqual([2, 3, 4])
    expect(applyFrame(s, { type: 'gap', dropped: 5 }, 3)).toBe(s)
  })
})

describe('applyFrames', () => {
  const empty = { key: null, source: null, lines: [] as LogLine[] }
  it('a backlog claims the buffer for its stream; live lines only extend their own stream', () => {
    const a = streamKey({ source: 'api' })
    const b = streamKey({ source: 'api', q: 'slow' })
    const filled = applyFrames(empty, [{ type: 'backlog', lines: [line(1)] }], a, 'api', 10)
    expect(filled).toEqual({ key: a, source: 'api', lines: [line(1)] })
    // Lines of stream b before b's backlog: not grafted onto a's rows.
    expect(applyFrames(filled, [{ type: 'lines', lines: [line(2)] }], b, 'api', 10)).toBe(filled)
    const next = applyFrames(
      filled,
      [
        { type: 'backlog', lines: [] },
        { type: 'lines', lines: [line(3)] },
      ],
      b,
      'api',
      10,
    )
    expect(next).toEqual({ key: b, source: 'api', lines: [line(3)] })
  })
})

describe('streamUrl', () => {
  it('builds ws url with filters', () => {
    const u = streamUrl({ source: 'api', level: 'warn', q: 'slow' }, { protocol: 'https:', host: 'q.example' })
    expect(u).toBe('wss://q.example/api/stream?source=api&backlog=1000&level=warn&q=slow')
  })
})

describe('backoff', () => {
  it('doubles from 500ms, caps at 10s, jitters ±20%', () => {
    const mid = () => 0.5
    expect([1, 2, 3, 4, 5, 6, 9].map((a) => backoff(a, mid))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000])
    expect(backoff(1, () => 0)).toBe(400)
    expect(backoff(1, () => 1)).toBe(600)
  })
})

/** Minimal WebSocket double: tests drive open/message/close by hand. */
class FakeSocket {
  static all: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  open() {
    this.onopen?.()
  }
  send(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop() {
    this.onclose?.()
  }
  close() {
    this.closed = true
  }
}

describe('useStream', () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('goes live, applies frames, reconnects with backoff and replaces the buffer', async () => {
    const { result, unmount } = renderHook(() => useStream({ source: 'api' }))
    expect(result.current.state).toBe('connecting')
    const first = FakeSocket.all[0]
    expect(first.url).toContain('source=api')

    act(() => {
      first.open()
      first.send({ type: 'backlog', lines: [line(1), line(2)] })
      first.send({ type: 'lines', lines: [line(3)] })
      first.send({ type: 'gap', dropped: 7 })
    })
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.state).toBe('live')
    expect(result.current.lines.map((l) => l.id)).toEqual([1, 2, 3])
    expect(result.current.dropped).toBe(7)

    // Server goes away: reconnecting, retry scheduled ~500ms out.
    act(() => first.drop())
    expect(result.current.state).toBe('reconnecting')
    expect(result.current.attempt).toBe(1)
    expect(FakeSocket.all).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    const second = FakeSocket.all[1]
    expect(second).toBeDefined()

    // Backlog on the new socket replaces what we had (no duplicates).
    act(() => {
      second.open()
      second.send({ type: 'backlog', lines: [line(2), line(3), line(4)] })
    })
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.state).toBe('live')
    expect(result.current.attempt).toBe(0)
    expect(result.current.lines.map((l) => l.id)).toEqual([2, 3, 4])

    unmount()
    expect(second.closed).toBe(true)
  })

  it('retryNow skips the wait and garbage frames are ignored', async () => {
    const { result } = renderHook(() => useStream({ source: 'api' }))
    const first = FakeSocket.all[0]
    act(() => {
      first.open()
      first.onmessage?.({ data: 'not json' })
      first.drop()
    })
    expect(FakeSocket.all).toHaveLength(1)
    act(() => result.current.retryNow())
    expect(FakeSocket.all).toHaveLength(2)
    // A second call while a socket is connecting does nothing.
    act(() => result.current.retryNow())
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('a filter change keeps the previous rows (stale, unsettled) until the new backlog lands', async () => {
    const { result, rerender } = renderHook((p: { q?: string }) => useStream({ source: 'api', q: p.q }), {
      initialProps: {},
    })
    expect(result.current.settled).toBe(false)
    const first = FakeSocket.all[0]
    act(() => {
      first.open()
      first.send({ type: 'backlog', lines: [line(1), line(2)] })
    })
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toMatchObject({ settled: true, stale: false })

    // The very render that changes the filter is already unsettled: the old
    // rows are kept (stale), never an empty "settled" list.
    rerender({ q: 'nothing' })
    expect(result.current.settled).toBe(false)
    expect(result.current.stale).toBe(true)
    expect(result.current.lines.map((l) => l.id)).toEqual([1, 2])
    const second = FakeSocket.all[1]
    expect(second.url).toContain('q=nothing')
    expect(first.closed).toBe(true)

    // Open but no backlog yet: still unsettled, rows still the old ones.
    act(() => second.open())
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toMatchObject({ state: 'live', settled: false, stale: true })

    // A late frame from the old socket must not land in the new filter's buffer.
    act(() => first.send({ type: 'backlog', lines: [line(9)] }))
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.settled).toBe(false)
    expect(result.current.lines.map((l) => l.id)).toEqual([1, 2])

    // The new filter's backlog: settled, and genuinely empty.
    act(() => second.send({ type: 'backlog', lines: [] }))
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toMatchObject({ settled: true, stale: false, lines: [] })
  })

  it('a new source starts empty and unsettled instead of showing the old source', async () => {
    const { result, rerender } = renderHook((p: { source: string }) => useStream({ source: p.source }), {
      initialProps: { source: 'api' },
    })
    act(() => {
      FakeSocket.all[0].open()
      FakeSocket.all[0].send({ type: 'backlog', lines: [line(1)] })
    })
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    rerender({ source: 'worker' })
    expect(result.current).toMatchObject({ settled: false, stale: false, lines: [] })
  })

  it('does not connect without a source', () => {
    renderHook(() => useStream({ source: null }))
    expect(FakeSocket.all).toHaveLength(0)
  })
})
