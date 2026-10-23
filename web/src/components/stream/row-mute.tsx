import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { useNavigate } from '@tanstack/react-router'
import {
  BoxIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  GitForkIcon,
  GlobeIcon,
  LockIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { createContext, type KeyboardEvent, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react'
import {
  fmtN,
  fmtShare,
  MethodSplit,
  OWNERS_ONLY,
  OWNERS_ONLY_GLOBAL,
  perMinute,
  SampleLine,
  Segmented,
  SourceBars,
  shareOf,
  WARN_SHARE,
} from '@/components/mute/rule-bits'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { LogLine, MutePreview, MuteRule, MuteScope } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import {
  defaultOption,
  effectiveRules,
  globalOff,
  matchesMute,
  type MuteOption,
  muteOptions,
  mutingRule,
  pickRoute,
  ruleTarget,
  ruleText,
  storedAs,
} from '@/lib/mute'
import {
  restoreOf,
  ruleHits,
  sumHits,
  useAddMuteRule,
  useDeleteMuteRule,
  useMutePreview,
  useMuteStats,
  useSetGlobalApply,
} from '@/lib/mute-api'
import { useSettings } from '@/lib/settings-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/**
 * Stream row hover → Mute (boards 03.15–03.23, light 09.6): a toolbar on the
 * hovered or focused row (Mute split button · Copy line · Open flow), the
 * mute menu with its This source / All sources switch and live preview, the
 * toast with Undo, and the muted / member / no-route / global states.
 */

/** Fade 150 ms + collapse 150 ms before the rule lands (03.19 After mute). */
export const HIDE_MS = 300

export interface RowMuteState {
  /** The rule hiding this line (only seen with Show muted). */
  mutedBy?: MuteRule
  /** A global rule matching this line that its source switched off. */
  offHere?: MuteRule
  hasRoute: boolean
}

export interface MuteCtx {
  owner: boolean
  canGlobal: boolean
  stateOf: (l: LogLine) => RowMuteState
  /** Rows matching this rule fade out while it is saved. */
  hiding: MuteRule | null
  /** `M` / the button: mute with the default option, or Unmute a muted row. */
  onMute: (l: LogLine) => void
  /** The caret / `⇧M`: open the menu at `anchor`. */
  onMenu: (l: LogLine, anchor: Element) => void
}

export const MuteContext = createContext<MuteCtx | null>(null)
export const useMuteCtx = () => useContext(MuteContext)

/** The toolbar on a hovered / focused row (03.15, 03.18). */
export function RowToolbar({
  line,
  selected,
  onCopy,
  onOpenFlow,
}: {
  line: LogLine
  selected: boolean
  onCopy: () => void
  onOpenFlow: () => void
}) {
  const ctx = useMuteCtx()
  const caret = useRef<HTMLButtonElement>(null)
  const st = ctx?.stateOf(line)
  const route = pickRoute(line)
  const target = st?.mutedBy ? ruleTarget(st.mutedBy) : (route?.path ?? null)
  const label = st?.mutedBy ? 'Unmute' : st?.hasRoute ? 'Mute' : 'Mute message'
  const tip = !ctx?.owner
    ? OWNERS_ONLY
    : st?.mutedBy
      ? `Unmute ${target} on ${line.source}${st.mutedBy.scope === 'global' ? ' (global rule: show here only)' : ''} · M`
      : st?.hasRoute
        ? `Mute ${target} on ${line.source} · any method · from ${route?.key} · M`
        : `Mute this message on ${line.source} · ${ruleText(defaultOption(muteOptions(line)).rule)} · M`
  const stop = (f: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    f()
  }
  const btn =
    'flex h-6 items-center gap-1 border bg-popover px-1.5 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3.5'
  return (
    <span
      className={cn(
        'pointer-events-none absolute inset-y-0 right-2 hidden items-center group-focus-within/row:flex group-hover/row:flex',
        selected && 'flex',
      )}
    >
      {selected && (
        <span
          aria-hidden
          data-testid="row-key-hint"
          className="absolute -top-6 right-0 hidden whitespace-nowrap border bg-popover px-2 py-0.5 font-mono text-[11px] text-muted-foreground shadow-sm md:block"
        >
          M mute · ⇧M options · C copy · ↵ open flow
        </span>
      )}
      <span role="toolbar" aria-label="Row actions" className="pointer-events-auto flex gap-1">
        {ctx && (
          <span className="flex">
            <button
              type="button"
              tabIndex={-1}
              title={tip}
              aria-label={ctx.owner ? tip.replace(/ · M$/, '') : `${label} (${OWNERS_ONLY})`}
              aria-keyshortcuts="M"
              aria-disabled={!ctx.owner || undefined}
              onClick={stop(() => ctx.onMute(line))}
              className={cn(btn, !ctx.owner && 'cursor-not-allowed opacity-60')}
            >
              {!ctx.owner ? <LockIcon /> : st?.mutedBy ? <EyeIcon /> : <EyeOffIcon />}
              {label}
            </button>
            <button
              ref={caret}
              type="button"
              tabIndex={-1}
              data-mute-caret
              aria-label="Mute options"
              aria-haspopup="menu"
              aria-keyshortcuts="Shift+M"
              disabled={!ctx.owner}
              onClick={stop(() => caret.current && ctx.onMenu(line, caret.current))}
              className={cn(btn, '-ml-px px-1', !ctx.owner && 'cursor-not-allowed opacity-60')}
            >
              <ChevronDownIcon />
            </button>
          </span>
        )}
        <button
          type="button"
          tabIndex={-1}
          title="Copy line · C"
          aria-label="Copy line"
          aria-keyshortcuts="C"
          onClick={stop(onCopy)}
          className={btn}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Open flow"
          aria-keyshortcuts="Enter"
          onClick={stop(onOpenFlow)}
          className={btn}
        >
          <GitForkIcon />
          Open flow
        </button>
      </span>
    </span>
  )
}

/** The `muted` tag on a row seen with Show muted (03.18 / 03.23): names the scope and the rule. */
export function MutedTag({ rule }: { rule: MuteRule }) {
  return (
    <span
      data-testid="muted-tag"
      className="ml-1 inline-flex min-w-0 shrink items-center gap-1 truncate border border-dashed px-1 font-mono text-[10px] text-muted-foreground"
    >
      <EyeOffIcon className="size-2.5 shrink-0" aria-hidden />
      muted
      <span className="truncate text-muted-foreground/70">
        {rule.scope === 'global' ? 'global · ' : ''}
        {ruleText(rule)}
      </span>
    </span>
  )
}

// ---- the menu -------------------------------------------------------------------------

export interface MenuState {
  line: LogLine
  anchor: Element
}

/**
 * The mute menu (03.16 / 03.20 / 03.21), or for a muted row the unmute
 * choices (03.23: Show on this source only / Unmute everywhere / Open global
 * rule), or for a line a global rule would hide but is off here: Mute on this
 * source / Turn the global rule back on here.
 */
export function MuteMenu({ api }: { api: RowMuteApi }) {
  const menu = api.menu
  return (
    <PopoverPrimitive.Root open={menu != null} onOpenChange={(o) => !o && api.closeMenu()}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={menu?.anchor}
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            aria-label="Mute"
            className="w-[420px] max-w-[calc(100vw-2rem)] bg-popover text-popover-foreground text-xs shadow-lg outline-none ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0"
          >
            {menu && <MenuBody key={menu.line.id} line={menu.line} api={api} onClose={api.closeMenu} />}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function MenuBody({ line, api, onClose }: { line: LogLine; api: RowMuteApi; onClose: () => void }) {
  const st = api.stateOf(line)
  if (st.mutedBy) return <UnmuteMenu line={line} rule={st.mutedBy} api={api} onClose={onClose} />
  if (st.offHere) return <OffHereMenu line={line} rule={st.offHere} api={api} onClose={onClose} />
  return <ScopeMenu line={line} api={api} onClose={onClose} />
}

function ActionItem({
  icon,
  title,
  sub,
  onClick,
  disabled,
}: {
  icon: ReactNode
  title: string
  sub: ReactNode
  onClick: () => void
  disabled?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={Boolean(disabled)}
      title={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {icon}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{title}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
      </span>
    </button>
  )
}

function UnmuteMenu({
  line,
  rule,
  api,
  onClose,
}: {
  line: LogLine
  rule: MuteRule
  api: RowMuteApi
  onClose: () => void
}) {
  const hits = api.hitsOf(rule)
  const others = Object.keys(hits).filter((s) => s !== line.source).length
  const go = (f: () => void) => () => {
    onClose()
    f()
  }
  return (
    <div role="menu" aria-label="Unmute" className="flex flex-col py-1">
      {rule.scope === 'global' ? (
        <>
          <ActionItem
            icon={<EyeIcon />}
            title={`Show on ${line.source} only`}
            sub={`Don't apply here · global rule stays on ${others} ${others === 1 ? 'source' : 'sources'}`}
            onClick={go(() => api.showHere(line, rule))}
          />
          <ActionItem
            icon={<GlobeIcon />}
            title="Unmute everywhere"
            sub={`deletes global rule ${ruleText(rule)} · ${fmtN(sumHits(hits))} lines on ${Object.keys(hits).length} sources`}
            onClick={go(() => api.deleteRule(rule, line.source))}
            disabled={api.canGlobal ? undefined : OWNERS_ONLY_GLOBAL}
          />
          <ActionItem
            icon={<ExternalLinkIcon />}
            title="Open global rule"
            sub="Settings → Muted lines"
            onClick={go(() => api.openGlobal())}
          />
        </>
      ) : (
        <>
          <ActionItem
            icon={<EyeIcon />}
            title={`Unmute on ${line.source}`}
            sub={`deletes rule ${ruleText(rule)} · ${fmtN(hits[line.source] ?? 0)} lines return`}
            onClick={go(() => api.deleteRule(rule, line.source))}
          />
          <ActionItem
            icon={<ExternalLinkIcon />}
            title="Edit rules"
            sub={`Sources → ${line.source} → Muted lines`}
            onClick={go(() => api.openSource(line.source))}
          />
        </>
      )}
    </div>
  )
}

function OffHereMenu({
  line,
  rule,
  api,
  onClose,
}: {
  line: LogLine
  rule: MuteRule
  api: RowMuteApi
  onClose: () => void
}) {
  const opt = defaultOption(muteOptions(line))
  return (
    <div role="menu" aria-label="Mute" className="flex flex-col py-1">
      <ActionItem
        icon={<BoxIcon />}
        title={`Mute on ${line.source}`}
        sub={`adds source rule ${ruleText(opt.rule)}`}
        onClick={() => {
          onClose()
          api.mute(line, opt.rule)
        }}
      />
      <ActionItem
        icon={<GlobeIcon />}
        title="Turn the global rule back on here"
        sub={`${ruleText(rule)} is global but off on ${line.source}`}
        onClick={() => {
          onClose()
          api.applyHere(line, rule)
        }}
      />
    </div>
  )
}

function ScopeMenu({ line, api, onClose }: { line: LogLine; api: RowMuteApi; onClose: () => void }) {
  // The menu opens on This source every time (03.23).
  const [scope, setScope] = useState<MuteScope>('source')
  const options = useMemo(() => muteOptions(line, scope), [line, scope])
  const [pick, setPick] = useState(() => options.indexOf(defaultOption(options)))
  const preview = useMutePreview(
    options.map((o) => o.rule),
    scope === 'global' ? [] : [line.source],
  )
  const pv = (i: number): MutePreview | undefined => (options[i].disabled ? undefined : preview.data?.[i])
  const chosen = options[pick]
  const p = pv(pick)
  const nSources = p ? Object.keys(p.per_source).length : 0
  const known = Object.keys(api.allSources()).length
  const switchScope = () => api.canGlobal && setScope((s) => (s === 'source' ? 'global' : 'source'))
  const confirm = () => {
    if (chosen.disabled) return
    onClose()
    api.mute(line, chosen.rule, p)
  }
  const move = (by: number) => {
    let i = pick
    for (let n = 0; n < options.length; n++) {
      i = (i + by + options.length) % options.length
      if (!options[i].disabled) break
    }
    setPick(i)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      switchScope()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      confirm()
    } else if (/^[123]$/.test(e.key)) {
      const i = Number(e.key) - 1
      if (!options[i].disabled) setPick(i)
    }
  }
  const verb = chosen.key === 'message' ? 'Mute message' : 'Mute route'

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the menu's own keys (↑↓ 1 2 3 tab ↵)
    <div onKeyDown={onKey} className="flex flex-col outline-none" data-testid="mute-menu">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="uppercase tracking-[0.06em]">Mute</span>
        <span>{api.canGlobal ? 'Tab switches scope' : 'adds a muted-lines rule'}</span>
      </div>
      <div className="px-2 pb-2">
        <Segmented
          label="Scope"
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'source', label: 'This source', sub: line.source, icon: <BoxIcon /> },
            {
              value: 'global',
              label: 'All sources',
              sub: 'global',
              icon: <GlobeIcon />,
              disabled: !api.canGlobal,
              reason: OWNERS_ONLY_GLOBAL,
            },
          ]}
        />
      </div>
      <div
        role="menu"
        aria-label={`Mute on ${scope === 'global' ? 'all sources' : line.source}`}
        className="flex flex-col border-b px-1 pb-1"
      >
        {options.map((o, i) => (
          <OptionRow
            key={o.key}
            n={i + 1}
            option={o}
            on={i === pick}
            preview={pv(i)}
            scope={scope}
            source={line.source}
            onPick={() => setPick(i)}
            onConfirm={confirm}
          />
        ))}
      </div>
      <section aria-label="Will hide" aria-live="polite" className="flex flex-col gap-1.5 border-b px-3 py-2.5">
        <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
          <span className="uppercase tracking-[0.06em]">Will hide</span>
          <span>live preview</span>
        </div>
        {chosen.disabled ? (
          <span className="text-muted-foreground">{chosen.disabled}</span>
        ) : !p ? (
          <span className="text-muted-foreground">Counting…</span>
        ) : (
          <>
            <span>
              <span className="font-medium">
                {p.estimated ? '~' : ''}
                {fmtN(p.total)} lines
              </span>{' '}
              <span className="text-muted-foreground">
                {scope === 'global'
                  ? `in 24h on ${nSources} of ${Math.max(known, nSources)} sources`
                  : `in the last 24h · ${perMinute(p.total)}`}
              </span>
            </span>
            {scope === 'global' ? (
              <>
                {nSources > 0 && (
                  <SourceBars
                    per={p.per_source}
                    names={Object.keys(p.per_source)
                      .sort((a, b) => p.per_source[b] - p.per_source[a])
                      .slice(0, 5)}
                  />
                )}
                <span className="text-muted-foreground">
                  New sources get this rule too. Each source can switch it off.
                </span>
              </>
            ) : (
              <>
                <MethodSplit p={p} from={chosen.rule.field} />
                {p.samples.map((l) => (
                  <SampleLine key={l.id} line={l} />
                ))}
                <span className="text-muted-foreground">Still stored. Search shows them with Show muted.</span>
              </>
            )}
          </>
        )}
      </section>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> choose
          {api.canGlobal && (
            <>
              {' '}
              <Kbd>tab</Kbd> scope
            </>
          )}{' '}
          <Kbd>esc</Kbd> close
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={confirm} disabled={Boolean(chosen.disabled)}>
          {scope === 'global' ? 'Mute everywhere' : verb} <Kbd>↵</Kbd>
        </Button>
      </div>
    </div>
  )
}

