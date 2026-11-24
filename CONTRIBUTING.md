# Contributing

Thanks for helping with quiet. Bug reports, fixes, docs and features are all welcome. For anything bigger than a small fix, open an issue first so we can agree on the shape before you spend time on it.

## Set up

1. **Fork** the repo on GitHub and clone your fork.
2. Install the tools and run quiet locally: [docs/development.md](docs/development.md). `make up` is enough to try it; `make dev` + `make sample` is the hot-reload setup for working on it.

## Make a change

1. **Branch** from `main`:
   - `fix/<topic>` for a bug fix
   - `feat/<topic>` for a feature
   - `docs/<topic>` or `chore/<topic>` for everything else
   - `slice-<version>/<topic>` for a roadmap slice (maintainers)
2. **Keep it focused.** One change per PR; no behaviour changes hidden in refactors.
3. **Test locally.**
   - `make check` must pass. It is exactly what CI runs: web lint, typecheck, tests and build, then cargo fmt, clippy (`-D warnings`) and tests, including the generated-types and embedded-UI checks.
   - Changed a Rust type the UI uses? Run `make types` and commit `web/src/gen/`. CI fails if they drift.
   - Try the change against real-looking data with `make up`, or `make dev` + `make sample`.
4. **Add a CHANGELOG entry** under the unreleased version at the top of [CHANGELOG.md](CHANGELOG.md): what changed, in words a user would understand.
5. **Open a pull request to `main`.** Say what changed and why, how you tested it, and include a screenshot for UI changes. CI also builds the Docker image and runs a smoke test.

## Conventions

- **Wire types live in Rust.** Change a type in `server/src`, run `make types`, commit `web/src/gen/`.
- **New input?** Implement `Receiver` (`server/src/receiver/`). **New storage?** Implement `Store` (`server/src/store/`). Nothing else should need to change.
- **Every line goes through the pipeline** (`server/src/pipeline.rs`), so it is redacted before it is stored. Don't add a path that writes lines around it.
- **UI primitives** are shadcn/ui on Base UI (`web/src/components/ui/`, add with `bunx shadcn add <name>`). Use Base UI's `render` prop, never Radix `asChild`. Keep parts inside their Root/Portal/Positioner/Group (e.g. `Menu.GroupLabel` inside `Menu.Group`). Any new popup gets a jsdom test that opens it (`web/src/app.test.tsx`).
- **Lint/format:** Biome for the web (`bun run format`), rustfmt + clippy for the server.
- **Tests:** Vitest + Testing Library for the web, `cargo test` for the server. New behaviour comes with a test.
- Keep it calm: one host, one binary, stream → flow → card. Not a dashboard builder.

## How changes ship (maintainers)

`main` is production; there is no staging branch.

1. A merged PR publishes `ghcr.io/qwamicodes/quiet-telemetry:edge` (amd64 + arm64) and prints its digest.
2. Releases are tagged on `main` as `vX.Y.Z` (`git tag -a v0.1.1 -m "quiet v0.1.1" && git push origin v0.1.1`), which publishes `:vX.Y.Z`, `:vX.Y` and `:latest` for amd64 and arm64. The GitHub release uses the matching CHANGELOG section.
3. CI does not deploy; production pulls the tag it runs.

## License

quiet is licensed under [FSL-1.1-MIT](LICENSE.md). By contributing, you agree that your contributions are licensed under the same license as the project.
