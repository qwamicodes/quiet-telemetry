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
2. If there is no `docs/logging.md`, start at Phase 0.
3. Detect the project's framework and open its binding from the table below. If no
   binding exists for it, tell the user and offer: (a) stop here, or (b) draft that
   framework's binding from the phase goals, clearly marked untested, for the user to
   review first. Let the user select.
4. Run exactly **one phase** per run. Obey every `Stop`: show the output and wait.
5. When a phase's "Done when" is met, add a line to the Progress section of
   `docs/logging.md` (`- Phase N — done <date>`), then stop and name the next phase.
6. If the next phase is marked "not written yet", tell the user and stop.

## Style (every phase)

- Use the framework's own lifecycle and APIs. No wrappers, classes or custom SDKs.
- Follow this codebase's folders, file naming, exports and import aliases.
- Every tunable value lives in the agreed constants file. Never inline one.
- Only build what the current phase asks for. Do not handle later phases' cases.
- When there is a choice, list the options and let the user select. Do not recommend or default.
- When a step says Stop, show your output and wait.
- From Phase 1 on: read the Layout section of `docs/logging.md` first. Create files
  only at the paths it lists. If you need a path it doesn't list, propose one and ask.

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Layout, logger and constants | ready |
| 1 | Request id and request event | ready |
| 2 | Flow names and outgoing ids | ready |
| 3 | Business breadcrumbs (who, what, how much) | under review, not written yet |
| 4 | Levels and error shape | not written yet |
| 5 | Headers and redaction | not written yet |
| 6 | Tail sampling | not written yet |
| 7 | Jobs and cron | Step 1 only |
| 8 | Bodies (opt-in) | not written yet |

## Bindings

| Framework | File | Status |
|---|---|---|
| Elysia (Bun) | [bindings/elysia.md](bindings/elysia.md) | Phases 0–2, Phase 7 Step 1; tested on Elysia 1.4.32 |
| Django, Axum, Spring Boot, Laravel, Go net/http | — | not written yet |
