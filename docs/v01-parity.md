# v0.1 design parity

Audit of every v0.1 board in `design/portal-v01/` (pages 01–09 plus Foundations; v0.2+, mobile and archive left out) against `main` at `371f1e4` (slice 6 merged). Each row says what the board shows that `main` did not, and the **Status** column says what `v01/design-parity` did about it.

Method: every board PNG was read at full size and compared with screenshots of `main` rendered in headless Chromium (server + sample generator + Vite) and with the code. Times, names and counts in the boards are mock data. Matching means showing the same thing with real values.

Legend: **fixed** = built in this branch · **partial** = the main part is built and the rest is listed · **open** = not built, with the reason.

## Foundations

| Board | Gap on main | Status |
|---|---|---|
| F.1 Components | Missing organisms: `Histogram` (stream), `RowPreview`, hover row actions, `EmptyState` for the stream, `ShortcutsSheet`, crash page, `Sparkline`, `HostGroup`, column chooser drag. Log row columns were time · lvl · message · id · steps · duration (no flow/summary split). | fixed (see the rows below) |

## 01 · First run & sign in

| Board | Gap on main | Status |
|---|---|---|
| 01.1 Owner setup | Matches (steps, "This host" checks, strength meter, footer). | — |
| 01.2 Sign in | Matches (keep me signed in, CLI reset note). | — |
| 01.3 Invite | Matches. | — |
| 01.4 Invite expired | Matches (created/expired rows, Copy message for the owner). | — |
| 01.5 Session expired | Matches (dialog over the stream, Not you?). | — |

## 02 · Connect a source

| Board | Gap on main | Status |
|---|---|---|
| 02.1 Welcome | Matches (kinds grid, "Or just pipe it"). | — |
| 02.2 Docker | Matches (socket row, compose snippet). | — |
| 02.3 Waiting | Matches (watching docker.sock, checks). | — |
| 02.4 First logs | The success panel's preview rows used the old message column; they now share the stream row (flow · summary). | fixed |
| 02.5–02.8 Vector / Fluent Bit / OTLP / File | Matches (token, snippets, wait). | — |

## 03 · Stream

| Board | Gap on main | Status |
|---|---|---|
| 03.1 Live | **No histogram.** **Columns**: no FLOW (method muted + path, or job name) or SUMMARY (`event → status`, coloured by outcome); a single MESSAGE column instead. **Level chips were single-choice** (minimum level), not multi-select. Top bar had no "· stitched by request_id". Footer said "N lines in view", not "N lines in 24h window", and its hints were `j k / esc / space / ⌘K` instead of `J K move · ↵ open flow · space pause · ? shortcuts`. Filter bar had no key:value chips ("Filter text, or click any value in a row"), no wrap toggle; export used a download glyph instead of the file glyph. Error rows had no left red bar. Sidebar footer showed "docker off / sqlite store" (board: user only). | fixed |
| 03.2 Paused | Indicator lacked "· buffering 38". No hover actions on rows (copy, filter, Open flow). Footer lacked "scrolled N lines up · N new lines buffered". | fixed |
| 03.3 Filtered | No `status:≥400` / `-path:` chips in the stream; level chips not multi; no "98 of 1,284 lines match · still streaming, matches appear live · Clear filters" row; no "· 3 match/s"; footer lacked "filtered · warn, error · status ≥400 …". | fixed |
| 03.4 Error-heavy | No error-rate callout ("Errors are 54% of lines in the last 5 min (usually 2%) · 31 × notify_job …" + Show errors only / Group by flow). Job rows show the job name as FLOW and `phase → outcome · attempt n` as SUMMARY. Footer "N errors in the last 15 min". | fixed |
| 03.5 Hover + preview | **No inline preview** (click/space expands a 3-column field grid under the row with Open flow ↵ · Copy JSON · Filter request_id and "5 steps across … · press space to collapse"); main opened a side field card instead. Selected row periwinkle left bar was there. | fixed |
| 03.6 Empty filter result | Plain "No lines match these filters yet." instead of the EmptyState (icon, "No lines match", "Nothing in <source> has … in the last 24h", Clear filters, "Try: …" suggestions, search all sources); histogram axis kept; "· 0 match". | fixed |
| 03.7 Source disconnected | Indicator "Offline · reconnecting"; banner names the source and the last line time; rows dimmed; footer "offline · showing the last N lines". Main had a generic "Lost connection to the server" banner. | fixed |

