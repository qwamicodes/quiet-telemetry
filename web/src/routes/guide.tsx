import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  GaugeIcon,
  HashIcon,
  KeyboardIcon,
  ListIcon,
  PlugIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { EventExamples } from '@/components/guide/event-examples'
import { GuideTabs } from '@/components/guide/guide-tabs'
import { IdsFlows } from '@/components/guide/ids-flows'
import { type AgentStep, CopyPromptButton, PromptKeys, Stepper } from '@/components/guide/kit'
import { LanguageExamples } from '@/components/guide/language-examples'
import { PromptReview, reviewSub } from '@/components/guide/prompt-review'
import { AddedBanner, PromptSetup } from '@/components/guide/prompt-setup'
import { TemplatesDrawer } from '@/components/guide/templates-drawer'
import { VerifyActions, VerifyLogs } from '@/components/guide/verify-logs'
import { Caps } from '@/components/settings/kit'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { WhatsNewBanner } from '@/components/whats-new/whats-new-banner'
import { useSources } from '@/lib/api'
import { blankGoal, downloadPrompt, PROMPT_COPIED, type StackId, useSetup, useStack } from '@/lib/guide'
import type { GuideTab } from '@/lib/search-params'
import { cn } from '@/lib/utils'
import { type Target, useSeenOnVisit } from '@/lib/whats-new'

const TITLES: Record<Exclude<GuideTab, 'agent'>, [string, string]> = {
  overview: [
    'How to use quiet',
    'From a running container to a request you can follow end to end, in about ten minutes.',
  ],
  canonical: [
    'Event examples',
    'One completion event per request, job attempt or cron run. Measure every eligible unit; tail sampling chooses what is emitted.',
  ],
  ids: [
    'Ids & flows',
    'quiet joins lines that share an id. Get the ids right and a request, the job it enqueued and every retry open as one flow.',
  ],
  check: [
    'Verify your logs',
    'Review a received sample, then verify emission, delivery and SLO measurement in your codebase.',
  ],
}

const AGENT_TITLES: Record<Exclude<AgentStep, 'verify'>, [string, string]> = {
  setup: [
    'Set up your logging prompt',
    "Choose what to log and what good service looks like. We'll turn your choices into a ready-to-use prompt.",
  ],
  review: ['Review your logging prompt', ''],
  examples: [
    'Use the language examples',
    'Start with the matching reference package, then adapt it to your framework and queue.',
  ],
}

const STEP_KEY = 'quiet.guide.step'
const readStep = (): Exclude<AgentStep, 'verify'> => {
  const v = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STEP_KEY) : null
  return v === 'review' || v === 'examples' ? v : 'setup'
}

