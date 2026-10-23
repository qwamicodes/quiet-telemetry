import { describe, expect, it } from 'vitest'
import {
  EXPAND_MAX,
  expandJsonStrings,
  insideParsed,
  PARSE_DEPTH,
  PARSE_MAX,
  parsedRoot,
  parseJsonString,
  segId,
  textQuery,
} from '@/lib/json-string'

describe('parseJsonString', () => {
  it('parses objects and arrays held in a string', () => {
    expect(parseJsonString('{"a":1,"b":{"c":"d"}}')).toEqual({ a: 1, b: { c: 'd' } })
    expect(parseJsonString('  [1, "x"]\n')).toEqual([1, 'x'])
  })

  it('parses a double-encoded JSON string', () => {
    expect(parseJsonString(JSON.stringify(JSON.stringify({ user: { id: 7 } })))).toEqual({ user: { id: 7 } })
  })

  it('leaves plain text, invalid JSON and primitives alone', () => {
    for (const s of [
      'hello',
      '{not json}',
      '[1,',
      '42',
      'true',
      'null',
      '"just a string"',
      '{',
      '',
      '{"a":1} trailing',
    ])
      expect(parseJsonString(s)).toBeUndefined()
  })

  it('caps size and depth', () => {
    const big = `{"a":"${'x'.repeat(PARSE_MAX)}"}`
    expect(parseJsonString(big)).toBeUndefined()
    const deep = `${'['.repeat(PARSE_DEPTH + 2)}${']'.repeat(PARSE_DEPTH + 2)}`
    expect(parseJsonString(deep)).toBeUndefined()
    const ok = `${'['.repeat(5)}${']'.repeat(5)}`
    expect(parseJsonString(ok)).toBeDefined()
  })

  it('memoizes: the same string returns the same object', () => {
    const s = '{"memo":true}'
    expect(parseJsonString(s)).toBe(parseJsonString(s))
  })
})

describe('expandJsonStrings', () => {
  it('replaces JSON strings and records where they were, nested ones too', () => {
    const inner = JSON.stringify({ code: 'E1' })
    const payload = JSON.stringify({ user: { id: 'u1' }, err: inner })
    const fields = { msg: 'done', payload, list: ['[1,2]', 'plain'], n: 3 }
    const { fields: out, parsed } = expandJsonStrings(fields)
    expect(out).toEqual({
      msg: 'done',
      payload: { user: { id: 'u1' }, err: { code: 'E1' } },
      list: [[1, 2], 'plain'],
      n: 3,
    })
    expect([...parsed.keys()].sort()).toEqual(['.list[0]', '.payload', '.payload.err'])
    expect(parsed.get('.payload')).toBe(payload)
    // The input is never mutated.
    expect(fields.payload).toBe(payload)
  })

  it('returns the same object when nothing parses, and memoizes per object', () => {
    const fields = { a: 'x', b: { c: 1 } }
    const r = expandJsonStrings(fields)
    expect(r.fields).toBe(fields)
    expect(r.parsed.size).toBe(0)
    expect(expandJsonStrings(fields)).toBe(r)
  })

  it('stops after EXPAND_MAX strings', () => {
    const fields = Object.fromEntries(Array.from({ length: EXPAND_MAX + 10 }, (_, i) => [`k${i}`, `{"i":${i}}`]))
    expect(expandJsonStrings(fields).parsed.size).toBe(EXPAND_MAX)
  })
})

describe('helpers', () => {
  const parsed = new Map([[segId(['payload']), '{}']])
  it('parsedRoot finds the string a dotted key came out of', () => {
    expect(parsedRoot('payload.user.id', parsed)).toBe('payload')
    expect(parsedRoot('payload', parsed)).toBe('payload')
    expect(parsedRoot('status', parsed)).toBeUndefined()
    expect(parsedRoot('payload2', parsed)).toBeUndefined()
  })
  it('insideParsed checks a path and its parents', () => {
    expect(insideParsed(['payload', 'items', 0], parsed)).toBe(true)
    expect(insideParsed(['other'], parsed)).toBe(false)
    expect(insideParsed(['payload'], undefined)).toBe(false)
  })
  it('textQuery quotes values for a text search', () => {
    expect(textQuery('u1')).toBe('"u1"')
    expect(textQuery('a b', true)).toBe('-"a b"')
    expect(textQuery('u1', true)).toBe('-u1')
    expect(textQuery(42)).toBe('"42"')
  })
})
