import { useEffect, useRef } from 'react'

export type Hotkeys = Record<string, (e: KeyboardEvent) => void>

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/** Bold / italic / underline in a rich-text field: never taken from it. */
const TEXT_FORMAT = new Set(['mod+b', 'mod+i', 'mod+u'])

/**
 * Single-key shortcuts (`/`, `j`, `space`, `mod+k`, `mod+shift+c`). Ignored while typing,
 * except `mod+…` combos and `escape`
 * (but ⌘B / ⌘I / ⌘U stay with a rich-text field).
 */
export function useHotkeys(keys: Hotkeys) {
  const ref = useRef(keys)
  ref.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key === ' ' ? 'space' : e.key.toLowerCase()
      const combo = mod ? `mod+${key}` : key
      if (!mod && key !== 'escape' && isTyping(e.target)) return
      if (TEXT_FORMAT.has(combo) && e.target instanceof HTMLElement && e.target.isContentEditable) return
      if (e.altKey) return
      // `mod+shift+c` when one is registered; otherwise shift is ignored.
      const fn = (mod && e.shiftKey ? ref.current[`mod+shift+${key}`] : undefined) ?? ref.current[combo]
      if (fn) {
        e.preventDefault()
        fn(e)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Two-key sequences (`g h`, `g l`): the second key within a second of the
 * first. Ignored while typing or with a modifier held. The first key still
 * reaches single-key shortcuts (on the stream `G` also jumps to newest).
 */
export function useKeySequences(seqs: Record<string, () => void>) {
  const ref = useRef(seqs)
  ref.current = seqs
  useEffect(() => {
    let prev = ''
    let at = 0
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      const key = e.key.toLowerCase()
      const now = Date.now()
      const fn = prev && now - at < 1000 ? ref.current[`${prev} ${key}`] : undefined
      if (fn) {
        e.preventDefault()
        prev = ''
        fn()
        return
      }
      prev = key
      at = now
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
