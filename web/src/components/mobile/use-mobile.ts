import { useEffect, useState } from 'react'

/** Below `md` (768 px) quiet uses the phone layout (boards 10.1 and 10.2). */
const QUERY = '(max-width: 767px)'

const query = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null

/**
 * True on a phone-sized screen. The phone screens are separate components, not
 * CSS-hidden copies, so the desktop DOM stays as it is.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const m = query()
    if (!m) return
    const on = () => setMobile(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return mobile
}