## 04 · Flow & field card

| Board | Gap on main | Status |
|---|---|---|
| 04.1 HTTP flow | Header lacked **Export flow** (05.6 puts it first). Field card actions matched. Waterfall, lanes, wideEvents group, brand edge matched. | fixed |
| 04.2 Job retry | Matches (bar timeline, retry arcs, "started by" note, attempt in card). Card action now follows the picked field ("Filter by err.code"). | — |
| 04.3 Long flow | Matches (collapsed runs, Problems only, segmented bar). Minimap not built. | open: minimap (the canvas scrolls; low value at v0.1 flow sizes) |
| 04.4 Single line | One-node card lacked "Open in stream" action. | fixed |
| 04.5 Id not found | Retention note pointed to "--retention (settings UI in slice 6)"; board points to Settings (Storage). | fixed |
| 04.6 JSON tab | No line numbers; footer actions did not switch to Copy as JSON / **Download .json**. | fixed |
| 04.7 Raw tab | Meta lacked `via` (kind · source), `size` (bytes) and `parsed` detail (`level 50 → error`); footer actions did not switch to **Copy raw line / Wrap**. | fixed |

## 05 · Search & export

| Board | Gap on main | Status |
|---|---|---|
| 05.1 Grouped by flow | Matches; Export button now uses the file glyph. | fixed |
| 05.2 Time range picker | No **24h window mini histogram** with the selected range highlighted in the picker. | fixed |
| 05.3 No results | No "Similar values seen: key:value ×" suggestions. Button copy "Search last 24h". | fixed |
| 05.4 Export from stream | Dialog lacked the **time range select** (defaults to the view's range, "from the stream view" / "changed in this dialog"); filters showed `level ≥x` instead of chips + "level info, warn, error"; mask hint lacked "on because PII masking is on for these sources". | fixed |
| 05.5 CSV columns | Columns could not be **dragged to reorder**; suggested columns are unchecked checkboxes. | fixed |
| 05.6 Export flow | **Missing** (no entry point, no flow scope: request_id → job_id, sources, whole flow span, lines · steps · size; gzip off). | fixed |
| 05.7 Large export | No progress ("Preparing 1.2M lines · 34% · 412k / 1.2M · ~40s left", Cancel, closeable). | partial: the browser streams the file itself with live progress, Cancel and a closeable dialog; there is still no server-side preparing job (slice 2 decision: export streams page by page), so "lines that expire meanwhile are still included" is not promised. |
| 05.8 Ready toast | Missing ("Export ready · file · size" + Download). | fixed (toast after a background export finishes) |

## 06 · Sources & per-source settings

| Board | Gap on main | Status |
|---|---|---|
| 06.1 List | Columns lacked **rate sparkline**, **errors %**, **flow id** chip; no host group rows ("this host · 3 sources · docker.sock"); no "stopped sending" banner; "Erroring n" filter missing. | fixed (grouped by stack by default, see *Docker stack groups* below; "Group by host" keeps the receiver grouping) |
| 06.2 Detail | Overview lacked rate / last line / lines 24h / flow id stats as drawn, **lines per 15 min · 24h histogram**, **Fields detected** table (field, type, coverage bar, sample), **Flow id detected** (coverage per id key), Connection details, Remove source. | fixed (remove = purge this source's lines + forget it; Docker containers come back if they log again) |
| 06.3 Edit / rename | Edit sheet (display name, matches, flow id order, muted lines). Display name + id order live in the Settings tab on main. | partial: Edit opens the Settings tab; **muted lines** (hide a path from the live stream) not built: needs a per-source stream filter, logged as follow-up |
| 06.4 Confirm remove | Type-to-confirm dialog + "also revoke its token". | fixed (type-to-confirm; token revoke is a link to Ingest tokens) |
| 06.5 Rejected + malformed | Rejected tab existed. **Malformed** tab + stats (accepted, rejected 15 min, malformed 24h) missing. | fixed (malformed = lines kept as raw text: not JSON / truncated / duplicate key, from the store) |
| 06.6 Per-source settings | Built in slice 6 (display name, match, id order, PII, ignore). | — |

## 07 · Settings

| Board | Gap on main | Status |
|---|---|---|
| 07.1 Account | Matches. | — |
| 07.2 Members | Matches. | — |
| 07.3 Storage | Matches. | — |
| 07.4 Cap warning | Matches. | — |
| 07.5 Disk cap banner | Matches. | — |
| 07.6 About | **Missing page** (running version, uptime, database size, live clients, update callout + host command, This instance table, check for updates, Docs/GitHub/License/Copy debug info). | open: in progress on this branch |
| 07.7 Ingest tokens | Matches. | — |
| 07.8 Flow id order | No **coverage per id** ("61% of lines · legivent-api, traefik"), no drag handle, **no custom id fields** ("Add a field, e.g. x-request-id or ctx.trace"). | open: in progress on this branch |
| 07.9 Appearance | Matches. | — |
| 07.10 General | Lacked **Public URL**, **Timestamps** (14:07:35 / 14:07:35.412 / 2s ago), **Max line size**, **Keep non-JSON lines**; timezone is a free input instead of a select. | fixed |

## 08 · System states & errors

| Board | Gap on main | Status |
|---|---|---|
| 08.1 Command palette | Sources lacked kind · rate; flows lacked key badge and status; actions lacked "Search last 24h for "…" ⌘↵", Pause stream, Switch theme T; footer tip "paste any id to jump straight to its flow". | fixed |
| 08.2 Keyboard shortcuts | **Missing sheet** (`?`), and shortcuts E (errors only), 1–4 (toggle levels), X (clear filters), C / F / O in flows, ⌘/ search, S sources, T theme. | fixed |
| 08.3 Toasts | sileo toasts exist; "reconnected · N buffered lines replayed", "Copied line as JSON · id · bytes", "Token revoked … Undo" copy. | fixed (copy); Undo on token revoke: open (revoke is immediate on the server) |
| 08.4 Loading skeleton | Stream showed an empty table while connecting; board: "Connecting" indicator, skeleton histogram + rows, "loading the last 15 minutes · then streaming live". | fixed |
| 08.5 Source is quiet | Missing ("dokploy is quiet" EmptyState, still listening · last line, show the last 50 lines, "· no flow id found"). | fixed |
| 08.6 404 broken flow link | Not-found page lacked the 404 layout when there are no close matches (URL box, searchable window / looked for / sources searched table, Back to stream / Search 24h / Storage settings). | fixed |
| 08.7 Server unreachable | Global top banner across the app ("Can't reach the quiet server · live connection closed at … · retrying in 8s (attempt 5) …", Retry now), Offline indicator "server unreachable", rows dimmed, sidebar rates "—", footer "disconnected · showing N lines received before …". | fixed |
| 08.8 Crash page | Root error page was the auth-card "Something broke"; board is a full crash page (error id, details box with stack/route/browser/server, Reload ⌘R / Back to stream / Copy details, footer). | fixed |

## 09 · Light theme

| Board | Gap on main | Status |
|---|---|---|
| 09.1–09.3 | Light tokens exist; every new component above uses tokens only, so light follows. | fixed (checked by screenshot) |

## Added outside the boards

| Request | What was built | Status |
|---|---|---|
| Source grouping (Kwaame, 2026-10-22; boards v0.1-06.7, 06.8, 03.8, 03.9, 07.11) | Server keeps each Docker source's container labels and groups on read: auto (`quiet.group` → Compose project → Swarm stack → Standalone), custom label, or off; pushes are Ingest. `/api/sources` returns `group` + `group_kind` (`compose · stack · custom · standalone · ingest`, null when off); `PUT /api/settings/grouping`; `GET /api/sources/grouping-preview`; `QUIET_GROUP_BY` / `QUIET_GROUP_LABEL` win and lock the control. UI: group rows with kind tag, counts, rate, Search · 24h and ⋯ menu (incl. Ignore all N), member dots when collapsed, all-stopped row; All · Standalone · Compose / Stack filter with a "hiding …" note; sidebar compact headers + 28px items + collapse all; stream top-bar source picker; ⌘K grouped sources + Groups → `/sources?group=`; Settings → General → Source grouping with live preview and env lock. | fixed; streaming stays one source at a time (no whole-group stream) |
