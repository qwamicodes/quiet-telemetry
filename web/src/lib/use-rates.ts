import { useEffect, useRef, useState } from 'react'
import type { SourceInfo } from '@/gen'

/** Lines per second per source, from the change in `lines` between polls. */
export function useRates(sources: SourceInfo[] | undefined): Record<string, number> {
  const prev = useRef<{ at: number; counts: Record<string, number> } | null>(null)
  const [rates, setRates] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!sources) return
    const now = Date.now()
    const counts = Object.fromEntries(sources.map((s) => [s.name, s.lines]))
    const p = prev.current
    if (p && now > p.at) {
      const secs = (now - p.at) / 1000
      setRates(
        Object.fromEntries(sources.map((s) => [s.name, Math.max(0, (s.lines - (p.counts[s.name] ?? s.lines)) / secs)])),
      )
    }
    prev.current = { at: now, counts }
  }, [sources])
  return rates
}