function OptionRow({
  n,
  option,
  on,
  preview: p,
  scope,
  source,
  onPick,
  onConfirm,
}: {
  n: number
  option: MuteOption
  on: boolean
  preview: MutePreview | undefined
  scope: MuteScope
  source: string
  onPick: () => void
  onConfirm: () => void
}) {
  const share = shareOf(p)
  const warn = p != null && share > WARN_SHARE
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      aria-disabled={option.disabled ? true : undefined}
      // biome-ignore lint/a11y/noAutofocus: the menu opens on the default option (keyboard first)
      autoFocus={on}
      onClick={() => {
        if (option.disabled) return
        if (on) onConfirm()
        else onPick()
      }}
      title={option.disabled}
      className={cn(
        'grid grid-cols-[16px_minmax(0,1fr)_auto_18px] items-start gap-2.5 px-2 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
        on && 'bg-muted',
        option.disabled && 'cursor-not-allowed opacity-45',
      )}
    >
      <span className={cn('mt-0.5 flex size-3.5 items-center justify-center border', on && 'border-foreground')}>
        {on && <span className="size-2 bg-foreground" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{option.label}</span>
        <span className="truncate font-mono text-[11px] text-brand">
          {option.disabled ? option.disabled : scope === 'global' ? ruleText(option.rule) : storedAs(option.rule)}
        </span>
        {warn && (
          <span className="flex items-center gap-1 font-mono text-[11px] text-status-warn">
            <TriangleAlertIcon className="size-3" aria-hidden /> matches {fmtShare(share)} of{' '}
            {scope === 'global' ? `${Object.keys(p.per_source).length} sources` : source}
          </span>
        )}
      </span>
      <span className="flex flex-col items-end font-mono text-[11px] tabular-nums">
        <span className={warn ? 'text-status-warn' : undefined}>
          {p ? `${p.estimated ? '~' : ''}${fmtN(p.total)}` : option.disabled ? '' : '…'}
        </span>
        {p && <span className="text-muted-foreground">24h</span>}
      </span>
      <Kbd className="h-4 min-w-4 text-[10px]">{n}</Kbd>
    </button>
  )
}

