import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ChevronRightIcon } from 'lucide-react'
import type * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Base UI Menu, Lyra-styled. Deliberately no GroupLabel export: Base UI throws
 * ("MenuGroupContext is missing") when that part sits outside a Group, which
 * took down a whole app once (legivent #162). Use `DropdownMenuHeader` (a
 * plain label) for a heading.
 */
const DropdownMenu = MenuPrimitive.Root

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="isolate z-50">
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'z-50 min-w-48 origin-(--transform-origin) bg-popover p-1 text-popover-foreground text-xs shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  variant,
  ...props
}: MenuPrimitive.Item.Props & { variant?: 'default' | 'destructive' }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex h-7 cursor-default items-center gap-2 px-2 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-muted [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
        variant === 'destructive' && 'text-level-error data-highlighted:bg-level-error-muted',
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

/** A submenu (Base UI `SubmenuRoot`): wrap a `DropdownMenuSubTrigger` and a `DropdownMenuSubContent`. */
const DropdownMenuSub = MenuPrimitive.SubmenuRoot

function DropdownMenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        "flex h-7 cursor-default items-center gap-2 px-2 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-muted data-popup-open:bg-muted [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  align = 'start',
  side = 'left',
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>) {
  return <DropdownMenuContent className={className} align={align} side={side} sideOffset={sideOffset} {...props} />
}

/** A plain heading inside the popup (not Base UI's GroupLabel; see above). */
function DropdownMenuHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col px-2 py-1.5', className)} {...props} />
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHeader,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
}
