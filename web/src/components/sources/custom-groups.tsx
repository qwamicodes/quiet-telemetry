import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  EllipsisIcon,
  EyeOffIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  RowsIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react'
import { type FormEvent, Fragment, useState } from 'react'
import { GroupIcon } from '@/components/source-group-header'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHeader,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import type { CustomGroup, GroupKind, SourceInfo } from '@/gen'
import { kindLabel } from '@/lib/connect'
import { autoGroupOf, groupKey, groupOf, groupSources, type SourceGroup, sourceStatus } from '@/lib/source-groups'
import {
  MAX_GROUP_NAME,
  useAssignSources,
  useCreateGroup,
  useDeleteGroup,
  useUpdateGroup,
} from '@/lib/source-groups-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

const nameTaken = (groups: CustomGroup[], name: string, except?: string) =>
  groups.some((g) => g.id !== except && g.name.toLowerCase() === name.trim().toLowerCase())

/** Why a source lands where it does without a custom group (06.11). */
export function autoReason(kind: GroupKind | undefined): string {
  switch (kind) {
    case 'standalone':
      return 'no Compose project or stack on this service.'
    case 'compose':
      return 'its Compose project.'
    case 'stack':
      return 'its Swarm stack.'
    case 'custom':
      return 'its group label.'
    case 'ingest':
      return 'pushed sources sit under Ingest.'
    default:
      return 'automatic grouping.'
  }
}

const label = (s: SourceInfo) => s.display_name ?? s.name

/** The dashed hint under the table (06.9). */
export function GroupRulesHint() {
  return (
    <p className="flex items-center gap-2 border border-dashed px-3 py-2.5 text-xs" data-testid="group-rules-hint">
      <FolderIcon className="size-3.5 shrink-0 text-brand" />
      <span>A group you make wins over Compose / Stack.</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">
        · ⋯ on a source → Move to group · Automatic puts it back · owners and admins can edit groups
      </span>
    </p>
  )
}

function NameField({
  id,
  value,
  onChange,
  error,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  error: string | null
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-xs">
        Name
      </label>
      <div className="relative">
        <Input
          id={id}
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to type a name
          autoFocus
          value={value}
          maxLength={MAX_GROUP_NAME}
          aria-invalid={error != null}
          placeholder="Legivent staging"
          onChange={(e) => onChange(e.target.value)}
          className="pr-16"
        />
        <span className="absolute top-1.5 right-2 font-mono text-[11px] text-muted-foreground tabular-nums">
          {value.length} / {MAX_GROUP_NAME}
        </span>
      </div>
      {error && <span className="text-status-err text-xs">{error}</span>}
    </div>
  )
}

/**
 * Sources → New group (board v0.1-06.10): a name and an optional checklist of
 * sources, listed under the group they sit in now. Picked sources move in
 * with the same request.
 */
export function NewGroupDialog({
  open,
  onClose,
  sources,
  custom,
  preselect = [],
}: {
  open: boolean
  onClose: () => void
  sources: SourceInfo[]
  custom: CustomGroup[]
  /** Sources ticked when it opens (⋯ → Move to group → New group…). */
  preselect?: string[]
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <NewGroupForm
          key={preselect.join(',')}
          onClose={onClose}
          sources={sources}
          custom={custom}
          preselect={preselect}
        />
      )}
    </Dialog>
  )
}

