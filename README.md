# LeaEcosystem

LeaEcosystem is an npm-workspaces monorepo that wraps
[Lea](https://github.com/darturi/lea-prover), a Lean 4 theorem-proving agent,
behind two local front ends and one shared backend.

- **`apps/lea-standalone/`** (`lea-interface`) — the React + Vite UI and the
  FastAPI adapter that drives Lea, streams proof progress, and persists the
  proof timeline.
- **`apps/overleaf-extension/`** (`overleaf-lean-stub-mvp`) — a Chrome extension
  plus local Node companion that formalizes labeled theorem blocks from an
  Overleaf document.
- **`packages/lea-model-catalog/`** — the shared provider/model catalog consumed
  by both apps.

The architectural center is the FastAPI adapter on **`http://127.0.0.1:8001`**.
It imports the vendored prover at `apps/lea-standalone/prover/` in-process and
maps the prover's typed events onto the browser's SSE stream. There is no
separate Lea API server to start, and no separate prover checkout to initialize.

The adapter owns the persistent local timeline: SQLite stores sessions, runs,
messages, usage, and code-step metadata; git stores proof content under the
prover workspace. Overleaf-created formalizations go through the same adapter, so
they appear in the standalone UI and can be opened with a `?session=<id>` link.

## Setup

Run setup from the monorepo root:

```sh
npm run setup
```

This installs workspace Node dependencies, writes root `.env` defaults, builds
the standalone adapter/prover Python environments, refreshes the Lean/Mathlib
cache, and writes Overleaf companion settings.

To provision only one side:

```sh
npm run setup -- --target ui
npm run setup -- --target overleaf
```

To refresh Lean dependencies and the Mathlib cache:

```sh
npm run update-lean-deps
```

After setup, add provider keys either in the standalone Settings page or in the
monorepo root `.env`. The default `.env` points both apps at the adapter:

```text
LEA_ROOT=apps/lea-standalone/prover
LEA_API_BASE_URL=http://127.0.0.1:8001
LEA_API_FLAVOR=api
LEA_UI_BASE_URL=http://localhost:5173
OVERLEAF_COMPANION_URL=http://127.0.0.1:31245
```

## Running

Start only the shared backend:

```sh
npm run start:adapter
```

Start the standalone UI in development mode:

```sh
npm run dev:ui
```

`dev:ui` starts the adapter on `:8001` and Vite on `:5173`.

Start the Overleaf companion:

```sh
npm run dev:overleaf
```

The companion listens on `http://127.0.0.1:31245` and expects the adapter to be
reachable at `LEA_API_BASE_URL`.

## Common Commands

```sh
npm run doctor       # health-check both apps
npm test             # Overleaf tests, then standalone frontend tests
npm run reset:local  # clear local run state; keeps installed dependencies
```

Preview a reset:

```sh
npm run reset:local -- --dry-run
```

Adapter Python tests are not included in root `npm test`. Run them from the
adapter directory:

```sh
cd apps/lea-standalone/adapter
./.venv/bin/python -m pytest
```

## Data And Configuration

- Root `.env` supplies shared defaults for both apps. Shell-exported values still
  win.
- `apps/lea-standalone/config/lea.local.toml` is the adapter's runtime config and
  the source of truth for model, turn limit, spend cap, and provider keys edited
  through the standalone Settings page.
- The default SQLite database is
  `apps/lea-standalone/data/lea-interface.sqlite3`.
- Local proof repos live under
  `apps/lea-standalone/prover/workspace/proofs/`.
- Overleaf companion job logs and local settings live under
  `apps/overleaf-extension/.overleaf-lean-stub/`.

`LEA_SHARED_DATA_DIR` can relocate the adapter data directory for local
experiments, but the normal current setup uses the standalone app's data
directory. The older `LEA_SHARED_STATE` recorder path is legacy-only for the
retired rollback flavor; on the current `/api` path, the adapter records runs
directly.
