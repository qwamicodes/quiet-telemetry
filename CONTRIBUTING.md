# Contributing

## Flow: local → main → prod

1. **Branch** from `main`: `slice-N/<topic>` for a roadmap slice, `fix/<topic>` or `chore/<topic>` otherwise.
2. **Test locally.** `make check` must pass (it is what CI runs). Try the change against real-looking data with `make up` (compose stack + sample generator) or `make dev` + `make sample`.
3. **Open a PR to `main`.** CI runs web lint/typecheck/test/build, cargo fmt/clippy/test (including the generated-types and embedded-UI checks) and a Docker build + smoke test. One slice per PR; no behaviour changes hidden in refactors.
4. **Merge to `main`.** `release.yml` publishes `ghcr.io/qwamicodes/quiet-telemetry:sha-<sha>` and prints its digest.
5. **Prod.** The `deploy-production` job waits for approval on the `production` environment, then deploys that digest to Dokploy (deploy.legivent.com).
6. **Tag releases** on `main` as `vX.Y.Z` (`git tag v0.1.0 && git push origin v0.1.0`), which publishes `:X.Y.Z` and goes through the same approval.

There is no staging branch or environment.

## Conventions

- **Wire types live in Rust.** Change a type in `server/src`, run `make types`, commit `web/src/gen/`. CI fails if they drift.
- **New input?** Implement `Receiver` (`server/src/receiver/`). **New storage?** Implement `Store` (`server/src/store/`). Nothing else should need to change.
- **UI primitives** are shadcn/ui on Base UI (`web/src/components/ui/`, add with `npx shadcn add <name>`). Use Base UI's `render` prop, never Radix `asChild`. Keep parts inside their Root/Portal/Positioner/Group (e.g. `Menu.GroupLabel` inside `Menu.Group`). Any new popup gets a jsdom test that opens it (`web/src/app.test.tsx`).
- **Lint/format:** Biome for the web (`npm run format`), rustfmt + clippy for the server.
- Keep it calm: one host, one binary, stream → flow → card. Not a dashboard builder.
