import { useRouter } from '@tanstack/react-router'
import { ServerCrashIcon } from 'lucide-react'
import { AuthCard, AuthFrame } from '@/components/auth/auth-frame'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api'

/**
 * Root error page: usually the server didn't answer `/api/auth/state`
 * (restarting, down); anything else that escapes a page lands here too.
 */
export function ServerUnreachable({ error }: { error: unknown }) {
  const router = useRouter()
  const network = error instanceof TypeError || error instanceof ApiError
  return (
    <AuthFrame>
      <AuthCard>
        <span className="mb-5 flex size-9 items-center justify-center border text-level-error [&_svg]:size-4">
          <ServerCrashIcon />
        </span>
        <h1 className="mb-1 font-semibold text-xl tracking-tight">
          {network ? "Can't reach quiet" : 'Something broke'}
        </h1>
        <p className="mb-4 text-muted-foreground text-sm">
          {network
            ? "The server didn't answer. It may be restarting; check its logs if this persists."
            : 'This page hit an error. Reloading usually helps; the details below help a bug report.'}
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
