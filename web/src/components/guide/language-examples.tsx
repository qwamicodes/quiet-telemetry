import { ArrowUpRightIcon, CopyIcon, InfoIcon } from 'lucide-react'
import { DONE_ITEMS, EXAMPLES_URL, exampleReadme, type StackId } from '@/lib/guide'
import { Checklist, Code, Panel, StackPicker } from './kit'

const EXAMPLES: { lang: string; title: string; code: string; caption: string }[] = [
  {
    lang: 'typescript',
    title: 'TypeScript · Elysia',
    code: `const logging = wideEventMiddleware(options);
const app = new Elysia().use(logging.plugin)
  .post('/orders', ({ wideEvent, status }) => {
    wideEvent.flow = 'create_order';
    wideEvent.order = { id: 'ord_example' };
    return status(201, { order_id: 'ord_example' });
  });
Bun.serve({ fetch: logging.fetch(r => app.handle(r)) });`,
    caption:
      "Install the plugin and response wrapper. Both are required for the reference's local completion boundary.",
  },
  {
    lang: 'python',
    title: 'Python · ASGI',
    code: `app = wide_event_middleware(framework_app, config)
# In a handler: scope, or request.scope
event = scope["wide_event"]
event["flow"] = "create_order"
event["order"] = {"id": "ord_example"}`,
    caption:
      'Wrap the whole app outside its error-to-response middleware. Final ASGI body/trailer sends define local completion.',
  },
  {
    lang: 'go',
    title: 'Go · net/http',
    code: `handler := logger.WideEventMiddleware(mux)
// In the HTTP handler:
event := logging.EventFrom(r.Context())
event["flow"] = "create_order"
event["order"] = logging.Event{"id": "ord_example"}`,
    caption:
      'Wrap the mux and enrich its request-local map. Keep concurrent writes synchronized and preserve HTTP behavior.',
  },
  {
    lang: 'rust',
    title: 'Rust · Axum',
    code: `// Handler receives Extension<SharedEvent>.
let mut fields = event.lock().unwrap();
fields.insert("flow".into(), json!("create_order"));
fields.insert("order".into(), json!({"id": "ord_example"}));
drop(fields); // release before awaiting`,
    caption: 'The shared event is a synchronized map. The response-body wrapper observes completion, errors and drops.',
  },
]

/** Use the language examples (v0.1.1-11.4). */
export function LanguageExamples({ stack, setStack }: { stack: StackId; setStack: (s: StackId) => void }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_392px] items-start gap-6">
      <Panel
        label="Language examples"
        title="One pattern · native syntax"
        sub="examples/logging · HTTP middleware + worker adapters"
        actions={
          <a
            href={EXAMPLES_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1.5 bg-primary px-2.5 text-[13px] text-primary-foreground hover:bg-primary/80"
          >
            <CopyIcon className="size-3.5" /> Open index
          </a>
        }
      >
        <p className="flex items-center gap-1.5 border-b px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
          <InfoIcon className="size-3" aria-hidden /> Reference adaptations of Boris Tane's pattern; not an
          author-published SDK.
        </p>
        <div className="flex flex-col px-3.5">
          {EXAMPLES.map((e) => (
            <section key={e.lang} aria-label={e.title} className="flex flex-col gap-3 border-b py-4">
              <h3 className="text-[13px]">{e.title}</h3>
              <Code>{e.code}</Code>
              <p className="text-muted-foreground text-xs leading-relaxed">{e.caption}</p>
              <a
                href={exampleReadme(e.lang)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 self-start font-mono text-[11px] text-brand hover:underline"
              >
                examples/logging/{e.lang}/README.md <ArrowUpRightIcon className="size-3" />
              </a>
            </section>
          ))}
          <p className="py-4 text-muted-foreground text-xs leading-relaxed">
            Each package includes a demo and tests. Connect your existing JSON sink and metrics system. Real broker
            completion, exporter delivery and durable SLO aggregation need application-specific integration.
          </p>
        </div>
      </Panel>
      <aside className="flex flex-col gap-4">
        <StackPicker
          stack={stack}
          setStack={setStack}
          title="Prompt language"
          aside="selected for the prompt"
          note="Same event and retention rules. Each language uses its native lifecycle hooks."
        />
        <Checklist title="Done looks like" aside="from the prompt" items={DONE_ITEMS} />
      </aside>
    </div>
  )
}
