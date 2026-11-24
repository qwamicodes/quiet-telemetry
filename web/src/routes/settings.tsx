import { Link, Outlet } from '@tanstack/react-router'
import {
  CheckIcon,
  EyeOffIcon,
  InfoIcon,
  KeyIcon,
  PackageIcon,
  SettingsIcon,
  SunIcon,
  UsersIcon,
  WorkflowIcon,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { About } from '@/components/settings/about'
import { Account } from '@/components/settings/account'
import { General } from '@/components/settings/general'
import { FlowIdOrder } from '@/components/settings/id-order'
import { PageHeader, SettingRow } from '@/components/settings/kit'
import { Members } from '@/components/settings/members'
import { MutedLinesSettings } from '@/components/settings/muted-lines'
import { StoragePage } from '@/components/settings/storage/page'
import { IngestTokens } from '@/components/tokens/token-table'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Marker } from '@/components/whats-new/marker'
import { ACCENTS, type Accent, type Density, useAppearance } from '@/lib/appearance'
import { useSettings } from '@/lib/settings-api'
import { type ThemePref, useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { type Target, useSeenOnVisit, useWhatsNew } from '@/lib/whats-new'

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
    | '/settings/muted-lines'
    | '/settings/storage'
    | '/settings/appearance'
    | '/settings/about'
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="flex h-7 shrink-0 items-center gap-2.5 px-2.5 font-medium text-sidebar-foreground text-xs outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground [&_svg]:size-3.5"
    >
      {icon}
      {children}
    </Link>
  )
}

function SettingsMarker({ target }: { target: Target }) {
  const kind = useWhatsNew().marker(target)
  return kind ? <Marker kind={kind} className="ml-auto" /> : null
}

/** Settings (v0.1-07.x): a 200 px nav, then a 760 px page column, 48 px apart. */
export function SettingsLayout() {
  return (
    <div className="flex min-h-0 flex-1 gap-12 overflow-y-auto p-8">
      <nav className="flex w-50 shrink-0 flex-col gap-0.5" aria-label="Settings">
        <span className="pb-2 font-medium font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          Settings
        </span>
        <NavLink to="/settings" icon={<SettingsIcon />}>
          General
        </NavLink>
        <NavLink to="/settings/account" icon={<KeyIcon />}>
          Account
        </NavLink>
        <NavLink to="/settings/members" icon={<UsersIcon />}>
          Members
        </NavLink>
        <NavLink to="/settings/ingest-tokens" icon={<KeyIcon />}>
          Ingest tokens
        </NavLink>
        <NavLink to="/settings/flow-id-order" icon={<WorkflowIcon />}>
          Flow id order
        </NavLink>
        <NavLink to="/settings/muted-lines" icon={<EyeOffIcon />}>
          Muted lines
        </NavLink>
        <NavLink to="/settings/storage" icon={<PackageIcon />}>
          Storage
        </NavLink>
        <NavLink to="/settings/appearance" icon={<SunIcon />}>
          Appearance
          <SettingsMarker target="settings.appearance" />
        </NavLink>
        <NavLink to="/settings/about" icon={<InfoIcon />}>
          About
        </NavLink>
      </nav>
      <div className="w-full min-w-0 max-w-190">
        <Outlet />
      </div>
    </div>
  )
}

export function SettingsGeneral() {
  return <General />
}

export function SettingsStorage() {
  return <StoragePage />
}

export function SettingsMuted() {
  return <MutedLinesSettings />
}

export function SettingsFlowIds() {
  return <FlowIdOrder />
}

/** A miniature of the app in one theme, for the theme cards. */
function ThemeThumb({ theme }: { theme: 'dark' | 'light' }) {
  const dark = theme === 'dark'
  return (
    <div className="relative z-10 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className={cn('size-2 rounded-full border-2', dark ? 'border-[#8087FF]' : 'border-[#4F55E0]')} />
        <span className={cn('h-[5px] w-10 opacity-80', dark ? 'bg-[#E8E9EC]' : 'bg-[#0B0C0E]')} />
      </div>
      <div className="flex flex-col gap-1.5">
        {[90, 70, 110, 60].map((w) => (
          <div key={w} className="flex items-center gap-1.5">
            <span className={cn('h-1 w-[22px]', dark ? 'bg-[#1A1B1F]' : 'bg-[#E6E7EA]')} />
            <span className={cn('h-1', dark ? 'bg-[#1A1B1F]' : 'bg-[#E6E7EA]')} style={{ width: w }} />
          </div>
        ))}
      </div>
    </div>
  )
}

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
]

