---
name: quiet-logging
description: Set up quiet canonical logging (one wide event per request/job) in a codebase, one reviewed phase at a time. Use when adding or refactoring logging for quiet.
---

# quiet logging — phased setup

quiet (github.com/qwamicodes/quiet-telemetry) reads one JSON line per unit of work
(request, job attempt, scheduled run) from stdout and stitches lines that share ids.
This skill adds that logging to a codebase in small phases. The user reviews every
phase before the next one starts.

## How to run this skill

1. Read `docs/logging.md` in the project if it exists. Its **Progress** section says
   which phases are done; its **Layout** section says where files live. Never redo a
   finished phase unless the user asks.
2. If there is no `docs/logging.md`, the next phase is the first one (layout).
3. Detect the project's framework and find its folder under `phases/` (see
   **Frameworks**). If there is none, tell the user and offer: (a) stop here, or
   (b) draft that framework's phase file from the Elysia one, clearly marked untested,
   for the user to review first. Let the user select.
4. Open **only the next phase's file** for this framework. Do not read other phase
   files, and do not do work that belongs to a later phase.
5. Run that phase. Obey every `Stop`: show the output and wait.
6. When the phase's "Done when" is met, add a line to the Progress section of
   `docs/logging.md` (`- <phase name> — done <date>`), then stop.
7. End every run by saying which phases are done, which one is next, and that the setup
   is not complete until every phase is done. Each phase builds on the ones before it,
   so an unfinished setup is missing what the remaining phases add (errors, redaction,
   sampling…).
8. If the next phase has no file yet, tell the user it is not written yet and stop.

The setup is complete only when every phase in the table below is done. Until then,
the Progress section lists the remaining phases under **Not done yet**.

## Style (every phase)

- Use the framework's own lifecycle and APIs. No wrappers, classes or custom SDKs.
- Follow this codebase's folders, file naming, exports and import aliases.
- Every tunable value lives in the agreed constants file. Never inline one.
- Only build what the current phase asks for. Do not handle later phases' cases.
- When there is a choice, list the options and let the user select. Do not recommend or default.
- When a step says Stop, show your output and wait.
- After the layout phase: read the Layout section of `docs/logging.md` first. Create
  files only at the paths it lists. If you need a path it doesn't list, propose one and ask.

## Phases

Run them in this order. Each framework folder has one file per phase.

| # | Phase | Elysia file |
|---|---|---|
| 0 | Layout, logger and constants | [00-layout-logger-constants.md](phases/elysia/00-layout-logger-constants.md) |
| 1 | Request id and request event | [01-request-id-and-event.md](phases/elysia/01-request-id-and-event.md) |
| 2 | Flow names and outgoing ids | [02-flow-and-outgoing-ids.md](phases/elysia/02-flow-and-outgoing-ids.md) |
| 3 | Business breadcrumbs (what happened, step by step) | [03-business-breadcrumbs.md](phases/elysia/03-business-breadcrumbs.md) |
| 4 | Levels and error shape | [04-levels-and-errors.md](phases/elysia/04-levels-and-errors.md) |
| 5 | Headers and redaction | under review, not written yet |
| 6 | Tail sampling | not written yet |
| 7 | Jobs and cron | [07-jobs.md](phases/elysia/07-jobs.md) (Step 1 only) |
| 8 | Bodies (opt-in) | not written yet |

## Frameworks

| Language | Framework | Folder | Status |
|---|---|---|---|
| TypeScript / JavaScript | Elysia (Bun) | `phases/elysia/` | in progress; tested on Elysia 1.4.32, Bun 1.4, pino 10 |
| TypeScript / JavaScript | Hono, Express, Fastify, NestJS | — | planned |
| Python | Django, FastAPI, Flask | — | planned |
| Go | net/http (and chi), Gin, Echo, Fiber | — | planned |
| Java | Spring Boot, Quarkus, Micronaut | — | planned |
| PHP | Laravel, Symfony, Leaf | — | planned |
| .NET | ASP.NET Core | — | planned |
| Rust | Axum, Actix Web, Rocket | — | planned |

For a planned framework, tell the user it is planned but not written yet, then
offer the choice in step 3 of "How to run this skill".

Phase files refer to other phases by name, not number, so a phase can be added by
adding a file and one row here.
