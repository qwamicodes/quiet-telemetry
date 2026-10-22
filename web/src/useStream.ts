import { useEffect, useRef, useState } from 'react'
import type { Frame, LogLine } from './types'

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

export function streamUrl(o: StreamOptions, base = location): string {
  const p = new URLSearchParams({ source: o.source ?? '', backlog: '1000' })
  if (o.level) p.set('level', o.level)
  if (o.q) p.set('q', o.q)
  const proto = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${base.host}/api/stream?${p}`
}

/**
 * One WebSocket per (source, filters). Reconnects with backoff; on reconnect
 * the server resends backlog, which replaces the buffer (no duplicates).
 */
export function useStream(o: StreamOptions) {
  const max = o.max ?? 20_000
  const [lines, setLines] = useState<LogLine[]>([])
  const [state, setState] = useState<ConnState>('connecting')
  const [dropped, setDropped] = useState(0)
  const pending = useRef<Frame[]>([])

  useEffect(() => {
    setLines([])
    setDropped(0)
    if (!o.source) return
    let ws: WebSocket | null = null
    let closed = false
    let attempt = 0
    let timer: number | undefined
    let raf = 0

    // Coalesce frames into one render per animation frame.
    const drain = () => {
      raf = 0
      const frames = pending.current
      pending.current = []
      setLines(prev => frames.reduce((acc, f) => applyFrame(acc, f, max), prev))
    }

    const connect = () => {
      setState(attempt === 0 ? 'connecting' : 'reconnecting')
      ws = new WebSocket(streamUrl(o))
      ws.onopen = () => {
        attempt = 0
        setState('live')
      }
      ws.onmessage = ev => {
        const f = JSON.parse(ev.data) as Frame
        if (f.type === 'gap') setDropped(d => d + f.dropped)
        pending.current.push(f)
        if (!raf) raf = requestAnimationFrame(drain)
      }
      ws.onclose = () => {
        if (closed) return
        setState('reconnecting')
        attempt++
        timer = window.setTimeout(connect, Math.min(500 * 2 ** attempt, 10_000))
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      pending.current = []
      ws?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.source, o.level, o.q, max])

  return { lines, state, dropped }
}
