import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useStream } from './useStream'
import type { Health, LogLine, SourceInfo } from './types'

const ROW = 26

function usePoll<T>(url: string, ms: number): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    let live = true
    const tick = () =>
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .then(d => live && d && setData(d))
        .catch(() => {})
    tick()
    const t = setInterval(tick, ms)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [url, ms])
  return data
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export default function App() {
  const health = usePoll<Health>('/api/health', 5000)
  const sources = usePoll<{ sources: SourceInfo[] }>('/api/sources', 3000)?.sources ?? []
  const [source, setSource] = useState<string | null>(() => new URLSearchParams(location.search).get('source'))
  const [level, setLevel] = useState('')
  const [text, setText] = useState('')
  const q = useDebounced(text, 250)
  const [selected, setSelected] = useState<LogLine | null>(null)

  useEffect(() => {
    if (!source && sources.length) setSource(sources[0].name)
  }, [source, sources])
  useEffect(() => {
    if (!source) return
    const u = new URL(location.href)
    u.searchParams.set('source', source)
    history.replaceState(null, '', u)
    setSelected(null)
  }, [source])

  const { lines, state, dropped } = useStream({ source, level, q })

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">quiet</div>
        <div className="section-label">Sources</div>
        <nav>
          {sources.length === 0 && <div className="empty-hint">Waiting for logs…</div>}
          {sources.map(s => (
            <button key={s.name} className={`source ${s.name === source ? 'active' : ''}`} onClick={() => setSource(s.name)}>
              <span className={`dot ${s.last_ts && Date.now() - s.last_ts < 60_000 ? 'ok' : 'idle'}`} />
              <span className="source-name">{s.name}</span>
              <span className="source-kind">{s.kind}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <DockerBadge health={health} />
          <span className="muted">v{health?.version ?? '…'}</span>
        </div>
      </aside>

      <main className="main">
        <header className="toolbar">
          <h1>{source ?? 'No source'}</h1>
          <span className={`conn ${state}`}>{state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Reconnecting…'}</span>
          <div className="spacer" />
          <input className="input search" placeholder="Filter text" value={text} onChange={e => setText(e.target.value)} />
          <select className="input" value={level} onChange={e => setLevel(e.target.value)}>
            <option value="">All levels</option>
            <option value="debug">Debug+</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error+</option>
          </select>
        </header>
        {state === 'reconnecting' && <div className="banner">Lost connection to the server. Reconnecting…</div>}
        {dropped > 0 && <div className="banner warn">{dropped.toLocaleString()} lines skipped while the view caught up.</div>}
        <div className="body">
          <LogList lines={lines} selectedId={selected?.id ?? null} onSelect={setSelected} />
          {selected && <FieldCard line={selected} onClose={() => setSelected(null)} />}
        </div>
      </main>
    </div>
  )
}

function DockerBadge({ health }: { health: Health | null }) {
  if (!health) return <span className="muted">…</span>
  const d = health.docker
  const label =
    d.state === 'connected' ? `Docker · ${d.containers}` : d.state === 'unavailable' ? 'Docker unavailable' : d.state === 'disabled' ? 'Docker off' : 'Docker…'
  return (
    <span className="docker" title={d.state === 'unavailable' ? d.error : undefined}>
      <span className={`dot ${d.state === 'connected' ? 'ok' : d.state === 'unavailable' ? 'err' : 'idle'}`} />
      {label}
    </span>
  )
}

/** Newest at the bottom; sticks to the bottom until you scroll up. */
function LogList({ lines, selectedId, onSelect }: { lines: LogLine[]; selectedId: number | null; onSelect: (l: LogLine) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const lastSeen = useRef(0)
  const v = useVirtualizer({ count: lines.length, getScrollElement: () => ref.current, estimateSize: () => ROW, overscan: 20 })

  useLayoutEffect(() => {
    if (follow && lines.length) v.scrollToIndex(lines.length - 1, { align: 'end' })
    if (follow) lastSeen.current = lines.length ? lines[lines.length - 1].id : 0
  }, [lines, follow, v])

  const unseen = useMemo(() => (follow ? 0 : lines.filter(l => l.id > lastSeen.current).length), [lines, follow])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2
    if (atBottom !== follow) setFollow(atBottom)
  }

  return (
    <div className="list-wrap">
      <div className="list-head">
        <span className="c-time">Time</span>
        <span className="c-level">Level</span>
        <span className="c-id">ID</span>
        <span className="c-msg">Message</span>
      </div>
      <div className="list" ref={ref} onScroll={onScroll}>
        {lines.length === 0 && <div className="empty">No lines yet. New lines appear here as they arrive.</div>}
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map(item => {
            const l = lines[item.index]
            return (
              <div
                key={l.id}
                className={`row lvl-${l.level ?? 'none'} ${l.id === selectedId ? 'selected' : ''}`}
                style={{ transform: `translateY(${item.start}px)`, height: ROW }}
                onClick={() => onSelect(l)}
              >
                <span className="c-time">{fmtTime(l.ts)}</span>
                <span className="c-level">{l.level && <span className={`badge ${l.level}`}>{l.level}</span>}</span>
                <span className="c-id" title={l.display_id ? `${l.display_id.key}: ${l.display_id.value}` : undefined}>
                  {l.display_id?.value ?? ''}
                </span>
                <span className="c-msg">{l.msg}</span>
              </div>
            )
          })}
        </div>
      </div>
      {!follow && (
        <button className="jump" onClick={() => setFollow(true)}>
          {unseen > 0 ? `${unseen.toLocaleString()} new · Jump to latest` : 'Jump to latest'}
        </button>
      )}
    </div>
  )
}

/** Slice 1 card: fields + raw. Flow view replaces this in slice 3. */
function FieldCard({ line, onClose }: { line: LogLine; onClose: () => void }) {
  const [tab, setTab] = useState<'fields' | 'raw'>(line.fields ? 'fields' : 'raw')
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <div className="card-title">{line.msg}</div>
          <div className="muted mono">
            {new Date(line.ts).toISOString()} · {line.source}
          </div>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {line.ids.length > 0 && (
        <div className="ids">
          {line.ids.map(i => (
            <span key={i.key + i.value} className="chip mono">
              <span className="muted">{i.key}</span> {i.value}
            </span>
          ))}
        </div>
      )}
      {line.flags && line.flags.length > 0 && <div className="flags mono">{line.flags.join(' · ')}</div>}
      <div className="tabs">
        <button className={tab === 'fields' ? 'on' : ''} disabled={!line.fields} onClick={() => setTab('fields')}>
          Fields
        </button>
        <button className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>
          Raw
        </button>
      </div>
      <pre className="code">{tab === 'fields' && line.fields ? JSON.stringify(line.fields, null, 2) : line.raw}</pre>
    </section>
  )
}
