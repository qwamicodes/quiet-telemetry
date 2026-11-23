# Accounts

Local accounts, email + password. No mail is ever sent.

- **First run.** While quiet has no users, every page goes to **Set up quiet**, and whoever completes it becomes the **owner** (the server logs a warning until then, so set it up right after the first start). Setup works exactly once.
- **Roles.** **Owner**: everything, plus members, invites, reset links, ingest tokens, and exports with PII unmasked. **Member**: reads every source, flow and search; exports always have PII masked; can manage only their own account (name, email, password, sessions). There is always at least one owner: the last one can't be demoted or removed. More than one owner is fine.
- **Invites** (Settings → Members). An owner creates a copy link (`/invite/inv_…`), optionally for one email address (the invite page then locks it), as member or owner. Links work once and expire after 7 days; only their SHA-256 is stored, so a lost link can't be shown again: **Copy invite link** makes a fresh one and retires the old one. Email invites come in v0.3.
- **Sessions.** Signing in sets `quiet_session`: HttpOnly, SameSite=Lax, `Secure` behind https. "Keep me signed in" lasts 30 days; without it the cookie ends with the browser and the server forgets it after 12 hours. Sessions live in `quiet.db` (hashed ids), so a restart keeps everyone signed in. Settings → Account lists your sessions and signs out one, or every other one ("Sign out everywhere else").
- **Changing your password** keeps your other sessions signed in; sign them out from the Sessions card if you need to. A reset link (below) does sign that person out everywhere.
- **When a session ends while a page is open** (signed out elsewhere, removed by an owner, expired), the stream holds where it was ("Paused · held at …") and quiet asks for your password over the page; you carry on where you were.
- **Forgot a password.** An owner opens Settings → Members → ⋯ → *Password reset link* and sends the link (one use, 24 hours, signs that person out everywhere). A locked-out owner runs on the host: `quiet admin reset-password you@example.com --url https://quiet.example.com` (in Docker: `docker exec <container> /quiet admin reset-password you@example.com`) and opens the printed link within an hour.
- **Protection.** Passwords are hashed with argon2id. Sign-in backs off per email (5 free failures) and per client address (20), doubling the wait up to 15 minutes (429 + `Retry-After`). Writes need the session's CSRF token (`X-Quiet-Csrf`, handed out by `/api/auth/state` and sign-in) and must be same-origin (`Origin`/`Referer` vs `Host`/`X-Forwarded-Host`; `Sec-Fetch-Site: cross-site` is refused); so must the stream's WebSocket upgrade. Responses carry `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` (link tokens never leak in a Referer).
- **What needs no session.** `/health`, `/ready`; ingest with a `qi_` token; `GET /api/export` with a `qx_` token from Copy curl.
- **Behind a proxy.** Forward `Host` (or set `X-Forwarded-Host`) and `X-Forwarded-Proto`; set `QUIET_TRUST_PROXY=on` so backoff and the sessions list see real client addresses.
- **`QUIET_AUTH=off`.** No accounts at all: every request is a local owner. For local development only, and only on a loopback address (the server refuses otherwise). Default is `on` everywhere, including `make dev` and the compose files.
- Accounts are always kept on disk under `--data-dir`, even with `--store memory` (losing them on restart would offer owner setup to whoever arrived first).

API: see [Accounts in the API reference](api.md#accounts).
