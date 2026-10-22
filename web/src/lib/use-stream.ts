import { useCallback, useEffect, useRef, useState } from 'react'
import type { Frame, LogLine } from '@/gen'

export type ConnState = 'connecting' | 'live' | 'reconnecting'

export interface StreamOptions {
  source: string | null
  level?: string
  q?: string
  /** Client-side cap; the oldest lines fall off. */
  max?: number
}

/** Pure reducer so it can be unit-tested without a socket. */
export function applyFrame(prev: LogLine[], frame: Frame, max: number): LogLine[] {
  switch (frame.type) {
    case 'backlog':
      return frame.lines.slice(-max)
    case 'lines': {
      if (frame.lines.length === 0) return prev
      const next = prev.concat(frame.lines)
      return next.length > max ? next.slice(next.length - max) : next
    }
    default:
      return prev
  }
}

export function streamUrl(o: StreamOptions, base: Pick<Location, 'protocol' | 'host'> = location): string {
  const p = new URLSearchParams({ source: o.source ?? '', backlog: '1000' })
  if (o.level) p.set('level', o.level)
  if (o.q) p.set('q', o.q)
  const proto = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${base.host}/api/stream?${p}`
}

/** 0.5s, 1s, 2s, 4s, 8s, 10s… with ±20% jitter so many tabs don't stampede a restarting server. */
export function backoff(attempt: number, random = Math.random): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), 10_000)
  return Math.round(base * (0.8 + 0.4 * random()))
}

function parseFrame(data: unknown): Frame | null {
  if (typeof data !== 'string') return null
  try {
    const f = JSON.parse(data) as Frame
    return f && typeof f === 'object' && typeof f.type === 'string' ? f : null
  } catch {
    return null
  }
}

/**
 * One WebSocket per (source, filters). Reconnects with jittered backoff, right
 * away when the browser comes back online or the tab becomes visible. On
 * reconnect the server resends backlog, which replaces the buffer (no duplicates).
 */
export function useStream(o: StreamOptions) {
  const max = o.max ?? 20_000
  const [lines, setLines] = useState<LogLine[]>([])
  const [state, setState] = useState<ConnState>('connecting')
  const [dropped, setDropped] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [retryAt, setRetryAt] = useState<number | null>(null)
  const retryRef = useRef<() => void>(() => {})

  const { source, level, q } = o
  useEffect(() => {
    setLines([])
    setDropped(0)
    setAttempt(0)
    setRetryAt(null)
    if (!source) return
    let ws: WebSocket | null = null
    let disposed = false
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let raf = 0
    let pending: Frame[] = []

    // Coalesce frames into one render per animation frame.
    const drain = () => {
      raf = 0
      const frames = pending
      pending = []
      setLines((prev) => frames.reduce((acc, f) => applyFrame(acc, f, max), prev))
    }

    const connect = () => {
      clearTimeout(timer)
      timer = undefined
      setRetryAt(null)
      setState(tries === 0 ? 'connecting' : 'reconnecting')
      const sock = new WebSocket(streamUrl({ source, level, q }))
      ws = sock
      sock.onopen = () => {
        tries = 0
        setAttempt(0)
        setState('live')
      }
      sock.onmessage = (ev) => {
        const f = parseFrame(ev.data)
        if (!f) return
        if (f.type === 'gap') setDropped((d) => d + f.dropped)
        pending.push(f)
        if (!raf) raf = requestAnimationFrame(drain)
      }
      sock.onclose = () => {
        if (disposed || ws !== sock) return
        ws = null
        tries++
        setAttempt(tries)
        setState('reconnecting')
        const wait = backoff(tries)
        setRetryAt(Date.now() + wait)
        timer = setTimeout(connect, wait)
      }
    }

    /** Skip the wait: used by "Retry now", `online` and tab focus. */
    const retryNow = () => {
      if (disposed || ws) return
      connect()
    }
    retryRef.current = retryNow
    const onVisible = () => {
      if (document.visibilityState === 'visible') retryNow()
    }
    window.addEventListener('online', retryNow)
    document.addEventListener('visibilitychange', onVisible)

    connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      window.removeEventListener('online', retryNow)
      document.removeEventListener('visibilitychange', onVisible)
      retryRef.current = () => {}
      ws?.close()
    }
  }, [source, level, q, max])

  const retryNow = useCallback(() => retryRef.current(), [])
  return { lines, state, dropped, attempt, retryAt, retryNow }
}
