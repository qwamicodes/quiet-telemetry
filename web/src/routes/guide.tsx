import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  CopyIcon,
  DownloadIcon,
  GaugeIcon,
  HashIcon,
  InfoIcon,
  KeyboardIcon,
  ListIcon,
  PlugIcon,
  RefreshCwIcon,
  RowsIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Caps } from '@/components/settings/kit'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { LintCheck } from '@/gen'
import { useSources } from '@/lib/api'
import {
  copyPrompt,
  DONE_ITEMS,
  downloadPrompt,
  fmtKB,
  PROMPT_FILE,
  promptFor,
  promptSections,
  STACKS,
  type StackId,
  stackById,
  useStack,
} from '@/lib/guide'
import { useLint } from '@/lib/lint-api'
import type { GuideTab } from '@/lib/search-params'
import { cn } from '@/lib/utils'

const TABS: { id: GuideTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'agent', label: 'Instrument with an agent' },
  { id: 'canonical', label: 'The canonical line' },
  { id: 'ids', label: 'Ids & flows' },
  { id: 'check', label: 'Check my logs' },
]

const TITLES: Record<GuideTab, [string, string]> = {
  overview: [
    'How to use quiet',
    'From a running container to a request you can follow end to end, in about ten minutes.',
  ],
  agent: [
    'Instrument your app with an agent',
    'Paste one prompt at the root of a repo. Your agent sets up the canonical line, the ids and the tests; quiet does the rest.',
  ],
  canonical: [
    'The canonical line',
    'One JSON line per unit of work, written when it ends. Every field below is something quiet reads.',
  ],
  ids: ['Ids & flows', 'Lines that share an id join one flow: the request, the job it enqueued, every retry.'],
  check: [
    'Check my logs',
    "A scorecard for one source's newest lines against the canonical line, with the fix for each miss.",
  ],
}