function NewGroupForm({
  onClose,
  sources,
  custom,
  preselect,
}: {
  onClose: () => void
  sources: SourceInfo[]
  custom: CustomGroup[]
  preselect: string[]
}) {
  const create = useCreateGroup()
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preselect))
  const q = filter.trim().toLowerCase()
  const matches = (s: SourceInfo) => !q || `${s.name} ${s.display_name ?? ''}`.toLowerCase().includes(q)
  const shown = sources.filter(matches)
  const groups = groupSources(sources, shown, undefined, custom)
  const sections: { key: string; title?: string; kind?: GroupKind; rows: SourceInfo[]; all: SourceInfo[] }[] =
    groups.length > 0
      ? groups.map((g) => ({
          key: g.key,
          title: g.name,
          kind: g.kind,
          rows: g.rows,
          all: sources.filter((s) => {
            const x = groupOf(s)
            return x != null && groupKey(x) === g.key
          }),
        }))
      : [{ key: 'all', rows: shown, all: sources }]
  const trimmed = name.trim()
  const error = trimmed && nameTaken(custom, trimmed) ? `A group named “${trimmed}” already exists.` : null
  const ok = trimmed.length > 0 && trimmed.length <= MAX_GROUP_NAME && !error
  const toggle = (n: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p)
      if (on) next.add(n)
      else next.delete(n)
      return next
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok || create.isPending) return
    const list = sources.filter((s) => picked.has(s.name)).map((s) => s.name)
    try {
      await create.mutateAsync({ name: trimmed, sources: list })
      toast.success(`Created ${trimmed}`, {
        description:
          list.length > 0
            ? `${list.length} ${list.length === 1 ? 'source' : 'sources'} moved in. Automatic puts one back.`
            : 'Add sources from any source’s ⋯ menu → Move to group.',
      })
      onClose()
    } catch (err) {
      toast.error('Could not create the group', { description: (err as Error).message })
    }
  }

  return (
    <DialogContent className="max-w-130 gap-4" aria-label="New group">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>
            Group sources your way. A source you put in a group stays there, whatever its Compose project or stack says.
          </DialogDescription>
        </DialogHeader>
        <NameField id="new-group-name" value={name} onChange={setName} error={error} />
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-xs">
            Pick sources <span className="font-normal font-mono text-[11px] text-muted-foreground">optional</span>
          </span>
          <div className="border">
            <div className="flex items-center gap-2 border-b px-2.5">
              <SearchIcon className="size-3.5 text-muted-foreground" />
              <input
                aria-label="Filter sources to pick"
                placeholder="Filter sources"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
              {q && shown.length > 0 && (
                <button
                  type="button"
                  className="font-mono text-[11px] text-brand hover:underline"
                  onClick={() => setPicked((p) => new Set([...p, ...shown.map((s) => s.name)]))}
                >
                  Select all {shown.length} {shown.length === 1 ? 'match' : 'matches'}
                </button>
              )}
            </div>
            <fieldset className="m-0 max-h-72 min-w-0 overflow-y-auto border-0 p-0" aria-label="Sources to pick">
              {sections.map((sec) =>
                sec.rows.length === 0 ? null : (
                  <Fragment key={sec.key}>
                    {sec.title && sec.kind && (
                      <div className="flex h-7 items-center gap-2 bg-muted/30 px-2.5 font-mono font-semibold text-[11px]">
                        <GroupIcon kind={sec.kind} className="size-3" />
                        <span className="flex-1 truncate">{sec.title}</span>
                        <span className="font-normal text-muted-foreground">
                          {sec.all.filter((s) => picked.has(s.name)).length} of {sec.all.length}
                        </span>
                      </div>
                    )}
                    {sec.rows.map((s) => {
                      const on = picked.has(s.name)
                      return (
                        // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
                        <label
                          key={s.name}
                          className={cn(
                            'flex h-7.5 cursor-pointer items-center gap-2.5 pr-2.5 pl-6 text-[13px] hover:bg-row-hover',
                            on && 'bg-brand/5',
                          )}
                        >
                          <Checkbox
                            checked={on}
                            onCheckedChange={(v) => toggle(s.name, Boolean(v))}
                            aria-label={label(s)}
                          />
                          <StatusDot status={sourceStatus(s)} />
                          <span className="flex-1 truncate">{label(s)}</span>
                          <span className="border px-1 font-mono text-[10px] text-muted-foreground">
                            {kindLabel(s.kind)}
                          </span>
                        </label>
                      )
                    })}
                  </Fragment>
                ),
              )}
              {shown.length === 0 && (
                <p className="px-3 py-3 text-muted-foreground text-xs">
                  {sources.length === 0 ? 'No sources yet.' : 'No source matches.'}
                </p>
              )}
            </fieldset>
          </div>
          <span className="text-muted-foreground text-xs">
            You can add more later from any source’s ⋯ menu → Move to group.
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <UsersIcon className="size-3.5" /> owners and admins
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-muted-foreground" data-testid="picked-count">
            {picked.size} selected
          </span>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ok || create.isPending}>
            Create group <Kbd className="ml-1 bg-background/20 text-current">↵</Kbd>
          </Button>
        </div>
      </form>
    </DialogContent>
  )
}

