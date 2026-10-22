# Decisions

Technical choices made while building quiet, newest slice first. Each one
stands unless Kwaame pushes back. The product-level log lives with the
project notes; this file records what the code does and why.

## Slice 5 · Accounts, auth, members (2026-10-22)

Scope agreed beforehand: local email + password accounts, first-run owner
setup, roles owner/member, copy-link invites (SMTP invites are v0.2), owner
reset links + a CLI for locked-out owners, every `/api` route behind a
session, `qi_`/`qx_` tokens keep working without one.

**Storage**
- Four tables in `quiet.db`: `users`, `sessions`, `invites`, `password_resets`.
  Accounts are always on disk under `--data-dir`, even with `--store memory`:
  forgetting them on restart would hand owner setup to whoever arrives first.
- Passwords: argon2id with the `argon2` crate's defaults (19 MiB, t=2, p=1,
  OWASP's recommendation), PHC strings, random 16-byte salt. Unknown emails
  are verified against a dummy hash so they cost the same as a wrong password.
  `argon2`/`blake2` are compiled with opt-level 3 in dev builds (tests and
  `make dev` would otherwise take seconds per hash).
- Session ids, invite and reset tokens: 32 random bytes, hex; only SHA-256 is
  stored. Prefixes `inv_` / `rst_` for links (the design's `inv_` kept);
  session cookies have none.
- Minimum password length 12 (as on the design boards), max 256.

**Sessions**
- Cookie `quiet_session`: HttpOnly, SameSite=Lax, Path=/, `Secure` when
  `X-Forwarded-Proto: https` (`QUIET_COOKIE_SECURE=auto`, default; `on`/`off`
  force it). quiet itself never terminates TLS, so the proxy header is the
  only signal; trusting it is safe because a spoofed `https` only makes the
  attacker's own cookie stricter.
- "Keep me signed in" (default on): 30 days absolute. Off: browser-session
  cookie, forgotten server-side after 12 hours. No sliding expiry; `last_seen`
  is written at most once a minute (the sessions list and members list show it).
- Open WebSocket streams re-check their session every 30 s and close with code
  4401 when it ended; the UI then shows "session expired" instead of reconnecting
  forever with a stale cookie.

**CSRF**
- Two layers. (1) Same-origin: unsafe methods and WebSocket upgrades must carry
  an `Origin` (or `Referer`) whose host matches `Host` or `X-Forwarded-Host`;
  `Origin: null` and `Sec-Fetch-Site: cross-site` are refused. Requests with
  neither header (curl, scripts) pass layer 1. (2) Cookie-authenticated unsafe
  requests must send the session's CSRF token in `X-Quiet-Csrf` (random per
  session, handed out by `/api/auth/state` and every sign-in response,
  compared in constant time).
- The public auth routes (setup, login, invite/reset accept) get layer 1 only,
  which stops login CSRF.
- No CORS is configured, so a cross-site page can't send the custom header at
  all; layer 2 holds even if a proxy rewrites `Host` oddly.

**Login backoff**
- In memory, per `email:` and per `ip:` key. 5 free failures per email, 20 per
  address inside a 15 min window, then 1 s, 2 s, 4 s … capped at 15 min
  (429 + `Retry-After`). A success clears the email key only. Unknown invite and
  reset tokens count against the address too.
- Client address: the socket peer, or with `QUIET_TRUST_PROXY=on` the rightmost
  `X-Forwarded-For` hop (what the trusted proxy itself saw) / `X-Real-IP`.
  Off by default because a spoofable header must not decide lockouts.
- Not persisted: a restart forgives failures. Accepted for v0.1.

**Gating**
- Router split: `/health` and `/ready` open; public auth routes behind the
  origin check; everything else behind `auth::gate` (a `route_layer`, so it
  runs before extractors; an unauthenticated WebSocket upgrade is a 401, not a
  half-open socket).
