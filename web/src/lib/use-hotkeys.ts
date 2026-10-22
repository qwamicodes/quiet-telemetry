import { useEffect, useRef } from 'react'

export type Hotkeys = Record<string, (e: KeyboardEvent) => void>

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/**
 * Single-key shortcuts (`/`, `j`, `space`, `mod+k`). Ignored while typing,
 * except `mod+…` combos and `escape`.
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
      if (e.altKey) return
      const fn = ref.current[combo]
      if (fn) {
        e.preventDefault()
        fn(e)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
