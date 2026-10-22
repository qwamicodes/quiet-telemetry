import { Link } from '@tanstack/react-router'
import { UnlinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** A flow link whose id or line number can't be valid (hand-edited, truncated). */
export function BrokenLink() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 border border-dashed p-8 text-center">
        <UnlinkIcon className="size-5 text-muted-foreground" />
        <h1 className="font-medium text-base">This flow link is broken</h1>
        <p className="text-muted-foreground">
          The id or line number in the address isn't one quiet could have made. Open the flow again from the stream or a
          search.
        </p>
        <Button nativeButton={false} render={<Link to="/" />}>
          Back to the stream
        </Button>
      </div>
    </div>
  )
}