function CopyPromptButton({ stack, primary = true }: { stack: StackId; primary?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      variant={primary ? 'default' : 'outline'}
      aria-label="Copy prompt"
      onClick={async () => {
        if (await copyPrompt(stack)) {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        }
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? 'Copied' : 'Copy prompt'}
      <span className="ml-1 flex gap-0.5" aria-hidden>
        <Kbd>⌘</Kbd>
        <Kbd>⇧</Kbd>
        <Kbd>C</Kbd>
      </span>
    </Button>
  )
}

/** `/guide` (boards v0.1-11.1 … 11.7). */
export function GuidePage() {
  const search = useSearch({ from: '/guide' })
  const tab: GuideTab = search.tab ?? 'overview'
  const [stack, setStack] = useStack()
  const navigate = useNavigate()
  const [title, sub] = TITLES[tab]
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-8 py-8">
        <header className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-xl">{title}</h1>
            <p className="text-muted-foreground text-sm">{sub}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {tab === 'agent' ? (
              <Button type="button" variant="outline" onClick={() => downloadPrompt(stack)}>
                <DownloadIcon /> Download .md
              </Button>
            ) : (
              tab !== 'check' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate({ to: '/guide', search: { ...search, tab: 'check' } })}
                >
                  <GaugeIcon /> Check my logs
                </Button>
              )
            )}
            <CopyPromptButton stack={stack} />
          </div>
        </header>
        <nav aria-label="Guide sections" className="flex gap-1 border-b">
          {TABS.map((t) => (
            <Link
              key={t.id}
              to="/guide"
              search={{ ...search, tab: t.id === 'overview' ? undefined : t.id }}
              aria-current={t.id === tab ? 'page' : undefined}
              className={cn(
                '-mb-px border-transparent border-b-2 px-2.5 py-2 text-muted-foreground text-sm hover:text-foreground',
                t.id === tab && 'border-foreground text-foreground',
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {tab === 'overview' && <Overview stack={stack} />}
        {tab === 'agent' && <AgentTab stack={stack} setStack={setStack} />}
        {tab === 'canonical' && <CanonicalTab />}
        {tab === 'ids' && <IdsTab />}
        {tab === 'check' && <CheckTab source={search.source} />}
      </div>
    </div>
  )
}

// ---- Overview (11.1) ------------------------------------------------------------

function StepCard({
  n,
  title,
  body,
  link,
  children,
}: {
  n: number
  title: string
  body: string
  link: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-4 border bg-card p-4" aria-label={title}>
      <h3 className="flex items-center gap-3 font-medium">
        <span className="flex size-5 items-center justify-center border font-mono text-[11px]">{n}</span>
        {title}
      </h3>
      <div className="min-h-[88px]">{children}</div>
      <p className="flex-1 text-[13px] text-muted-foreground leading-relaxed">{body}</p>
      <div className="text-brand text-sm">{link}</div>
    </section>
  )
}

const linkCls = 'inline-flex items-center gap-1.5 hover:underline'

function Overview({ stack }: { stack: StackId }) {
  return (
    <div className="flex flex-col gap-6">
      <Caps>How quiet works</Caps>
      <div className="grid grid-cols-4 gap-3">
        <StepCard
          n={1}
          title="Connect a source"
          body="Mount docker.sock read-only, or point Vector, Fluent Bit, OTLP or a pipe at quiet. No agent on v0.1."
          link={
            <Link to="/connect" className={linkCls}>
              Connect a source <ArrowRightIcon className="size-3.5" />
            </Link>
          }
        >
          <div className="flex gap-2 font-mono text-xs">
            {['D', 'V', 'F', 'O', 'S'].map((k, i) => (
              <span
                key={k}
                className={cn('flex size-7 items-center justify-center border', i === 0 && 'border-brand text-brand')}
              >
                {k}
              </span>
            ))}
          </div>
          <p className="pt-3 font-mono text-[11px] text-muted-foreground">docker.sock first; 4 more kinds</p>
        </StepCard>
        <StepCard
          n={2}
          title="Watch the stream"
          body="Every JSON line, live, newest at the bottom. Filter by level or any key:value; space pauses."
          link={
            <Link to="/" className={linkCls}>
              Open the stream <ArrowRightIcon className="size-3.5" />
            </Link>
          }
        >
          <div className="flex flex-col border font-mono text-[11px]">
            {[
              ['07:33', 'warn', 'POST /charge', '402'],
              ['07:34', 'info', 'POST /orders', '201'],
              ['07:35', 'error', 'GET /reports', '500'],
            ].map(([t, l, f, s]) => (
              <div key={t} className={cn('flex gap-2 px-2 py-1', l === 'error' && 'bg-destructive/10')}>
                <span className="text-muted-foreground">{t}</span>
                <span
                  className={cn(
                    'w-9',
                    l === 'warn' && 'text-level-warn',
                    l === 'info' && 'text-brand',
                    l === 'error' && 'text-destructive',
                  )}
                >
                  {l}
                </span>
                <span className="flex-1">{f}</span>
                <span className={cn(s === '500' && 'text-destructive')}>{s}</span>
              </div>
            ))}
          </div>
        </StepCard>
        <StepCard
          n={3}
          title="Open a line as a flow"
          body="Lines that share request_id or job_id join one flow: the request, the job it enqueued, every retry."
          link={
            <Link to="/guide" search={{ tab: 'ids' }} className={linkCls}>
              How flows stitch <ArrowRightIcon className="size-3.5" />
            </Link>
          }
        >
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            <span className="flex items-center gap-1.5 border px-2 py-1">
              <StatusDot status="ok" /> POST /payouts
            </span>
            <span className="border-brand border-l pl-2 text-brand">request_id</span>
            <span className="flex gap-1.5">
              <span className="flex items-center gap-1.5 border border-level-warn/60 px-2 py-1">
                <StatusDot status="warn" /> payout:88:1300
              </span>
              <span className="flex items-center gap-1.5 border border-destructive/60 px-2 py-1">
                <StatusDot status="err" /> try 2
              </span>
            </span>
          </div>
        </StepCard>
        <StepCard
          n={4}
          title="Read the field card"
          body="Click any step for its line: typed fields, the error object, JSON and Raw. Filter by any value."
          link={
            <Link to="/guide" search={{ tab: 'canonical' }} className={linkCls}>
              How fields are read <ArrowRightIcon className="size-3.5" />
            </Link>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 font-mono text-[11px]">
            {[
              ['status', '500'],
              ['duration_ms', '3412'],
              ['error.code', 'REPORT_BUILD_FAILED'],
            ].map(([k, v]) => (
              <div key={k} className="col-span-2 grid grid-cols-subgrid border-b py-1">
                <dt className="text-brand">{k}</dt>
                <dd className={cn(k === 'status' || k === 'duration_ms' ? 'text-level-warn' : 'text-destructive')}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </StepCard>
      </div>

      <section
        aria-label="Instruct your agent"
        className="grid grid-cols-[1fr_minmax(0,560px)] gap-6 border border-brand/60 bg-brand/5 p-6"
      >
        <div className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-medium text-base">
            <BotIcon className="size-4 text-brand" /> Instruct your agent
            <span className="bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">recommended</span>
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            quiet is only as good as the lines it reads. Paste one prompt into Claude Code, Cursor or Codex at the root
            of your repo: it sets up one canonical line per request and ids that stitch into flows, and tests for both.
          </p>
          <div className="flex items-center gap-2">
            <CopyPromptButton stack={stack} />
            <Link to="/guide" search={{ tab: 'agent' }}>
              <Button type="button" variant="outline">
                Read the prompt <ArrowRightIcon />
              </Button>
            </Link>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            pino · Elysia · structlog · slog · any JSON logger
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 border bg-background p-4 font-mono text-[11px]">
          <div className="flex flex-col gap-2">
            <Caps>Before</Caps>
            {[
              ['14:07:34.101', '"start create order"'],
              ['14:07:34.118', '"user ok"'],
              ['14:07:34.160', '"charging..."'],
              ['14:07:34.231', '"done" 201'],
            ].map(([t, m]) => (
              <span key={t}>
                <span className="text-muted-foreground">{t}</span> {m}
              </span>
            ))}
            <span className="text-level-warn">4 lines, no ids, no timing</span>
          </div>
          <div className="flex flex-col gap-1 border-l pl-4">
            <Caps>After</Caps>
            <span>{'{ "msg": "create_order",'}</span>
            <span className="pl-3">"request_id": "req_8f2a8c",</span>
            <span className="pl-3 text-level-warn">"status": 201, "duration_ms": 142,</span>
            <span className="pl-3">{'"wideEvents": { "calls": [ … ] } }'}</span>
            <span className="text-status-ok">1 canonical line → a flow with timing</span>
          </div>
        </div>
      </section>

      <Caps>Quick links</Caps>
      <div className="grid grid-cols-3 gap-3">
        <QuickLink
          icon={<BotIcon />}
          title="Instrument with an agent"
          sub="the full prompt + stack notes"
          to={{ to: '/guide', search: { tab: 'agent' } }}
        />
        <QuickLink
          icon={<ListIcon />}
          title="The canonical line"
          sub="every field and what quiet does with it"
          to={{ to: '/guide', search: { tab: 'canonical' } }}
        />
        <QuickLink
          icon={<HashIcon />}
          title="Ids & flows"
          sub="request → job → retries, x-request-id"
          to={{ to: '/guide', search: { tab: 'ids' } }}
        />
        <QuickLink
          icon={<GaugeIcon />}
          title="Check my logs"
          sub="scorecard for one source, with fixes"
          to={{ to: '/guide', search: { tab: 'check' } }}
        />
        <QuickLink
          icon={<PlugIcon />}
          title="Connect a source"
          sub="Docker, Vector, Fluent Bit, OTLP, stdin"
          to={{ to: '/connect' }}
        />
        <QuickLink
          icon={<KeyboardIcon />}
          title="Keyboard shortcuts"
          sub="press ? anywhere"
          onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))}
        />
      </div>
    </div>
  )
}

function QuickLink({
  icon,
  title,
  sub,
  to,
  onClick,
}: {
  icon: ReactNode
  title: string
  sub: string
  to?: { to: '/guide'; search: { tab: GuideTab } } | { to: '/connect' }
  onClick?: () => void
}) {
  const inner = (
    <>
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="flex flex-1 flex-col text-left">
        <span className="text-sm">{title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>
      </span>
      <ChevronRightIcon className="size-4 text-muted-foreground" />
    </>
  )
  const cls = 'flex h-14 items-center gap-4 border bg-card px-4 hover:bg-accent'
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick}>
        {inner}
      </button>
    )
  return (
    // biome-ignore lint/suspicious/noExplicitAny: the two link shapes are both valid routes
    <Link {...(to as any)} className={cls}>
      {inner}
    </Link>
  )
}

// ---- Instrument with an agent (11.2) --------------------------------------------

function AgentTab({ stack, setStack }: { stack: StackId; setStack: (s: StackId) => void }) {
  const text = promptFor(stack)
  const lines = text.split('\n')
  const sections = promptSections(text)
  const s = stackById(stack)
  const notesAt = sections.find((x) => x.title.startsWith('Stack notes'))?.line ?? 0
  const doneAt = sections.find((x) => x.title === 'Done when')?.line ?? 0
  const [done, setDone] = useState<boolean[]>(() => DONE_ITEMS.map(() => false))
  const steps = ['Pick your stack', 'Copy the prompt', 'Paste it into your agent', 'Verify in quiet']
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex items-center gap-3 text-sm" aria-label="Steps">
        {steps.map((t, i) => (
          <li key={t} className="flex flex-1 items-center gap-3 last:flex-none">
            <span
              className={cn(
                'flex size-5 items-center justify-center border font-mono text-[11px]',
                i === 1 && 'border-brand text-brand',
              )}
            >
              {i + 1}
            </span>
            <span className={cn(i === 1 ? 'text-foreground' : 'text-muted-foreground')}>{t}</span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4">
        <section className="flex min-w-0 flex-col border bg-card" aria-label="Prompt">
          <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
            <div className="flex flex-col">
              <span className="font-medium text-sm">Prompt · canonical logs with wide events</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {PROMPT_FILE} · {lines.length} lines · {fmtKB(text)} · includes {s.label} notes
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Download prompt"
                onClick={() => downloadPrompt(stack)}
              >
                <DownloadIcon />
              </Button>
              <Button type="button" size="sm" onClick={() => void copyPrompt(stack)}>
                <CopyIcon /> Copy
              </Button>
            </div>
          </div>
          <p className="flex items-center gap-1.5 border-b px-4 py-2 text-[11px] text-muted-foreground">
            <InfoIcon className="size-3" aria-hidden /> Copied as Markdown. Works in Claude Code, Cursor, Codex or any
            agent that can read the repo.
          </p>
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed"
            data-testid="prompt-text"
          >
            {lines.map((l, i) => {
              const n = i + 1
              const inNotes = notesAt > 0 && n >= notesAt && n < doneAt
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                  key={i}
                  id={`prompt-l${n}`}
                  className={cn(
                    'block min-h-[1.2em]',
                    l.startsWith('## ') && 'pt-2 text-brand',
                    inNotes && '-mx-4 border-brand border-l-2 bg-brand/5 px-[14px]',
                  )}
                >
                  {l}
                </span>
              )
            })}
          </pre>
        </section>
        <aside className="flex flex-col gap-4">
          <section className="border bg-card" aria-label="Your stack">
            <div className="flex items-center justify-between border-b px-3 py-2.5">
              <span className="font-medium text-sm">Your stack</span>
              <span className="font-mono text-[10px] text-muted-foreground">changes the stack notes</span>
            </div>
            <fieldset className="flex flex-col gap-1.5 p-2" aria-label="Stack">
              {STACKS.map((x) => (
                <label
                  key={x.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 border px-3 py-2 text-left hover:bg-accent has-focus-visible:ring-1 has-focus-visible:ring-ring',
                    x.id === stack && 'border-brand bg-brand/5',
                  )}
                >
                  <input
                    type="radio"
                    name="guide-stack"
                    className="sr-only"
                    value={x.id}
                    checked={x.id === stack}
                    onChange={() => setStack(x.id)}
                    aria-label={x.label}
                  />
                  <span className="flex size-6 items-center justify-center border font-mono text-[11px]">
                    {x.letter}
                  </span>
                  <span className="flex flex-1 flex-col">
                    <span className="text-sm">{x.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{x.sub}</span>
                  </span>
                  <span
                    className={cn(
                      'size-3.5 rounded-full border',
                      x.id === stack && 'border-brand bg-brand shadow-[inset_0_0_0_3px_var(--card)]',
                    )}
                  />
                </label>
              ))}
            </fieldset>
            <p className="px-3 pb-3 text-[11px] text-muted-foreground leading-relaxed">{s.adds}</p>
          </section>

          <section className="border bg-card" aria-label="Done looks like">
            <div className="flex items-center justify-between border-b px-3 py-2.5">
              <span className="font-medium text-sm">Done looks like</span>
              <span className="font-mono text-[10px] text-muted-foreground">from the prompt</span>
            </div>
            <ul className="flex flex-col">
              {DONE_ITEMS.map((d, i) => (
                <li key={d.title} className="border-b last:border-b-0">
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--brand)]"
                      checked={done[i]}
                      onChange={(e) => setDone(done.map((v, j) => (j === i ? e.target.checked : v)))}
                    />
                    <span className="flex flex-col">
                      <span className={cn('text-[13px]', done[i] && 'text-muted-foreground line-through')}>
                        {d.title}
                      </span>
                      {d.sub && <span className="font-mono text-[10px] text-muted-foreground">{d.sub}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="border bg-card" aria-label="Verify in quiet">
            <div className="flex items-center justify-between border-b px-3 py-2.5">
              <span className="font-medium text-sm">Verify in quiet</span>
              <span className="font-mono text-[10px] text-muted-foreground">2 min</span>
            </div>
            <ol className="flex flex-col gap-3 p-3 text-[13px]">
              <li className="flex flex-col gap-1.5">
                <span>1 · Send one request</span>
                <code className="border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                  $ curl -i -X POST $API/api/v1/orders
                  <br />
                  HTTP/1.1 201 Created
                  <br />
                  x-request-id: req_8f2a8c
                </code>
                <span className="text-[11px] text-muted-foreground">the response carries x-request-id</span>
              </li>
              <li className="flex flex-col gap-1">
                <span>2 · See exactly one canonical line</span>
                <span className="text-[11px] text-muted-foreground">one line per request, not four</span>
              </li>
              <li className="flex flex-col gap-1">
                <span>3 · Open it as a flow (↵)</span>
                <span className="text-[11px] text-muted-foreground">the job it enqueued joins by request_id</span>
              </li>
            </ol>
            <div className="flex gap-2 px-3 pb-3">
              <Link to="/">
                <Button type="button" size="sm" variant="outline">
                  <RowsIcon /> Open stream
                </Button>
              </Link>
              <Link to="/guide" search={{ tab: 'check' }}>
                <Button type="button" size="sm" variant="outline">
                  <GaugeIcon /> Check my logs
                </Button>
              </Link>
            </div>
          </section>

          <section className="border bg-card" aria-label="In this prompt">
            <div className="flex items-center justify-between border-b px-3 py-2.5">
              <span className="font-medium text-sm">In this prompt</span>
              <span className="font-mono text-[10px] text-muted-foreground">jump to a section</span>
            </div>
            <ul>
              {sections.map((x) => (
                <li key={x.line} className="border-b last:border-b-0">
                  <a
                    href={`#prompt-l${x.line}`}
                    className={cn(
                      'flex items-center gap-3 px-3 py-1.5 text-[13px] hover:bg-accent',
                      x.title.startsWith('Stack notes') && 'text-brand',
                    )}
                  >
                    <span className="w-6 text-right font-mono text-[10px] text-muted-foreground">{x.line}</span>
                    <span className="flex-1">{x.title}</span>
                    <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

// ---- The canonical line ------------------------------------------------------------

const FIELDS: [string, string, string][] = [
  ['time / timestamp', 'when the work ended; exactly one of them', 'orders the stream and every flow'],
  ['level', 'debug · info · warn · error (pino numbers fine)', 'level chips, row colour, errors-only'],
  ['service · env · version', 'set once in the logger base', 'labels the line; search service:api'],
  ['msg', 'short snake_case event name', 'the SUMMARY column and a flow step name'],
  ['request_id · job_id', 'ids that join lines', 'stitches the flow; ⌘K jumps by id'],
  ['method · path · route', 'what was asked', 'the FLOW column (method muted + path)'],
  [
    'status · duration_ms · outcome',
    'how it ended, at the top level',
    'summary colour, slow / failed, the waterfall bar',
  ],
  ['error { name, code, message, details, stack }', 'an object, never a string', 'red step, Filter by error.code'],
  [
    'wideEvents.calls[]',
    '{ provider, action, at_ms, duration_ms?, ok?, status? }',
    'child steps with their own time bars',
  ],
  ['wideEvents.*', 'everything else about this unit of work', 'typed fields on the field card'],
]

function CanonicalTab() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-6">
      <section className="border bg-card" aria-label="Fields">
        <div className="grid grid-cols-[1.2fr_1.2fr_1fr] gap-4 border-b px-4 py-2">
          <Caps>Field</Caps>
          <Caps>What it holds</Caps>
          <Caps>What quiet does with it</Caps>
        </div>
        {FIELDS.map(([f, what, does]) => (
          <div
            key={f}
            className="grid grid-cols-[1.2fr_1.2fr_1fr] gap-4 border-b px-4 py-2.5 text-[13px] last:border-b-0"
          >
            <span className="font-mono text-brand text-xs">{f}</span>
            <span className="text-muted-foreground">{what}</span>
            <span>{does}</span>
          </div>
        ))}
      </section>
      <div className="flex flex-col gap-4">
        <section className="border bg-card p-4" aria-label="Example canonical line">
          <Caps>One line per unit of work</Caps>
          <pre className="whitespace-pre-wrap pt-3 font-mono text-[11px] leading-relaxed">{`{ "time": 1761148051123, "level": "error",
  "service": "legivent-api", "msg": "build_report",
  "request_id": "req_8f2a7d",
  "method": "GET", "route": "/api/v1/reports/:id",
  "status": 500, "duration_ms": 3412, "outcome": "failed",
  "error": { "code": "REPORT_BUILD_FAILED",
             "message": "renderer timed out" },
  "wideEvents": { "calls": [
    { "provider": "postgres", "action": "load_report",
      "at_ms": 12, "duration_ms": 40, "ok": true },
    { "provider": "renderer", "action": "render_pdf",
      "at_ms": 60, "duration_ms": 3300, "ok": false } ] } }`}</pre>
        </section>
        <section className="border border-dashed p-4 text-muted-foreground text-xs leading-relaxed">
          Write it once, when the work ends (a middleware with a finally block), so a thrown error still logs it. Keep
          incidental lines to a minimum: four lines with no ids and no timing become one line quiet can draw as a flow.
          Don't log a provider payload and flattened copies of it; no emails, phones, names, tokens or card data.
        </section>
      </div>
    </div>
  )
}

// ---- Ids & flows ---------------------------------------------------------------------

function IdsTab() {
  return (
    <div className="grid grid-cols-2 gap-6">
      <section className="flex flex-col gap-3 border bg-card p-4" aria-label="Request to job">
        <h3 className="font-medium">request → job → retries</h3>
        <ol className="flex flex-col gap-2 font-mono text-[11px]">
          <li className="border px-2 py-1.5">
            <StatusDot status="ok" /> POST /api/v1/payouts · request_id req_8f2a5b · 201
          </li>
          <li className="ml-4 border-brand border-l pl-3 text-brand">enqueues with data.request_id = req_8f2a5b</li>
          <li className="ml-4 border border-level-warn/60 px-2 py-1.5">
            payout_job · job_id payout:88:1300 · request_id req_8f2a5b · attempt_failed · retry 1
          </li>
          <li className="ml-4 border border-destructive/60 px-2 py-1.5">
            payout_job · job_id payout:88:1300 · moved_to_failed
          </li>
        </ol>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Every job line carries its own job_id and the parent request_id, so opening any of them shows the request, the
          job and every retry in one flow. Make job_id globally unique (&lt;queue&gt;:&lt;entity&gt;:&lt;n&gt;), never a
          bare number shared by several queues.
        </p>
      </section>
      <section className="flex flex-col gap-3 border bg-card p-4" aria-label="x-request-id">
        <h3 className="font-medium">x-request-id across services</h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Generate request_id at the edge, or accept an incoming x-request-id, keep it in request context, put it on
          every line and return it as the x-request-id response header. Forward it on outgoing calls to your own
          services; the receiving service reuses it, so both services' lines land in one flow.
        </p>
        <h3 className="pt-2 font-medium">Which id wins</h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          quiet looks for request_id, job_id, trace_id and correlation_id (and their common spellings) and shows the
          first one in the order. Lines are joined by any id they share. Your app uses another field, like
          x-amzn-trace-id or ctx.trace? Add it as a custom id field.
        </p>
        <div className="flex gap-2">
          <Link to="/settings/flow-id-order">
            <Button type="button" size="sm" variant="outline">
              <HashIcon /> Flow id order
            </Button>
          </Link>
          <Link to="/guide" search={{ tab: 'check' }}>
            <Button type="button" size="sm" variant="outline">
              <GaugeIcon /> Check id coverage
            </Button>
          </Link>
        </div>
      </section>
    </div>
  )
}

// ---- Check my logs -------------------------------------------------------------------

const STATUS_ICON = {
  pass: <CircleCheckIcon className="size-4 text-status-ok" aria-label="pass" />,
  warn: <CircleAlertIcon className="size-4 text-level-warn" aria-label="warn" />,
  fail: <CircleXIcon className="size-4 text-destructive" aria-label="fail" />,
  na: <CircleDashedIcon className="size-4 text-muted-foreground" aria-label="not applicable" />,
} as const

function CheckRow({ c }: { c: LintCheck }) {
  return (
    <li className="grid grid-cols-[20px_1fr_auto] items-start gap-3 border-b px-4 py-3 last:border-b-0">
      <span className="pt-0.5">{STATUS_ICON[c.status]}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm">{c.title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{c.detail}</span>
        {c.fix && <span className="pt-1 text-xs">{c.fix}</span>}
      </span>
      <span className="font-mono text-muted-foreground text-xs">
        {c.share == null ? 'n/a' : `${Math.round(c.share * 100)}%`}
      </span>
    </li>
  )
}

function CheckTab({ source }: { source?: string }) {
  const sources = useSources().data
  const navigate = useNavigate()
  const visible = (sources ?? []).filter((s) => !s.hidden)
  const current = source ?? visible[0]?.name ?? null
  const lint = useLint(current)
  const [stack] = useStack()
  useEffect(() => {
    if (!source && current) navigate({ to: '/guide', search: { tab: 'check', source: current }, replace: true })
  }, [source, current, navigate])

  if (sources && visible.length === 0)
    return (
      <div className="flex flex-col items-start gap-3 border border-dashed p-6">
        <span className="font-medium">No sources yet</span>
        <span className="text-muted-foreground text-sm">
          Connect a source, send a few requests, then check its lines.
        </span>
        <Link to="/connect">
          <Button type="button">
            <PlugIcon /> Connect a source
          </Button>
        </Link>
      </div>
    )

  const r = lint.data
  const failing = r?.checks.filter((c) => c.status === 'fail' || c.status === 'warn') ?? []
  return (
    <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-6">
      <nav aria-label="Source to check" className="flex flex-col gap-1">
        <Caps className="pb-1">Source</Caps>
        {visible.map((s) => (
          <Link
            key={s.name}
            to="/guide"
            search={{ tab: 'check', source: s.name }}
            aria-current={s.name === current ? 'true' : undefined}
            className={cn(
              'flex h-8 items-center gap-2 px-2 text-sm hover:bg-accent',
              s.name === current && 'bg-accent text-foreground',
            )}
          >
            <span className="flex-1 truncate">{s.display_name ?? s.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{s.kind}</span>
          </Link>
        ))}
      </nav>
      <section aria-label="Scorecard" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 border bg-card px-4 py-3">
          <div className="flex flex-col">
            <span className="font-medium">
              {r ? (
                <>
                  {r.passed} / {r.applicable} checks pass
                </>
              ) : lint.isError ? (
                'Could not check this source'
              ) : (
                'Checking…'
              )}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {r
                ? r.sampled === 0
                  ? `${current} has no lines in the window yet`
                  : `newest ${r.sampled.toLocaleString()} lines of ${current}`
                : current}
            </span>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => lint.refetch()} aria-label="Check again">
              <RefreshCwIcon /> Check again
            </Button>
            {current && (
              <Link to="/" search={{ source: current }}>
                <Button type="button" size="sm" variant="outline">
                  <RowsIcon /> Open stream
                </Button>
              </Link>
            )}
          </div>
        </div>
        {r && (
          <ul className="border bg-card" aria-label="Checks">
            {r.checks.map((c) => (
              <CheckRow key={c.id} c={c} />
            ))}
          </ul>
        )}
        {failing.length > 0 && (
          <div className="flex items-center justify-between gap-4 border border-brand/60 bg-brand/5 px-4 py-3">
            <span className="text-sm">
              {failing.length} {failing.length === 1 ? 'check needs' : 'checks need'} work. The agent prompt fixes all
              of them in one pass.
            </span>
            <CopyPromptButton stack={stack} primary={false} />
          </div>
        )}
      </section>
    </div>
  )
}
