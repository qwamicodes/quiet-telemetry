import { Link, Outlet } from '@tanstack/react-router'
import { KeyRoundIcon, MoonIcon, SettingsIcon, SunIcon, UserIcon, UsersIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Account } from '@/components/settings/account'
import { Members } from '@/components/settings/members'
import { IngestTokens } from '@/components/tokens/token-table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useHealth } from '@/lib/api'
import { type Theme, useTheme } from '@/lib/theme'

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b py-4">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground text-xs">{hint}</div>
      </div>
      {children}
    </div>
  )
}

function NavLink({
  to,
  icon,
  children,
}: {
  to: '/settings' | '/settings/account' | '/settings/members' | '/settings/ingest-tokens'
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="flex h-7 items-center gap-2.5 px-2.5 text-muted-foreground outline-none hover:bg-muted focus-visible:bg-muted data-[status=active]:bg-muted data-[status=active]:text-foreground [&_svg]:size-3.5"
    >
      {icon}
      {children}
    </Link>
  )
}

/** Settings: a nav on the left. Storage and per-source settings arrive with their slices. */
export function SettingsLayout() {
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <nav className="flex w-50 shrink-0 flex-col gap-0.5 px-4 py-8" aria-label="Settings">
        <span className="px-2.5 pb-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          Settings
        </span>
        <NavLink to="/settings" icon={<SettingsIcon />}>
          General
        </NavLink>
        <NavLink to="/settings/account" icon={<UserIcon />}>
          Account
        </NavLink>
        <NavLink to="/settings/members" icon={<UsersIcon />}>
          Members
        </NavLink>
        <NavLink to="/settings/ingest-tokens" icon={<KeyRoundIcon />}>
          Ingest tokens
        </NavLink>
      </nav>
      <div className="min-w-0 flex-1 px-8 py-8">
        <Outlet />
      </div>
    </div>
  )
}

/** Appearance + about. */
export function SettingsGeneral() {
  const { theme, setTheme } = useTheme()
  const health = useHealth().data
  return (
    <div className="max-w-2xl">
      <h2 className="font-semibold text-xl">General</h2>
      <Row label="Theme" hint="Dark is the default.">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[theme]}
          onValueChange={(v) => v[0] && setTheme(v[0] as Theme)}
          aria-label="Theme"
        >
          <ToggleGroupItem value="dark" aria-label="Dark">
            <MoonIcon /> Dark
          </ToggleGroupItem>
          <ToggleGroupItem value="light" aria-label="Light">
            <SunIcon /> Light
          </ToggleGroupItem>
        </ToggleGroup>
      </Row>
      <Row label="Version" hint="quiet server running this UI.">
        <span className="font-mono text-muted-foreground">
          {health ? `v${health.version} · ${health.store} store` : '…'}
        </span>
      </Row>
      <p className="pt-4 text-muted-foreground text-xs">
        Storage, retention and per-source settings arrive with their slices.
      </p>
    </div>
  )
}

export function SettingsTokens() {
  return <IngestTokens />
}

export function SettingsAccount() {
  return <Account />
}

export function SettingsMembers() {
  return <Members />
}
