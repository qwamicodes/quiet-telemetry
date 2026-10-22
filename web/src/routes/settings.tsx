import { Link, Outlet } from '@tanstack/react-router'
import {
  DatabaseIcon,
  KeyRoundIcon,
  MoonIcon,
  NetworkIcon,
  PaletteIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Account } from '@/components/settings/account'
import { General } from '@/components/settings/general'
import { FlowIdOrder } from '@/components/settings/id-order'
import { Members } from '@/components/settings/members'
import { Storage } from '@/components/settings/storage'
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
  to:
    | '/settings'
    | '/settings/account'
    | '/settings/members'
    | '/settings/ingest-tokens'
    | '/settings/flow-id-order'
    | '/settings/storage'
    | '/settings/appearance'
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

/** Settings: the v0.1 nav on the left (per-source settings live on each source's page). */
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
        <NavLink to="/settings/flow-id-order" icon={<NetworkIcon />}>
          Flow id order
        </NavLink>
        <NavLink to="/settings/storage" icon={<DatabaseIcon />}>
          Storage
        </NavLink>
        <NavLink to="/settings/appearance" icon={<PaletteIcon />}>
          Appearance
        </NavLink>
      </nav>
      <div className="min-w-0 flex-1 px-8 py-8">
        <Outlet />
      </div>
    </div>
  )
}

export function SettingsGeneral() {
  return <General />
}

export function SettingsStorage() {
  return <Storage />
}

export function SettingsFlowIds() {
  return <FlowIdOrder />
}

/** Appearance (this browser) + about. */
export function SettingsAppearance() {
  const { theme, setTheme } = useTheme()
  const health = useHealth().data
  return (
    <div className="max-w-2xl">
      <h2 className="font-semibold text-xl">Appearance</h2>
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
        Theme is kept per browser. Where the newest stream line sits is set for everyone in General, and each browser
        can flip it from the stream's view button.
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
