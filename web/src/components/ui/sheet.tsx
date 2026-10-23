import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { XIcon } from 'lucide-react'
import type * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** A right-hand sheet (Edit source 06.3 / 06.13, Global rule 07.15): a dialog pinned to the right edge. */
function Sheet(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />
}

function SheetContent({
  className,
  children,
  width = 520,
  ...props
}: DialogPrimitive.Popup.Props & { width?: number }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/40 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        style={{ width: `min(${width}px, 100vw)` }}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex flex-col border-l bg-background text-sm outline-none duration-150 data-open:animate-in data-open:slide-in-from-right-8 data-closed:animate-out data-closed:fade-out-0',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function SheetHeader({
  title,
  aside,
  children,
}: {
  title: React.ReactNode
  aside?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="shrink-0 border-b px-5 pt-4">
      <div className="flex items-center gap-3 pb-3">
        <DialogPrimitive.Title className="font-semibold text-lg">{title}</DialogPrimitive.Title>
        {aside && <span className="font-mono text-muted-foreground text-xs">{aside}</span>}
        <DialogPrimitive.Close
          render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" />}
        >
          <XIcon />
        </DialogPrimitive.Close>
      </div>
      {children}
    </div>
  )
}

function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex shrink-0 items-center gap-2 border-t px-5 py-3', className)} {...props} />
}

const SheetClose = DialogPrimitive.Close

export { Sheet, SheetBody, SheetClose, SheetContent, SheetFooter, SheetHeader }
