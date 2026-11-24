import { useRouterState } from '@tanstack/react-router'
import { CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { copy } from '@/lib/copy'

/**
 * The search's own link (05.9), with the part that changes what others see
 * (`muted=include`) marked, and a copy button. Opening it shows the same search.
 */
export function SharePill({ mark }: { mark?: string }) {
  const href = useRouterState({ select: (s) => s.location.href })
  const url = `${window.location.host}${href}`
  const at = mark ? url.indexOf(mark) : -1
  return (
    <div className="flex h-7 min-w-0 max-w-[640px] items-center gap-2 self-start bg-secondary px-2.5 max-md:hidden">
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground leading-3.5">
        {at < 0 ? (
          url
        ) : (
          <>
            {url.slice(0, at)}
            <mark className="bg-brand/22 px-0.75 font-medium text-foreground">{mark}</mark>
            {url.slice(at + (mark?.length ?? 0))}
          </>
        )}
      </span>
      <button
        type="button"
        aria-label="Copy link to this search"
        onClick={() => copy(`${window.location.origin}${href}`, 'search link')}
        className="shrink-0 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground [&_svg]:size-3"
      >
        <CopyIcon />
      </button>
    </div>
  )
}