/** ⋯ → Rename (F2) on a custom group header. */
export function RenameGroupDialog({
  group,
  custom,
  onClose,
}: {
  group: CustomGroup | null
  custom: CustomGroup[]
  onClose: () => void
}) {
  return (
    <Dialog open={group != null} onOpenChange={(o) => !o && onClose()}>
      {group && <RenameForm key={group.id} group={group} custom={custom} onClose={onClose} />}
    </Dialog>
  )
}

function RenameForm({ group, custom, onClose }: { group: CustomGroup; custom: CustomGroup[]; onClose: () => void }) {
  const update = useUpdateGroup()
  const [name, setName] = useState(group.name)
  const trimmed = name.trim()
  const error = trimmed && nameTaken(custom, trimmed, group.id) ? `A group named “${trimmed}” already exists.` : null
  const ok = trimmed.length > 0 && !error && trimmed !== group.name
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok) return
    try {
      await update.mutateAsync({ id: group.id, name: trimmed })
      toast.success('Group renamed', { description: `${group.name} → ${trimmed}` })
      onClose()
    } catch (err) {
      toast.error('Could not rename', { description: (err as Error).message })
    }
  }
  return (
    <DialogContent className="max-w-110" aria-label="Rename group">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Rename {group.name}</DialogTitle>
          <DialogDescription>
            Its sources stay in it; collapsed state and filters follow the new name.
          </DialogDescription>
        </DialogHeader>
        <NameField id="rename-group-name" value={name} onChange={setName} error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ok || update.isPending}>
            Rename
          </Button>
        </div>
      </form>
    </DialogContent>
  )
}

/**
 * The ⋯ menu on a custom group header (board v0.1-06.12): Rename, Move up,
 * Move down, Delete group. Owners and admins only.
 */
