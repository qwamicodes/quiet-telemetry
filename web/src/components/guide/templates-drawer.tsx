import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ChevronLeftIcon, SearchIcon, XIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  appliesToOf,
  fmtTarget,
  type Goal,
  goalFromTemplate,
  newId,
  PACKS,
  PERIODS,
  type ProductPack,
  type Setup,
  type TemplateGoal,
  timingOf,
} from '@/lib/guide'
import { cn } from '@/lib/utils'
import { inputCls, NativeSelect } from './kit'

const PAGE = 3
const shortTarget = (t: TemplateGoal) => fmtTarget(t)

/** "99.9% within 30 seconds of confirmed payment" */
const goalSummary = (t: TemplateGoal) => {
  const to = timingOf(t).split(' to ')[0]
  return `${fmtTarget(t, true)}${to && !/request start/.test(to) ? ` of ${to.replace(/^authoritative /, '')}` : ` · ${appliesToOf(t).charAt(0).toLowerCase()}${appliesToOf(t).slice(1)}`}`
}

type Draft = { on: boolean; target: number; limit: number; appliesTo: string }

/** Browse product templates (v0.1.1-11.3, 11.7 … 11.9): a right-hand drawer over the setup. */
export function TemplatesDrawer({
  open,
  onOpenChange,
  setup,
  projects,
  onAdd,
  onCreateOwn,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  setup: Setup
  projects: string[]
  onAdd: (patch: Partial<Setup>) => void
  onCreateOwn: () => void
}) {
  const [project, setProject] = useState(
    setup.project || (projects.includes(setup.app.split('/')[0]?.trim()) ? setup.app.split('/')[0].trim() : ''),
  )
  const [type, setType] = useState(setup.productType)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'all' | 'recommended'>('all')
  const [page, setPage] = useState(0)
  const [pack, setPack] = useState<ProductPack | null>(null)
  const [period, setPeriod] = useState(30)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [expanded, setExpanded] = useState(0)

  const recommended = PACKS.filter((p) => p.name === type)
  const matches = (p: ProductPack) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())
  const all = [...PACKS.filter((p) => p.name === type), ...PACKS.filter((p) => p.name !== type)].filter(matches)
  const recShown = recommended.filter(matches)
  const list = tab === 'all' ? all : recShown
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const shown = list.slice(page * PAGE, page * PAGE + PAGE)

  const openPack = (p: ProductPack) => {
    setPack(p)
    setDrafts(p.goals.map((g) => ({ on: true, target: g.target, limit: g.limit, appliesTo: appliesToOf(g) })))
    setExpanded(0)
  }
  const close = () => {
    onOpenChange(false)
    setPack(null)
  }
  const selected = drafts.filter((d) => d.on).length
  const existing = setup.goals.length
  const add = () => {
    if (!pack || !project) return
    const batch = newId()
    const have = new Set(setup.goals.map((g) => g.key))
    const goals: Goal[] = pack.goals.flatMap((t, i) => {
      const d = drafts[i]
      if (!d?.on || have.has(t.key)) return []
      return [{ ...goalFromTemplate(t, pack, period, batch), target: d.target, limit: d.limit, appliesTo: d.appliesTo }]
    })
    onAdd({
      project,
      productType: type,
      goals: [...setup.goals.map((g) => ({ ...g, batch: undefined })), ...goals],
      lastAdd: { batch, pack: pack.name, count: goals.length, existing },
    })
    close()
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/55" />
        <DialogPrimitive.Popup
          style={{ width: 'min(600px, 100vw)' }}
          className="fixed inset-y-0 right-0 z-50 flex flex-col border-l bg-card text-sm outline-none"
        >
          <header className="flex items-start justify-between gap-4 border-b px-6 pt-6 pb-5">
            <div className="flex flex-col gap-1.5">
              <DialogPrimitive.Title className="font-semibold text-xl tracking-tight">
                {pack ? pack.name : 'Browse product templates'}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-muted-foreground text-[13px]">
                {pack
                  ? 'Choose the goals that fit your product, then adjust the targets.'
                  : 'Choose your product. Start with goals for the journeys your customers use.'}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              render={<Button variant="outline" size="icon-sm" aria-label="Close" />}
              className="shrink-0"
            >
              <XIcon />
            </DialogPrimitive.Close>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
            {pack && (
              <button
                type="button"
                onClick={() => setPack(null)}
                className="flex items-center gap-1 self-start text-brand text-[13px] hover:underline"
              >
                <ChevronLeftIcon className="size-3.5" /> Back to product templates
              </button>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="Project">
                <NativeSelect
                  label="Project"
                  value={project}
                  placeholder="Choose a project"
                  onChange={setProject}
                  options={projects.map((p) => ({ value: p, label: p }))}
                />
              </Labeled>
              {pack ? (
                <Labeled label="Measure over">
                  <NativeSelect
                    label="Measure over"
                    value={String(period)}
                    onChange={(v) => setPeriod(Number(v))}
                    options={PERIODS.map((d) => ({ value: String(d), label: `Last ${d} days` }))}
                  />
                </Labeled>
              ) : (
                <Labeled label="Product type">
                  <NativeSelect
                    label="Product type"
                    value={type}
                    placeholder="Choose a product type"
                    onChange={(v) => {
                      setType(v)
                      setPage(0)
                    }}
                    options={PACKS.map((p) => ({ value: p.name, label: p.name }))}
                  />
                </Labeled>
              )}
            </div>

            {!pack && (
              <>
                <span className={cn(inputCls, 'flex items-center gap-2')}>
                  <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <input
                    aria-label="Search products"
                    className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                    placeholder="Search products…"
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value)
                      setPage(0)
                    }}
                  />
                  {q && (
                    <button type="button" className="text-brand text-xs" onClick={() => setQ('')}>
                      Clear
                    </button>
                  )}
                </span>
                <div role="tablist" aria-label="Templates" className="flex border-b">
                  {(
                    [
                      ['all', 'All templates', all.length],
                      ['recommended', 'Recommended', recShown.length],
                    ] as const
                  ).map(([id, l, n]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => {
                        setTab(id)
                        setPage(0)
                      }}
                      className={cn(
                        '-mb-px border-transparent border-b-2 px-2.5 py-2 text-[13px] text-muted-foreground',
                        tab === id && 'border-foreground text-foreground',
                      )}
                    >
                      {l} <span className="text-muted-foreground">{n}</span>
                    </button>
                  ))}
                </div>
                {list.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 border bg-background px-6 py-12 text-center">
                    <span className="text-[13px]">
                      {q.trim() ? `No product templates match “${q.trim()}”` : 'No recommended template yet'}
                    </span>
                    <span className="text-muted-foreground text-[13px]">
                      {q.trim()
                        ? 'Try another product name or clear your search.'
                        : 'Choose a product type to get a recommendation.'}
                    </span>
                    {q.trim() && (
                      <Button type="button" size="sm" variant="outline" onClick={() => setQ('')}>
                        Clear search
                      </Button>
                    )}
                  </div>
                ) : (
                  <ul className="flex flex-col gap-3" aria-label="Product templates">
                    {shown.map((p) => (
                      <li key={p.id} className="flex items-start justify-between gap-4 border bg-background p-3.5">
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <span className="text-[13px]">
                            {p.name}
                            {p.name === type && <span className="ml-2 text-brand text-[11px]">Recommended</span>}
                          </span>
                          {p.goals.map((g) => (
                            <span key={g.key} className="text-muted-foreground text-xs">
                              {g.name} · {shortTarget(g)}
                            </span>
                          ))}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openPack(p)}
                          aria-label={`View goals: ${p.name}`}
                        >
                          View goals
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {list.length > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground text-[13px]">
                      {page * PAGE + 1}–{Math.min(list.length, page * PAGE + PAGE)} of {list.length} products
                    </span>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={page === 0}
                        onClick={() => setPage(page - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={page >= pages - 1}
                        onClick={() => setPage(page + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  {list.length === 0 && q.trim()
                    ? `Clear your search to see all ${PACKS.length} templates.${type ? ` ${type} stays recommended.` : ''}`
                    : 'Suggested starting targets · measured over the last 30 days. Select and edit goals before adding.'}
                </p>
              </>
            )}

            {pack && (
              <>
                <ul className="flex flex-col gap-3" aria-label={`${pack.name} goals`}>
                  {pack.goals.map((t, i) => {
                    const d = drafts[i]
                    if (!d) return null
                    const setD = (patch: Partial<Draft>) =>
                      setDrafts(drafts.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                    const dup = setup.goals.some((g) => g.key === t.key)
                    return (
                      <li key={t.key} className="flex flex-col gap-3 border bg-background p-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <label className="flex items-start gap-2.5">
                            <input
                              type="checkbox"
                              className="mt-0.5 size-3.5 accent-[var(--brand)]"
                              checked={d.on}
                              disabled={dup}
                              onChange={(e) => setD({ on: e.target.checked })}
                            />
                            <span className="flex flex-col gap-1">
                              <span className="text-[13px]">{t.name}</span>
                              {expanded !== i && (
                                <span className="text-muted-foreground text-xs">
                                  {dup
                                    ? 'Already in your goals · edit it in your setup'
                                    : goalSummary({ ...t, target: d.target, limit: d.limit })}
                                </span>
                              )}
                            </span>
                          </label>
                          {expanded !== i && !dup && (
                            <Button type="button" size="sm" variant="outline" onClick={() => setExpanded(i)}>
                              Edit
                            </Button>
                          )}
                        </div>
                        {expanded === i && (
                          <>
                            <p className="text-muted-foreground text-xs">{t.good}.</p>
                            <div className="grid grid-cols-2 gap-3">
                              <Labeled label="Meet this goal for">
                                <span className={cn(inputCls, 'flex items-center gap-1')}>
                                  <input
                                    aria-label={`${t.name} target percent`}
                                    type="number"
                                    step={0.1}
                                    className="w-12 bg-transparent outline-none"
                                    value={d.target}
                                    onChange={(e) =>
                                      setD({ target: Math.min(100, Math.max(1, Number(e.target.value) || t.target)) })
                                    }
                                  />
                                  <span className="text-muted-foreground">% of requests</span>
                                </span>
                              </Labeled>
                              <Labeled label="Finish in">
                                <NativeSelect
                                  label={`${t.name} time limit`}
                                  value={String(d.limit)}
                                  onChange={(v) => setD({ limit: Number(v) })}
                                  options={[
                                    ...new Set(
                                      [t.limit / 2, t.limit, t.limit * 2, t.limit * 3].filter(
                                        (n) => Number.isInteger(n) && n > 0,
                                      ),
                                    ),
                                  ]
                                    .sort((a, b) => a - b)
                                    .map((n) => ({
                                      value: String(n),
                                      label: cap(fmtTarget({ ...t, limit: n }, true).replace(/^[\d.]+% /, '')),
                                    }))}
                                />
                              </Labeled>
                            </div>
                            <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3">
                              <span className="text-muted-foreground text-xs">Applies to</span>
                              <input
                                aria-label={`${t.name} applies to`}
                                className={inputCls}
                                value={d.appliesTo}
                                onChange={(e) => setD({ appliesTo: e.target.value })}
                              />
                            </div>
                            <p className="text-muted-foreground text-xs leading-relaxed">
                              Measured {timingOf(t) ? `from ${timingOf(t)}` : 'per eligible unit'}.
                            </p>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  Suggested starting targets. Uncheck any goal you don't need.
                  {existing > 0 &&
                    ` Your ${existing} existing ${existing === 1 ? 'goal stays' : 'goals stay'} unchanged.`}
                </p>
              </>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t px-6 py-4">
            <Button type="button" size="sm" variant="outline" onClick={close}>
              Cancel
            </Button>
            {pack ? (
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground text-[13px]">
                  {project ? `${selected} selected` : 'Choose a project first'}
                </span>
                <Button type="button" size="sm" disabled={!project || selected === 0} onClick={add}>
                  Add {selected} {selected === 1 ? 'goal' : 'goals'}
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground text-[13px]">Need a different goal?</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    close()
                    onCreateOwn()
                  }}
                >
                  Create your own
                </Button>
              </span>
            )}
          </footer>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-muted-foreground text-[13px]">{label}</span>
      {children}
    </div>
  )
}
