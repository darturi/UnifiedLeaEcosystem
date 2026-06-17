# LeaEcosystem

LeaEcosystem is a monorepo that unifies the two front ends for [Lea](https://github.com/darturi/lea-prover) around a single shared backend:

- **`apps/lea-ui/`** — a local React + FastAPI interface for running Lea, streaming proof progress, and browsing chat/code history.
- **`apps/overleaf-extension/`** — a Chrome extension and local companion that formalizes labeled theorem blocks directly from an Overleaf document.

Both apps drive the same bundled Lea API (`vendor/lea-prover`, a git submodule) and, with shared state enabled, write the full process timeline of every run into one shared SQLite database. That means a formalization started from inside Overleaf can be opened and inspected in the Lea UI exactly as if the UI had run it — and the Overleaf extension can deep-link straight to that session in the UI. See [`docs/shared-process-state.md`](docs/shared-process-state.md) for the design.

Shared building blocks live under `packages/` (e.g. `packages/lea-model-catalog` — the provider/model list both apps use).

## Setup

Run the unified setup from the monorepo root:

```sh
npm run setup
```

This installs workspace Node dependencies, initializes the shared
`vendor/lea-prover` submodule, installs the bundled Lea API dependencies,
downloads and verifies the Lean/Mathlib cache, writes root `.env` defaults, and
prepares both the Overleaf companion and Lea UI.

To set up only one app:

```sh
npm run setup -- --target ui
npm run setup -- --target overleaf
```

To refresh Lean dependencies and the Mathlib cache:

```sh
npm run update-lean-deps
```

If cloning from scratch, recurse the submodule:

```sh
git clone --recurse-submodules https://github.com/darturi/UnifiedLeaEcosystem.git
```

## Running the apps

Start the bundled Lea API (shared by both apps):

```sh
npm run dev:lea
```

Then start whichever front end you need:

```sh
npm run dev:ui        # React UI + FastAPI adapter (see apps/lea-ui/README.md)
npm run dev:overleaf  # Overleaf companion (see apps/overleaf-extension/README.md)
```

Each app's README covers its own first-run details, including loading the Chrome
extension for the Overleaf workflow.

## Environment

Private runtime fields are shared through one monorepo-root `.env` file.

```sh
cp .env.example .env
```

Set provider keys, Lea paths, model settings, and timeout/spend limits there.
Shell-exported values override `.env`; older app-local files are read only as
migration fallbacks.

### Shared process state

Set `LEA_SHARED_STATE=true` to have the Overleaf extension record each run's full
process timeline (messages, code steps, approvals, usage) into the shared
database, so Overleaf runs appear in the Lea UI just like UI-originated ones. By
default both apps share the UI's existing data directory (`apps/lea-ui/data`);
`LEA_SHARED_DATA_DIR`, `LEA_DB_PATH`, and `LEA_EVENT_LOG_DIR` can override where
the database and raw event logs live. See `.env.example` for the full set of
shared-state options and `docs/shared-process-state.md` for the design.

## Common commands

```sh
npm run doctor       # health-check both apps
npm test             # run the Overleaf and UI test suites
npm run reset:local  # clear local run state (proofs, logs, SQLite) — keeps Lea deps
```

Run `npm run reset:local -- --dry-run` to preview what a reset would remove.
