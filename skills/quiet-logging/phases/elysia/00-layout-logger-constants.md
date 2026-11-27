# quiet · Elysia · Layout, logger and constants

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Step 1 — Map the codebase
Report each row with one real file path as evidence:

| | Finding | Evidence |
|---|---|---|
| Single app or monorepo (which apps are Elysia backends) | | |
| Where shared plugins/utils live (`src/plugins`, `src/utils`, `packages/*`…) | | |
| Where env/config is read | | |
| File naming and import aliases | | |
| Entry file where plugins are `.use()`d | | |
| Existing logger or logging plugin | | |
| Background jobs: queue, scheduler or cron (package, where workers run) | | |

Then propose a path for: logger, constants, request id plugin, request context, request event plugin.
If the codebase has no structure yet, start from Elysia's feature layout
(`src/modules/<feature>/`) and offer places for shared plugins as options.
Where more than one path fits, give a numbered list and ask the user to select.

If the map found no background jobs, ask the user:
"Does this project run background jobs or scheduled tasks?"
- **No**: jobs are skipped in every later phase.
- **Not yet, but planned**: record it; the jobs phase will offer options then.
- **Yes**: ask where they live, since the map missed them, and add them to the map.
Do not install anything for jobs in this phase.
Stop.

## Step 2 — Choose a logger
Ask the user to select one:

1. **pino**: already emits quiet's line shape and has built-in redaction; one dependency.
2. **LogTape**: zero dependencies, official Elysia adapter; needs a custom formatter
   (its JSON output nests fields under `properties`).
3. **No library**: `JSON.stringify` to stdout; you build levels and redaction later.

If the project already has a logger, list it as option 0 with what it would need to
match quiet's shape. Do not use access-log plugins (logixlysia, `@bogeychan/elysia-logger`)
as the canonical event; they write their own per-request line.
Stop.

## Step 3 — Set up
In the agreed constants file:

```ts
export const SERVICE = Bun.env.SERVICE_NAME ?? '<package.json name>'
export const ENV = Bun.env.NODE_ENV ?? 'development'
export const VERSION = Bun.env.SERVICE_VERSION
export const COMMIT_SHA = Bun.env.COMMIT_SHA

export const REQUEST_ID_HEADER = 'x-request-id'
export const SLOW_MS = 2000
export const SAMPLE_RATE = 1
export const REQUEST_HEADERS = ['content-type', 'user-agent']
export const REDACT_KEYS = ['authorization', 'cookie', 'password', 'token', 'api_key', 'secret']
```

If the codebase already reads env through one module, read these values through it.

In the agreed logger file, with pino:

```ts
import pino from 'pino'
import { COMMIT_SHA, ENV, SERVICE, VERSION } from '<constants path>'

export const logger = pino({
  base: { service: SERVICE, env: ENV, version: VERSION, commit_sha: COMMIT_SHA },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label }) },
})
```

For another choice, match the same output: top-level fields, a `timestamp` key and a lowercase `level`.

Existing project: move logging magic values into the constants file and change only
the logger's config. Leave existing log calls as they are.

## Step 4 — Record the layout
Create `docs/logging.md` with:
- **Layout**: the agreed paths, the chosen logger, the constants file, and the jobs
  answer (the job system in use, "planned" or "none"). Later phases read this first.
- **Progress**: an empty list; the skill appends to it.

## Done when
The app starts and prints one boot line like:
`{"level":"info","timestamp":"…","service":"api","env":"development","version":"1.0.0","flow":"boot"}`
Stop. Show the diff and the boot line.
