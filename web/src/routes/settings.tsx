import { MoonIcon, SunIcon } from 'lucide-react'
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

/** Placeholder: appearance + about. Storage, members, tokens arrive with their slices. */
export function SettingsPage() {
  const { theme, setTheme } = useTheme()
  const health = useHealth().data
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="flex h-14 items-center border-b px-6">
        <h1 className="font-medium text-base">Settings</h1>
      </header>
      <div className="max-w-2xl px-6 py-4">
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
          Storage, retention, members and ingest tokens arrive with their slices.
        </p>
      </div>
    </div>
  )
}