// ---- the page's side: state, writes, toasts, Undo -----------------------------------------

export interface RowMuteApi extends MuteCtx {
  mute: (l: LogLine, rule: MuteRule, preview?: MutePreview) => Promise<void>
  showHere: (l: LogLine, rule: MuteRule) => void
  applyHere: (l: LogLine, rule: MuteRule) => void
  deleteRule: (rule: MuteRule, source: string) => void
  openGlobal: () => void
  openSource: (source: string) => void
  hitsOf: (rule: MuteRule) => Record<string, number>
  allSources: () => Record<string, unknown>
  /** ⌘Z while the last toast is up; false when there is nothing to undo. */
  undo: () => boolean
  canUndo: boolean
  menu: MenuState | null
  closeMenu: () => void
}

const UNDO_MS = 8000

/** Everything the stream needs for row mute; `onMenu` opens {@link MuteMenu}. */
export function useRowMute(): RowMuteApi {
  const data = useSettings().data
  const owner = isOwner(useMe())
  const stats = useMuteStats().data
  const add = useAddMuteRule()
  const del = useDeleteMuteRule()
  const apply = useSetGlobalApply()
  const navigate = useNavigate()
  const [hiding, setHiding] = useState<MuteRule | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const undoRef = useRef<{ fn: () => void; until: number } | null>(null)
  const [undoUntil, setUndoUntil] = useState(0)

  const offer = useCallback((fn: () => void) => {
    const until = Date.now() + UNDO_MS
    undoRef.current = { fn, until }
    setUndoUntil(until)
    setTimeout(() => setUndoUntil((u) => (u === until ? 0 : u)), UNDO_MS)
  }, [])

  const stateOf = useCallback(
    (l: LogLine): RowMuteState => {
      const mutedBy = mutingRule(l, effectiveRules(data, l.source))
      const own = data?.sources[l.source]
      const offHere = mutedBy
        ? undefined
        : (data?.muted_global ?? []).find((g) => g.enabled && globalOff(own, g.id) && matchesMute(l, g))
      return { mutedBy, offHere, hasRoute: pickRoute(l) != null }
    },
    [data],
  )

  const openSource = useCallback(
    (source: string) => navigate({ to: '/sources/$name', params: { name: source }, search: { edit: 'muted' } }),
    [navigate],
  )
  const openGlobal = useCallback(() => navigate({ to: '/settings/muted-lines' }), [navigate])

  const mute = useCallback(
    async (l: LogLine, rule: MuteRule, preview?: MutePreview) => {
      if (!owner) {
        toast.info(OWNERS_ONLY)
        return
      }
      setHiding(rule)
      await new Promise((r) => setTimeout(r, HIDE_MS))
      try {
        const res = await add.mutateAsync({ rule, source: rule.scope === 'source' ? l.source : undefined })
        const global = res.rule.scope === 'global'
        const undo = () => del.mutate(res.rule.id)
        const count =
          preview != null
            ? `${fmtN(preview.total)} lines hidden${global ? ` on ${Object.keys(preview.per_source).length} sources` : ''} · `
            : ''
        toast.success(`Muted ${ruleTarget(res.rule)} ${global ? 'everywhere' : `on ${l.source}`}`, {
          description: (
            <span className="flex flex-col gap-1">
              <span className="font-mono text-[11px]">
                {count}
                {global ? 'global rule' : 'rule'} {ruleText(res.rule)}
              </span>
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1 underline"
                onClick={() => (global ? openGlobal() : openSource(l.source))}
              >
                {global ? 'Global rules' : 'Edit rules'} <ExternalLinkIcon className="size-3" />
              </button>
            </span>
          ),
          duration: UNDO_MS,
          button: { title: 'Undo ⌘Z', onClick: undo },
        })
        offer(undo)
      } catch (e) {
        toast.error('Could not mute', { description: (e as Error).message })
      } finally {
        setHiding(null)
      }
    },
    [owner, add, del, offer, openGlobal, openSource],
  )

  const deleteRule = useCallback(
    (rule: MuteRule, source: string) => {
      del.mutate(rule.id, {
        onSuccess: (d) => {
          const undo = () => add.mutate(restoreOf(d))
          toast.success(
            rule.scope === 'global'
              ? `Unmuted ${ruleTarget(rule)} everywhere`
              : `Unmuted ${ruleTarget(rule)} on ${source}`,
            {
              description: `${rule.scope === 'global' ? 'Deleted global rule' : 'Deleted rule'} ${ruleText(rule)}`,
              duration: UNDO_MS,
              button: { title: 'Undo ⌘Z', onClick: undo },
            },
          )
          offer(undo)
        },
        onError: (e) => toast.error('Could not unmute', { description: e.message }),
      })
    },
    [del, add, offer],
  )

  const setApplyHere = useCallback(
    (l: LogLine, rule: MuteRule, on: boolean) => {
      apply.mutate(
        { source: l.source, id: rule.id, apply: on },
        {
          onSuccess: () => {
            const undo = () => apply.mutate({ source: l.source, id: rule.id, apply: !on })
            toast.success(on ? `Global rule on again for ${l.source}` : `Showing ${ruleTarget(rule)} on ${l.source}`, {
              description: on
                ? `${ruleText(rule)} hides its lines here again.`
                : `Don't apply here · ${ruleText(rule)} stays on the other sources.`,
              duration: UNDO_MS,
              button: { title: 'Undo ⌘Z', onClick: undo },
            })
            offer(undo)
          },
          onError: (e) => toast.error('Could not change the rule here', { description: e.message }),
        },
      )
    },
    [apply, offer],
  )

  const onMute = useCallback(
    (l: LogLine) => {
      if (!owner) {
        toast.info(OWNERS_ONLY)
        return
      }
      const st = stateOf(l)
      if (st.mutedBy) {
        // Unmute: a source rule goes; a global rule stops applying here.
        if (st.mutedBy.scope === 'global') setApplyHere(l, st.mutedBy, false)
        else deleteRule(st.mutedBy, l.source)
        return
      }
      // M always mutes on this source, never global from one key (03.23).
      mute(l, defaultOption(muteOptions(l, 'source')).rule)
    },
    [owner, stateOf, mute, deleteRule, setApplyHere],
  )

  const onMenu = useCallback(
    (l: LogLine, anchor: Element) => {
      if (!owner) {
        toast.info(OWNERS_ONLY)
        return
      }
      setMenu({ line: l, anchor })
    },
    [owner],
  )

  return {
    owner,
    canGlobal: owner,
    stateOf,
    hiding,
    onMute,
    onMenu,
    mute,
    showHere: (l, r) => setApplyHere(l, r, false),
    applyHere: (l, r) => setApplyHere(l, r, true),
    deleteRule,
    openGlobal,
    openSource,
    hitsOf: (r) => ruleHits(stats, r.id),
    allSources: () => stats?.sources ?? {},
    undo: () => {
      const u = undoRef.current
      if (!u || Date.now() > u.until) return false
      undoRef.current = null
      setUndoUntil(0)
      u.fn()
      return true
    },
    canUndo: undoUntil > Date.now(),
    menu,
    closeMenu: () => setMenu(null),
  }
}
