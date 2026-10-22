import { useNavigate } from '@tanstack/react-router'
import { LogOutIcon, UserIcon, UsersIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHeader,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth, useLogout } from '@/lib/auth-api'
import { toast } from '@/lib/toast'

/** Sidebar footer: who is signed in, account / members / sign out. */
export function UserMenu() {
  const auth = useAuth().data
  const logout = useLogout()
  const navigate = useNavigate()
  const user = auth?.user
  if (!user) return null
  const off = auth.auth === 'off'
  const first = user.name.split(' ')[0] || user.email
  const signOut = () =>
    logout.mutate(undefined, {
      onSuccess: () => navigate({ to: '/signin' }),
      onError: (e) => toast.error('Could not sign out', { description: (e as Error).message }),
    })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${user.name}`}
        className="flex h-11 w-full items-center gap-2.5 border-sidebar-border border-t pr-12 pl-4 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent data-popup-open:bg-sidebar-accent"
      >
        <span
          aria-hidden
          className="flex size-6 items-center justify-center border border-sidebar-border font-mono text-[11px]"
        >
          {first[0]?.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{first.toLowerCase()}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{off ? 'auth off' : user.role}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuHeader>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{auth.instance_name}</span>
          <span className="truncate text-foreground">{user.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{user.email}</span>
        </DropdownMenuHeader>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ to: '/settings/account' })}>
          <UserIcon /> Account
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate({ to: '/settings/members' })}>
          <UsersIcon /> Members
        </DropdownMenuItem>
        {!off && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={signOut}>
              <LogOutIcon /> Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
