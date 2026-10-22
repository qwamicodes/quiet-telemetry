import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeftIcon, GitForkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

const route = getRouteApi('/flow/$id')

/** Placeholder until flows land (slice 3): lines stitched by every id they carry. */
export function FlowPage() {
  const { id } = route.useParams()
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 items-center gap-3 border-b px-6">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/" />}>
          <ArrowLeftIcon />
          Stream
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="font-mono text-[13px]">{id}</span>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 border border-dashed p-8 text-center">
          <GitForkIcon className="size-5 text-brand" />
          <h1 className="font-medium text-base">Flows arrive in slice 3</h1>
          <p className="text-muted-foreground">
            This page will stitch every line that carries <code className="font-mono text-foreground">{id}</code>{' '}
            (request, job, trace or correlation id) into one flow, with the field card on the right.
          </p>
        </div>
      </div>
    </div>
  )
}
