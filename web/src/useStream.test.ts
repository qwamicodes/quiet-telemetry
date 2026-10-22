import { describe, expect, it } from 'vitest'
import { applyFrame, streamUrl } from './useStream'
import type { LogLine } from './types'

const line = (id: number): LogLine => ({ id, ts: id, received: id, source: 'api', level: 'info', display_id: null, ids: [], msg: `m${id}`, raw: '' })

describe('applyFrame', () => {
  it('backlog replaces, lines append, cap trims oldest', () => {
    let s = applyFrame([line(9)], { type: 'backlog', lines: [line(1), line(2)] }, 3)
    expect(s.map(l => l.id)).toEqual([1, 2])
    s = applyFrame(s, { type: 'lines', lines: [line(3), line(4)] }, 3)
    expect(s.map(l => l.id)).toEqual([2, 3, 4])
    expect(applyFrame(s, { type: 'gap', dropped: 5 }, 3)).toBe(s)
  })
})

describe('streamUrl', () => {
  it('builds ws url with filters', () => {
    const u = streamUrl({ source: 'api', level: 'warn', q: 'slow' }, { protocol: 'https:', host: 'q.example' } as Location)
    expect(u).toBe('wss://q.example/api/stream?source=api&backlog=1000&level=warn&q=slow')
  })
})
