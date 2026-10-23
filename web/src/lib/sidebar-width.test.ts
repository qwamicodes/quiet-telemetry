import { describe, expect, it } from 'vitest'
import {
  clampWidth,
  dragLabel,
  dragTo,
  effectiveWidth,
  HIDDEN_KEY,
  keyAction,
  loadSidebar,
  maxForViewport,
  SIDEBAR_DEFAULT,
  saveSidebar,
  WIDTH_KEY,
} from '@/lib/sidebar-width'

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

describe('clampWidth', () => {
  it('clamps to 200–420 and rounds', () => {
    expect(clampWidth(100)).toBe(200)
    expect(clampWidth(264.4)).toBe(264)
    expect(clampWidth(999)).toBe(420)
    expect(clampWidth('300')).toBe(300)
  })
  it('bad values read as the default 248', () => {
    for (const v of [Number.NaN, 'wide', '', null, undefined, {}, Number.POSITIVE_INFINITY]) {
      expect(clampWidth(v)).toBe(SIDEBAR_DEFAULT)
    }
  })
})

describe('viewport: the main column keeps 720', () => {
  it('shrinks the sidebar first, never below 200', () => {
    expect(maxForViewport(1440)).toBe(420)
    expect(maxForViewport(1000)).toBe(280)
    expect(maxForViewport(800)).toBe(200)
    expect(effectiveWidth(420, 1000)).toBe(280)
    expect(effectiveWidth(248, 1440)).toBe(248)
  })
})

describe('dragTo (snap)', () => {
  it('below 140 hides, 140–200 holds at 200, 200–420 live, past 420 holds', () => {
    expect(dragTo(116)).toEqual({ width: 200, hide: true })
    expect(dragTo(139.9)).toEqual({ width: 200, hide: true })
    expect(dragTo(140)).toEqual({ width: 200, hide: false })
    expect(dragTo(180)).toEqual({ width: 200, hide: false })
    expect(dragTo(264)).toEqual({ width: 264, hide: false })
    expect(dragTo(600)).toEqual({ width: 420, hide: false })
    expect(dragTo(600, 1000)).toEqual({ width: 280, hide: false })
  })
  it('labels the width tooltip like the boards', () => {
    expect(dragLabel({ width: 264, hide: false })).toEqual(['264 px', 'default 248'])
    expect(dragLabel({ width: 420, hide: false })).toEqual(['420 px', 'max'])
    expect(dragLabel({ width: 200, hide: false })).toEqual(['200 px', 'min'])
    expect(dragLabel({ width: 248, hide: false })).toEqual(['248 px', 'default'])
    expect(dragLabel({ width: 200, hide: true })).toEqual(['hide', '< 140 px'])
  })
})

describe('keyAction', () => {
  it('arrows step 16, Shift 64, clamped', () => {
    expect(keyAction('ArrowRight', false, 248)).toEqual({ width: 264 })
    expect(keyAction('ArrowLeft', false, 248)).toEqual({ width: 232 })
    expect(keyAction('ArrowRight', true, 248)).toEqual({ width: 312 })
    expect(keyAction('ArrowLeft', true, 248)).toEqual({ width: 200 })
    expect(keyAction('ArrowRight', true, 400)).toEqual({ width: 420 })
  })
  it('Home / End go to min / max, Enter toggles, others ignored', () => {
    expect(keyAction('Home', false, 300)).toEqual({ width: 200 })
    expect(keyAction('End', false, 300)).toEqual({ width: 420 })
    expect(keyAction('Enter', false, 300)).toEqual({ toggle: true })
    expect(keyAction('a', false, 300)).toBeNull()
  })
})

describe('saved per browser', () => {
  it('loads clamped values; missing or bad → 248 shown', () => {
    expect(loadSidebar(mem())).toEqual({ width: 248, hidden: false })
    expect(loadSidebar(mem({ [WIDTH_KEY]: '264', [HIDDEN_KEY]: 'false' }))).toEqual({ width: 264, hidden: false })
    expect(loadSidebar(mem({ [WIDTH_KEY]: '9000', [HIDDEN_KEY]: 'true' }))).toEqual({ width: 420, hidden: true })
    expect(loadSidebar(mem({ [WIDTH_KEY]: 'abc', [HIDDEN_KEY]: 'yes' }))).toEqual({ width: 248, hidden: false })
    expect(loadSidebar(undefined)).toEqual({ width: 248, hidden: false })
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadSidebar(throwing)).toEqual({ width: 248, hidden: false })
  })
  it('saves both keys', () => {
    const s = mem()
    saveSidebar(s, { width: 312, hidden: true })
    expect(s.m.get(WIDTH_KEY)).toBe('312')
    expect(s.m.get(HIDDEN_KEY)).toBe('true')
  })
})
