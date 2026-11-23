import { useNavigate } from '@tanstack/react-router'
import { SparklesIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSources } from '@/lib/api'
import { RELEASE, setWhatsNewOpen, useWhatsNew } from '@/lib/whats-new'

/**
 * The one-time banner after an upgrade (v0.1.1-00.1): logs already sent keep
 * working, how many sources still write the v0.1.0 format, and the way in.
 * Dismissed per account.
 */
export function WhatsNewBanner() {
  const w = useWhatsNew()
  const navigate = useNavigate()
  const old = (useSources().data ?? []).filter((s) => s.format === 'v0.1.0')
  if (!w.showBanner) return null
  return (
    <section
      aria-label="What's new"
      className="flex shrink-0 items-center gap-3 border-brand/40 border-b bg-brand/5 px-5 py-2 text-[13px] [&_svg]:size-3.5"
    >
      <SparklesIcon className="shrink-0 text-brand" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground">quiet v{RELEASE}.</span>{' '}
        <span className="text-muted-foreground">
          Logs you already send keep working.
          {old.length > 0 &&
            ` ${old.length === 1 ? '1 source still uses' : `${old.length} sources still use`} the v0.1.0 format.`}
        </span>
      </span>
      <Button variant="outline" size="xs" onClick={() => setWhatsNewOpen(true)}>
        What changed
      </Button>
      <Button
        variant="outline"
        size="xs"
        onClick={() =>
          old.length > 0
            ? navigate({ to: '/sources/$name/upgrade', params: { name: old[0].name } })
            : navigate({ to: '/guide', search: { tab: 'check' } })
        }
      >
        Check my sources
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={w.dismissBanner}>
        <XIcon />
      </Button>
    </section>
  )
}