export function CustomGroupMenu({
  group,
  custom,
  members,
  onRename,
}: {
  group: SourceGroup
  custom: CustomGroup[]
  /** Every source in the group (not only the shown ones). */
  members: SourceInfo[]
  onRename: () => void
}) {
  const update = useUpdateGroup()
  const del = useDeleteGroup()
  const create = useCreateGroup()
  const at = custom.findIndex((c) => c.id === group.id)
  const first = at <= 0
  const last = at < 0 || at === custom.length - 1
  const backTo = [...new Set(members.map((s) => autoGroupOf(s)?.name).filter((n): n is string => Boolean(n)))]
  const move = async (to: number) => {
    if (!group.id) return
    try {
      await update.mutateAsync({ id: group.id, order: to })
    } catch (err) {
      toast.error('Could not move the group', { description: (err as Error).message })
    }
  }
  const remove = async () => {
    if (!group.id) return
    const names = members.map((s) => s.name)
    try {
      await del.mutateAsync(group.id)
      toast.success(`Deleted ${group.name}`, {
        description: `${names.length} ${names.length === 1 ? 'source is' : 'sources are'} back to automatic grouping. No lines were deleted.`,
        button: {
          title: 'Undo',
          onClick: async () => {
            try {
              const r = await create.mutateAsync({ name: group.name, sources: names })
              if (at >= 0 && at < r.groups.groups.length - 1) await update.mutateAsync({ id: r.group.id, order: at })
            } catch (err) {
              toast.error('Could not undo', { description: (err as Error).message })
            }
          },
        },
      })
    } catch (err) {
      toast.error('Could not delete the group', { description: (err as Error).message })
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${group.name} actions`} />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        onKeyDown={(e) => {
          if (e.key === 'F2') {
            e.preventDefault()
            onRename()
          }
        }}
      >
        <DropdownMenuHeader className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
          {group.name}
        </DropdownMenuHeader>
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon /> Rename
          <Kbd className="ml-auto">F2</Kbd>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={first} onClick={() => move(at - 1)}>
          <ArrowUpIcon /> Move up
          {first && <span className="font-mono text-[10px] text-muted-foreground">first</span>}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={last} onClick={() => move(at + 1)}>
          <ArrowDownIcon /> Move down
          {last && <span className="font-mono text-[10px] text-muted-foreground">last</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" className="h-auto items-start py-1.5" onClick={remove}>
          <Trash2Icon className="mt-0.5 text-level-error" />
          <span className="flex flex-col gap-0.5">
            <span>Delete group</span>
            <span className="text-[11px] text-muted-foreground leading-snug">
              Sources go back to automatic grouping{backTo.length > 0 ? ` (here: ${backTo.join(', ')})` : ''}. No lines
              are deleted.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The ⋯ menu on a source row (board v0.1-06.11): stream, search, edit, Move
 * to group › (owners and admins, while grouping is on), ignore.
 */
export function SourceMenu({
  s,
  custom,
  canMove,
  onNewGroup,
  onIgnore,
}: {
  s: SourceInfo
  custom: CustomGroup[]
  /** Owners and admins, with grouping on. */
  canMove: boolean
  onNewGroup: () => void
  onIgnore: () => void
}) {
  const navigate = useNavigate()
  const assign = useAssignSources()
  const current = s.group_kind === 'manual' ? s.group_id : undefined
  const auto = autoGroupOf(s)
  const moveTo = async (group: string | null) => {
    if ((group ?? undefined) === current) return
    try {
      await assign.mutateAsync({ sources: [s.name], group })
      const to = group ? custom.find((c) => c.id === group)?.name : auto?.name
      toast.success(group ? `Moved ${label(s)} to ${to}` : `${label(s)} is back to automatic grouping`, {
        description: group ? 'Automatic puts it back.' : to ? `It sits in ${to} again.` : undefined,
      })
    } catch (err) {
      toast.error('Could not move the source', { description: (err as Error).message })
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${s.name} actions`} />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => navigate({ to: '/', search: { source: s.name } })}>
          <RowsIcon /> Stream this source
          <Kbd className="ml-auto">↵</Kbd>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate({ to: '/search', search: { source: s.name, range: '24h' } })}>
          <SearchIcon /> Search · 24h
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link to="/sources/$name" params={{ name: s.name }} search={{ tab: 'settings' }} />}>
          <PencilIcon /> Edit / rename…
        </DropdownMenuItem>
        {canMove && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderIcon /> Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-75" aria-label={`Move ${s.name} to`}>
              <DropdownMenuHeader className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
                Move {s.name} to
              </DropdownMenuHeader>
              {custom.map((c) => (
                <DropdownMenuItem key={c.id} onClick={() => moveTo(c.id)} aria-checked={c.id === current}>
                  {c.id === current ? <CheckIcon className="text-foreground" /> : <span className="size-3.5" />}
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="bg-brand/15 px-1 font-mono text-[10px] text-brand">custom</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={onNewGroup}>
                <PlusIcon /> New group…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="h-auto items-start py-1.5"
                onClick={() => moveTo(null)}
                aria-checked={current == null}
              >
                {current == null ? (
                  <CheckIcon className="mt-0.5 text-foreground" />
                ) : (
                  <RotateCcwIcon className="mt-0.5" />
                )}
                <span className="flex flex-col gap-0.5">
                  <span>Automatic (compose / stack)</span>
                  {auto && (
                    <span className="text-[11px] text-muted-foreground leading-snug">
                      {current ? 'Back to' : 'Now in'} {auto.name}: {autoReason(auto.kind)}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground leading-snug">
                A group you pick wins over automatic grouping. Automatic undoes it.
              </p>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem onClick={onIgnore}>
          <EyeOffIcon /> Ignore source
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
