import { Link } from '@tanstack/react-router'
import { AlertTriangleIcon, ChevronDownIcon, DatabaseIcon, HardDriveIcon, ShieldAlertIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import type { Issue, IssueKind } from '@/gen'
import { useSystem } from '@/lib/settings-api'
import { cn } from '@/lib/utils'

/** Dismissed banners stay dismissed for this tab, until that issue clears and comes back. */
const DISMISS_KEY = 'quiet.dismissed-issues'
const readDismissed = (): IssueKind[] => {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? '[]')
  } catch {
    return []
  }
}

const ICON: Record<IssueKind, typeof AlertTriangleIcon> = {
  docker_unavailable: ShieldAlertIcon,
  disk_near_cap: HardDriveIcon,
  disk_at_cap: HardDriveIcon,
  disk_low: HardDriveIcon,
  store_errors: DatabaseIcon,
  ingest_rejected: AlertTriangleIcon,
}

/** Where each banner sends you. */
function Action({ kind }: { kind: IssueKind }) {
  const cls = 'flex h-6 items-center border px-2 text-xs hover:bg-muted'
  if (kind === 'disk_near_cap' || kind === 'disk_at_cap' || kind === 'disk_low')
    return (
      <Link to="/settings/storage" className={cls}>
        Storage settings
      </Link>
    )
  if (kind === 'ingest_rejected')
    return (
      <Link to="/sources" className={cls}>
        Sources
      </Link>
    )
  return null
}

/** Steps for the most common reasons quiet can't read the Docker socket. */
function DockerHelp() {
  return (
    <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-muted-foreground text-xs">
      <li>
        Mount the socket read-only into quiet:{' '}
        <code className="font-mono text-foreground">- /var/run/docker.sock:/var/run/docker.sock:ro</code>
      </li>
      <li>
        “permission denied”: run quiet with the socket's group, e.g.{' '}
        <code className="font-mono text-foreground">group_add: ["$(stat -c %g /var/run/docker.sock)"]</code>
      </li>
      <li>
        Rootless Docker or Podman: mount <code className="font-mono text-foreground">$XDG_RUNTIME_DIR/docker.sock</code>{' '}
        or set <code className="font-mono text-foreground">DOCKER_HOST</code>.
      </li>
      <li>
        Not using Docker here? Set <code className="font-mono text-foreground">QUIET_DOCKER=off</code> and ship logs
        over HTTP instead.
      </li>
    </ol>
  )
}

function Banner({ issue, onDismiss }: { issue: Issue; onDismiss: () => void }) {
  const [open, setOpen] = useState(false)
  const Icon = ICON[issue.kind]
  const error = issue.severity === 'error'
  return (
    <div
      role={error ? 'alert' : 'status'}
      data-issue={issue.kind}
      className={cn(
        'border-b px-6 py-2 text-sm',
        error ? 'border-status-err/40 bg-status-err/10' : 'border-status-warn/40 bg-status-warn/10',
      )}
    >
      <div className="flex items-center gap-3">
        <Icon className={cn('size-4 shrink-0', error ? 'text-status-err' : 'text-status-warn')} />
        <span className="font-medium">{issue.title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={issue.detail}>
          {issue.detail}
        </span>
        {issue.kind === 'docker_unavailable' && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex h-6 items-center gap-1 border px-2 text-xs hover:bg-muted"
          >
            Troubleshoot <ChevronDownIcon className={cn('size-3 transition-transform', open && 'rotate-180')} />
          </button>
        )}
        <Action kind={issue.kind} />
        <button
          type="button"
          aria-label={`Dismiss: ${issue.title}`}
          onClick={onDismiss}
          className="flex size-6 items-center justify-center hover:bg-muted"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      {open && <DockerHelp />}
    </div>
  )
}

/**
 * App-wide banners from `/api/system`: Docker unreachable, disk near/at the
 * cap or the disk itself filling up, lines failing to save, ingest requests
 * refused. One per issue, dismissible for this tab.
 */
export function SystemBanners() {
  const issues = useSystem().data?.issues ?? []
  const [dismissed, setDismissed] = useState<IssueKind[]>(readDismissed)
  // An issue that cleared can be dismissed again when it comes back.
  const active = issues.map((i) => i.kind)
  const keep = dismissed.filter((k) => active.includes(k))
  const shown = issues.filter((i) => !keep.includes(i.kind))
  if (!shown.length) return null
  const dismiss = (k: IssueKind) => {
    const next = [...keep, k]
    setDismissed(next)
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next))
    } catch {}
  }
  return (
    <section aria-label="System status">
      {shown.map((i) => (
        <Banner key={i.kind} issue={i} onDismiss={() => dismiss(i.kind)} />
      ))}
    </section>
  )
}