/** `/guide` (boards v0.1.0-11.x, v0.1.1-11.1 … 11.9). */
export function GuidePage() {
  const search = useSearch({ from: '/guide' })
  const tab: GuideTab = search.tab ?? 'overview'
  useSeenOnVisit(tab === 'overview' ? null : (`guide.${tab}` as Target))
  const [stack, setStack] = useStack()
  const [setup, update] = useSetup()
  // The step lives in the URL (`?tab=agent&step=review`); this browser
  // session's last step is the fallback when the URL has none.
  const step = search.step ?? readStep()
  const [copied, setCopied] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const sources = useSources().data
  const navigate = useNavigate()

  const toCheck = () => navigate({ to: '/guide', search: { tab: 'check' } })
  const setStep = (s: AgentStep) => {
    if (s === 'verify') return toCheck()
    setCopied(false)
    sessionStorage.setItem(STEP_KEY, s)
    navigate({ to: '/guide', search: { tab: 'agent', step: s } })
    document.querySelector('[data-guide-scroll]')?.scrollTo?.({ top: 0 })
  }
  // After a copy the stepper moves on to "Apply in your repo" (v0.1.0-11.5).
  useEffect(() => {
    const on = () => setCopied(true)
    window.addEventListener(PROMPT_COPIED, on)
    return () => window.removeEventListener(PROMPT_COPIED, on)
  }, [])

  const reviewBtn = (
    <Button type="button" onClick={() => setStep('review')}>
      <CopyIcon /> Review prompt <PromptKeys />
    </Button>
  )
  let title: string
  let sub: string
  let actions: ReactNode
  if (tab === 'agent') {
    ;[title, sub] = AGENT_TITLES[step]
    if (step === 'review') sub = reviewSub(setup)
    actions =
      step === 'setup' ? (
        <>
          <Button type="button" variant="outline" onClick={() => setDrawer(true)}>
            <DownloadIcon /> Browse templates
          </Button>
          {reviewBtn}
        </>
      ) : step === 'review' ? (
        <>
          <Button type="button" variant="outline" onClick={() => downloadPrompt(stack)}>
            <DownloadIcon /> Download .md
          </Button>
          <CopyPromptButton stack={stack} onVerify={toCheck} />
        </>
      ) : (
        <>
          <Button type="button" variant="outline" onClick={() => setStep('setup')}>
            <ArrowLeftIcon /> Back to setup
          </Button>
          {reviewBtn}
        </>
      )
  } else {
    ;[title, sub] = TITLES[tab]
    actions =
      tab === 'check' ? (
        <VerifyActions source={search.source} />
      ) : (
        <>
          {tab !== 'ids' && (
            <Button type="button" variant="outline" onClick={toCheck}>
              <GaugeIcon /> Check my logs
            </Button>
          )}
          <CopyPromptButton stack={stack} onVerify={toCheck} />
        </>
      )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-guide-scroll>
      <div className="mx-auto flex max-w-[1192px] flex-col px-8 pt-7 pb-10">
        <header className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
            <p className="text-muted-foreground text-sm">{sub}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </header>
        <div className="mt-3 mb-5">
          <GuideTabs active={tab} search={search} />
        </div>
        {tab === 'overview' && <WhatsNewBanner className="mb-5" />}
        {tab === 'overview' && <Overview stack={stack} />}
        {tab === 'agent' && (
          <div className="flex flex-col gap-5">
            {step === 'setup' && <AddedBanner setup={setup} update={update} />}
            <Stepper current={copied && step === 'review' ? 'examples' : step} onStep={setStep} />
            {step === 'setup' && (
              <PromptSetup
                setup={setup}
                update={update}
                stack={stack}
                setStack={setStack}
                editing={editing}
                setEditing={setEditing}
                onReview={() => setStep('review')}
                onTemplates={() => setDrawer(true)}
              />
            )}
            {step === 'review' && (
              <PromptReview setup={setup} stack={stack} onEditGoals={() => setStep('setup')} onVerify={toCheck} />
            )}
            {step === 'examples' && <LanguageExamples stack={stack} setStack={setStack} />}
          </div>
        )}
        {tab === 'canonical' && <EventExamples />}
        {tab === 'ids' && <IdsFlows />}
        {tab === 'check' && <VerifyLogs source={search.source} onFullPrompt={() => setStep('review')} />}
      </div>
      <TemplatesDrawer
        key={drawer ? 'open' : 'closed'}
        open={drawer}
        onOpenChange={setDrawer}
        setup={setup}
        projects={(sources ?? []).filter((s) => !s.hidden).map((s) => s.name)}
        onAdd={(patch) => update(patch)}
        onCreateOwn={() => {
          const g = blankGoal()
          update((s) => ({ goals: [...s.goals, g] }))
          setEditing(g.id)
        }}
      />
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
      <h3 className="flex items-center gap-3 font-semibold text-[15px]">
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
                    'w-9 text-center',
                    l === 'warn' && 'bg-level-warn-muted text-level-warn',
                    l === 'info' && 'bg-level-info-muted text-level-info',
                    l === 'error' && 'bg-level-error-muted text-level-error',
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
              Open a sample flow <ArrowRightIcon className="size-3.5" />
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
                <StatusDot status="warn" /> payout-88-1300
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
          body="Open a record: request, response, context and typed errors. JSON and Raw show sanitized data; redacted values cannot be revealed."
          link={
            <Link to="/guide" search={{ tab: 'canonical' }} className={linkCls}>
              How fields are read <ArrowRightIcon className="size-3.5" />
            </Link>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 font-mono text-[11px]">
            {[
              ['status_code', '500'],
              ['duration_ms', '3412'],
              ['error.code', 'REPORT_BUILD_FAILED'],
            ].map(([k, v]) => (
              <div key={k} className="col-span-2 grid grid-cols-subgrid border-b py-1">
                <dt className="text-brand">{k}</dt>
                <dd className={cn(k === 'status_code' || k === 'duration_ms' ? 'text-level-warn' : 'text-destructive')}>
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
            Paste the prompt into your coding agent. It detects your stack, uses one wide event per request or job
            attempt, and asks for your SLOs, capture policy and sampling rules.
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
            <span>{'{ "flow": "create_order",'}</span>
            <span className="pl-3">"request_id": "req_8f2a8c",</span>
            <span className="pl-3 text-level-warn">"status_code": 201, "duration_ms": 142,</span>
            <span className="pl-3">{'"order": { "id": 1182 } }'}</span>
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
          sub="checks for one source, with fixes"
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