- `GET /api/export` with an `Authorization` header skips the session; the
  handler already rejects anything but a valid `qx_` token for that exact
  query. Any other route ignores bearer tokens.
- Ingest endpoints belong to the receivers and were never under `/api`; they
  keep using `qi_` tokens (`QUIET_INGEST_AUTH`). Unchanged.
- `/api/health` now needs a session (it lists receivers, disk use and token
  counts). The signed-out pages read version (and, during first run only, host
  checks) from `/api/auth/state` instead.

**Members' rights** (owner decides everything; members read)
- Member: reads every source, the stream, search, flows; exports with PII
  always masked (server-side; a member's `qx_` token is only issued for a
  `mask=pii` query, else 403 `mask_required`); sees the members list (no
  invites) and the ingest token list (previews only); manages only their own
  name, email, password and sessions.
- Owner only: create/revoke ingest tokens, create/revoke invites, change roles,
  remove members, make reset links. Several owners are allowed (the design's
  "1 per instance" became "at least 1"); the last owner can't be demoted or
  removed, and an owner can't remove themselves (ask another owner).
- Every role change, removal, invite, reset link and token change is logged
  with who did it (`tracing` info lines; no secrets).

**Passwords and recovery**
- Changing your password needs the current one and signs out every *other*
  session (the board said other sessions stay; signing them out is what makes
  a password change useful after a leak, and the copy now says so).
- Changing your sign-in email needs the current password.
- Owner reset link: `POST /api/members/:id/reset-link`, one use, 24 h, a newer
  link voids older ones; using it sets the password and signs that user out
  everywhere. No email.
- Locked-out owner: `quiet admin reset-password <email> [--data-dir] [--url]`
  prints a one-time link valid for 1 hour. It writes to the same `quiet.db`
  (SQLite WAL), so it works while the server runs. The design's
  `quiet user reset-password` printing a one-time *password* became a link:
  same flow as owner resets, no password in terminal scrollback, nothing to
  force-change at next sign-in.

**`QUIET_AUTH=off`**
- Kept, for local development only: every request is a synthetic local owner,
  no cookie, no CSRF. The server refuses to start with `off` unless `--addr` is
  a loopback address. Default `on` everywhere, including `make dev` and both
  compose files (setup takes ten seconds once per data dir).

**Listening address**
- With sign-in on, binding `0.0.0.0` is safe; the README, compose files and
  connect panel no longer say "loopback until accounts". The binary's default
  stays `127.0.0.1:7070` (the image uses `0.0.0.0`). TLS stays the proxy's job.
- Every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff` and `Referrer-Policy: same-origin` (invite/reset tokens are in the
  path and must not leak through a Referer).

**UI**
- Routes `/setup`, `/signin?redirect=`, `/invite/$token`, `/reset/$token`
  render without the app shell. The root route's `beforeLoad` reads
  `/api/auth/state` (cached in React Query, updated by the mutations, never
  polled) and redirects: no users → setup, no session → sign in with
  `redirect` = where you were (only same-origin paths are accepted).
- A 401 `session_expired`/`session_required` from any call (or stream close
  4401) opens the "session expired" dialog over the current page (board 01.5);
  signing in again keeps the page and refetches.
- Invite page locks the email when the invite names one; expired/used/revoked
  invites show the board 01.4 card with who created it and when. Path params
  are zod schemas: a malformed link renders "This link is broken" without a
  request.
- Members (07.2): an invite link is shown once (only its hash is kept), so the
  design's "Copy invite link" on a pending row became "New link" (creates a
  fresh link with the same email/role and revokes the old). Rows: role select
  and a ⋯ menu (reset link, remove) for owners; read-only for members.
- Account (07.1): profile, password (meter), sessions with sign out / sign out
  everywhere else.
- New `components/ui/dropdown-menu.tsx` on Base UI Menu with no GroupLabel
  export (the legivent #162 crash); a jsdom test opens it.