function ThemeCard({ value, label, on, pick }: { value: ThemePref; label: string; on: boolean; pick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={pick}
      className={cn(
        'flex flex-1 flex-col gap-2.5 border bg-card p-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
        on && 'border-brand shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_25%,transparent)]',
      )}
    >
      <span
        className={cn(
          'relative flex h-24 flex-col overflow-hidden border p-3',
          value === 'light' ? 'border-[#E6E7EA] bg-white' : 'border-[#1A1B1F] bg-[#0B0C0E]',
        )}
      >
        {value === 'system' && <span aria-hidden className="absolute inset-y-0 right-0 w-1/2 bg-white" />}
        <ThemeThumb theme={value === 'light' ? 'light' : 'dark'} />
      </span>
      <span className="flex items-center justify-between font-medium text-sm">
        {label}
        {on && <CheckIcon className="size-3.5 text-brand" />}
      </span>
    </button>
  )
}

const DIRECTION_KEY = 'quiet.stream-direction'

/** This browser's stream direction: its own flip, else the instance default from General. */
function useBrowserDirection(): ['bottom' | 'top', (d: 'bottom' | 'top') => void] {
  const instance = useSettings().data?.general.stream_direction
  const [mine, setMine] = useState<'bottom' | 'top' | null>(() => {
    try {
      const v = localStorage.getItem(DIRECTION_KEY)
      return v === 'top' || v === 'bottom' ? v : null
    } catch {
      return null
    }
  })
  const set = (d: 'bottom' | 'top') => {
    setMine(d)
    try {
      localStorage.setItem(DIRECTION_KEY, d)
    } catch {
      // private mode
    }
  }
  return [mine ?? instance ?? 'bottom', set]
}

const DENSITIES: { value: Density; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable 32' },
  { value: 'default', label: 'Default 28' },
  { value: 'compact', label: 'Compact 24' },
]

/** Appearance (v0.1-07.9): everything here is saved to this browser. */
export function SettingsAppearance() {
  const { pref, setTheme, theme } = useTheme()
  const [a, set] = useAppearance()
  useSeenOnVisit('settings.appearance')
  const [direction, setDirection] = useBrowserDirection()
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Appearance" sub="Saved to this browser." />
      <fieldset className="flex flex-col gap-2.5">
        <legend className="pb-2.5 font-semibold text-sm">Theme</legend>
        <div className="flex gap-3">
          {THEMES.map((t) => (
            <ThemeCard key={t.value} {...t} on={pref === t.value} pick={() => setTheme(t.value)} />
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col">
        <SettingRow label="Stream direction" hint="Bottom follows like a terminal tail.">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[direction]}
            onValueChange={(v) => v[0] && setDirection(v[0] as 'bottom' | 'top')}
            aria-label="Stream direction"
          >
            <ToggleGroupItem value="bottom">Newest at bottom</ToggleGroupItem>
            <ToggleGroupItem value="top">Newest at top</ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
        <SettingRow label="Row density" hint="28px is the default. Compact fits about 30% more lines.">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[a.density]}
            onValueChange={(v) => v[0] && set({ density: v[0] as Density })}
            aria-label="Row density"
          >
            {DENSITIES.map((d) => (
              <ToggleGroupItem key={d.value} value={d.value}>
                {d.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <SettingRow label="Wrap long lines" hint="Off keeps one line per row; the card always shows everything.">
          <Switch aria-label="Wrap long lines" checked={a.wrap} onCheckedChange={(wrap) => set({ wrap })} />
        </SettingRow>
        <SettingRow label="Tint error rows" hint="A faint red wash on error rows so they stand out while streaming.">
          <Switch
            aria-label="Tint error rows"
            checked={a.tintErrors}
            onCheckedChange={(tintErrors) => set({ tintErrors })}
          />
        </SettingRow>
        <SettingRow
          label="Accent"
          hint={`${ACCENTS[a.accent].label} marks selection, the logo and links. Nothing else.`}
        >
          <fieldset aria-label="Accent" className="flex gap-1.5">
            {(Object.keys(ACCENTS) as Accent[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={a.accent === k}
                aria-label={ACCENTS[k].label}
                onClick={() => set({ accent: k })}
                className={cn(
                  'size-[22px] outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  a.accent === k && 'shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--swatch)]',
                )}
                style={{ background: ACCENTS[k][theme], ['--swatch' as string]: ACCENTS[k][theme] }}
              />
            ))}
          </fieldset>
        </SettingRow>
      </div>
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

export function SettingsAbout() {
  return <About />
}
