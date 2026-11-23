import { CheckIcon, CircleAlertIcon, InfoIcon, Loader2Icon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { type ToastItem, type ToastType, toast, toastStore } from '@/lib/toast'
import { cn } from '@/lib/utils'

const ICON: Record<ToastType, React.ReactNode> = {
  success: <CheckIcon className="text-status-ok" />,
  error: <CircleAlertIcon className="text-status-err" />,
  warning: <TriangleAlertIcon className="text-status-warn" />,
  info: <InfoIcon className="text-muted-foreground" />,
  loading: <Loader2Icon className="animate-spin text-muted-foreground" />,
}

/** "Undo ⌘Z" → "Undo" + ⌘ Z keycaps. */
function ButtonLabel({ title }: { title: string }) {
  const m = /^(.*?)\s+((?:[⌘⇧⌥]\s?)+[A-Z])$/.exec(title)
  if (!m) return <>{title}</>
  return (
    <>
      {m[1]}
      <span className="flex gap-0.5">
        {[...m[2].replace(/\s/g, '')].map((k) => (
          <Kbd key={k} className="h-4 min-w-4 border bg-transparent px-0.5 font-mono text-[10px]">
            {k}
          </Kbd>
        ))}
      </span>
    </>
  )
}

/** One toast. The countdown and progress bar pause while hovered (03.19). */
function Toast({ t }: { t: ToastItem }) {
  const total = t.duration ?? null
  const [left, setLeft] = useState(total ?? 0)
  const [hover, setHover] = useState(false)
  const last = useRef(Date.now())
  useEffect(() => {
    if (total == null) return
    last.current = Date.now()
    const iv = setInterval(() => {
      const now = Date.now()
      const dt = now - last.current
      last.current = now
      if (hover) return
      setLeft((l) => {
        const n = l - dt
        if (n <= 0) toast.dismiss(t.id)
        return Math.max(0, n)
      })
    }, 100)
    return () => clearInterval(iv)
  }, [total, hover, t.id])
  // The countdown shows only on toasts with an action (Undo has a deadline).
  const countdown = total != null && t.button
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pointer-events-auto relative w-[360px] overflow-hidden border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2.5 p-3">
        <span className="mt-0.5 flex shrink-0 [&_svg]:size-3.5">{t.icon ?? ICON[t.type]}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium text-[13px] text-foreground leading-snug">{t.title}</p>
          {t.description && <div className="text-muted-foreground text-xs leading-snug">{t.description}</div>}
          {t.button && (
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  t.button?.onClick()
                  toast.dismiss(t.id)
                }}
                className="inline-flex h-6 items-center gap-1.5 border bg-secondary px-2 font-medium text-foreground text-xs hover:bg-muted"
              >
                <ButtonLabel title={t.button.title} />
              </button>
            </div>
          )}
        </div>
        {countdown && (
          <span className="mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
            {Math.ceil(left / 1000)}s
          </span>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => toast.dismiss(t.id)}
          className="flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
        >
          <XIcon />
        </button>
      </div>
      {countdown && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 bg-brand transition-[width] duration-100 ease-linear"
          style={{ width: `${(left / (total ?? 1)) * 100}%` }}
        />
      )}
    </div>
  )
}

/**
 * Toasts, bottom right, lifted clear of the stream's footer bar (08.3).
 */
export function Toaster({ position = 'bottom-right' }: { position?: 'bottom-right' | 'top-right' }) {
  const items = useSyncExternalStore(toastStore.subscribe, toastStore.get, toastStore.get)
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed right-5 z-[100] flex flex-col gap-2',
        position === 'top-right' ? 'top-5' : 'bottom-16 max-md:bottom-20',
      )}
    >
      {items.map((t) => (
        <Toast key={t.id} t={t} />
      ))}
    </section>
  )
}
