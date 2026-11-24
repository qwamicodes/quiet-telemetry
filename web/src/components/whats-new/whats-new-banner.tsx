import { useNavigate } from '@tanstack/react-router'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSources } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PREVIOUS, RELEASE, setWhatsNewOpen, useWhatsNew } from '@/lib/whats-new'

/**
 * The one-time banner after an upgrade (v0.1.1-00.1): logs already sent keep
 * working, how many sources still write the v0.1.0 format, and the way in.
 * It sits on the Guide overview, where the sidebar's `updated` marker leads;
 * × hides it for good (per account).
 */
export function WhatsNewBanner({ className }: { className?: string }) {
  const w = useWhatsNew()
  const navigate = useNavigate()
  const old = (useSources().data ?? []).filter((s) => s.format === 'v0.1.0')
  if (!w.showBanner) return null
  return (
    <section
      aria-label="What's new"
      className={cn(
        'flex shrink-0 items-center gap-4 border-brand border-l-2 bg-level-info-muted px-4 py-3.5',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium text-foreground text-sm leading-5">
          quiet is now v{RELEASE} · the logging guide changed
        </span>
        <span className="text-[13px] text-muted-foreground leading-4.5">
          Logs you already send keep working. The prompt now adds request and response context, redaction and SLO goals.
          {old.length > 0 &&
            ` ${old.length === 1 ? '1 source still uses' : `${old.length} sources still use`} the v${PREVIOUS} format.`}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          old.length > 0
            ? navigate({ to: '/sources/$name/upgrade', params: { name: old[0].name } })
            : navigate({ to: '/guide', search: { tab: 'check' } })
        }
      >
        Check my sources
      </Button>
      <Button size="sm" onClick={() => setWhatsNewOpen(true)}>
        What changed
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={w.dismissBanner}>
        <XIcon />
      </Button>
    </section>
  )
}
