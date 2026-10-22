import { useRouter, useRouterState } from '@tanstack/react-router'
import { ArrowLeftIcon, CopyIcon, RotateCwIcon, ServerCrashIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AuthCard, AuthFrame } from '@/components/auth/auth-frame'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'

function browserName(): string {
  const ua = navigator.userAgent
  const m = /(Firefox|Edg|Chrome|Safari)\/(\d+)/.exec(ua)
  const os = /Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  const name = m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'browser'
  return os ? `${name} · ${os}` : name
}

/** How long `/api/health` takes now, or `unreachable`. */
function useServerCheck() {
  const [state, setState] = useState('checking…')
  useEffect(() => {
    const t0 = performance.now()
    fetch('/api/health')
      .then((r) => setState(r.ok ? `reachable · ${Math.round(performance.now() - t0)}ms` : `answered ${r.status}`))
      .catch(() => setState('unreachable'))
  }, [])
  return state
}

/**
 * Root error page. The server not answering `/api/auth/state` (restarting,
 * down) gets a short "can't reach quiet"; anything else that escaped a page
 * is a crash (design 08.8): error id, details to copy, reload.
 */
export function ServerUnreachable({ error }: { error: unknown }) {
  const network = error instanceof TypeError || error instanceof ApiError
  return network ? <Unreachable error={error} /> : <CrashPage error={error} />
}

function Unreachable({ error }: { error: unknown }) {
  const router = useRouter()
  return (
    <AuthFrame>
      <AuthCard>
        <span className="mb-5 flex size-9 items-center justify-center border text-level-error [&_svg]:size-4">
          <ServerCrashIcon />
        </span>
        <h1 className="mb-1 font-semibold text-xl tracking-tight">Can't reach quiet</h1>
        <p className="mb-4 text-muted-foreground text-sm">
          The server didn't answer. It may be restarting; check its logs if this persists.
        </p>
        <pre className="mb-4 overflow-x-auto border bg-background p-2.5 font-mono text-[11px] text-muted-foreground">
          {error instanceof Error ? error.message : String(error)}
        </pre>
        <Button className="w-full" onClick={() => router.invalidate()}>
          Try again
        </Button>
      </AuthCard>
    </AuthFrame>
  )
}

export function CrashPage({ error }: { error: unknown }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const server = useServerCheck()
  const id = useMemo(() => `err_${Math.random().toString(16).slice(2, 8)}`, [])
  const at = useMemo(() => new Date(), [])
  const err = error instanceof Error ? error : new Error(String(error))
  const stack = (err.stack ?? `${err.name}: ${err.message}`)
    .split('\n')
    .slice(0, 6)
    .map((l, i) => (i === 0 ? l : `    ${l.trim()}`))
    .join('\n')
  const where = path.startsWith('/flow') || path.startsWith('/line') ? 'opening this flow' : 'opening this page'
  const details = `${stack.startsWith(err.name) ? stack : `${err.name}: ${err.message}\n${stack}`}\n\nroute    ${path}\nbrowser  ${browserName()}\nserver   ${server}\nerror id ${id} · ${at.toISOString()}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details)
      toast.success('Copied error details')
    } catch {
      toast.error('Clipboard is not available here')
    }
  }

  return (
    <AuthFrame footer={`error id ${id}`}>
      <section className="w-full max-w-[640px]">
        <span className="mb-6 flex size-9 items-center justify-center border border-status-err/40 bg-status-err/10 text-status-err [&_svg]:size-4">
          <TriangleAlertIcon />
        </span>
        <h1 className="mb-2 font-semibold text-3xl tracking-tight">This page broke.</h1>
        <p className="mb-6 text-muted-foreground">
          Something in the portal failed while {where}. Your logs are fine: ingest and storage run on the server and
          kept going. Reloading usually fixes it.
        </p>
        <div className="mb-6 border bg-card">
          <div className="flex items-center justify-between border-b px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <span>error details · {id}</span>
            <Button variant="ghost" size="xs" onClick={copy}>
              <CopyIcon />
              Copy
            </Button>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed">
            {`${err.name}: ${err.message}\n${stack.split('\n').slice(1).join('\n')}\n\nroute    ${path}\nbrowser  ${browserName()}\nserver   ${server}`}
          </pre>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => window.location.reload()}>
            <RotateCwIcon />
            Reload page
            <Kbd className="ml-1">⌘</Kbd>
            <Kbd>R</Kbd>
          </Button>
          <Button variant="outline" onClick={() => window.location.assign('/')}>
            <ArrowLeftIcon />
            Back to stream
          </Button>
          <Button variant="ghost" onClick={copy}>
            <CopyIcon />
            Copy details
          </Button>
        </div>
      </section>
    </AuthFrame>
  )
}
