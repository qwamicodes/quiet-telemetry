# quiet · Elysia · Jobs and cron

Follow the style rules and run order in `SKILL.md`. Tested on Elysia 1.4.32, Bun 1.4
and pino 10.

## Step 1 — Jobs in this project
Read the jobs answer in the Layout section of `docs/logging.md`.

- **A job system is in use**: use it. Do not suggest switching.
- **"none"**: stop here and tell the user this phase is skipped.
- **"planned"**: ask the user to select one, then stop:

  Queues (work triggered by requests, with retries):
  1. **BullMQ**: Redis-backed, the most widely used; supports Bun's native Redis client.
  2. **pg-boss**: Postgres-backed, no Redis needed; supports Bun.
  3. **bunqueue**: SQLite-backed, no external service, BullMQ-like API; newer.

  Schedules only (no queue):
  4. **Bun.cron**: built into Bun, in-process or OS-level.
  5. **@elysiajs/cron**: Elysia plugin, schedules declared on the app.
     Check which package name is current (`@elysiajs/cron` or `@elysia/cron`).

  Installing the selected system is the user's call: confirm before adding it.
  Record the choice in the Layout section.

If the Layout has no jobs answer (the layout phase ran before this step existed),
ask the layout phase's jobs question first.

The rest of this phase is not written yet: stop after Step 1.
