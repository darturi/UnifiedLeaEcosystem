# Lea Standalone

`apps/lea-standalone` is the canonical local Lea UI and backend. It contains:

- a React + Vite web app on `http://localhost:5173`;
- a FastAPI adapter on `http://127.0.0.1:8001`;
- the vendored Lea prover at `prover/`, imported by the adapter as a Python
  library.

The adapter drives the prover in-process through `lea.interface.run_events(...)`.
It translates typed prover events into Server-Sent Events for the browser,
commits proof changes to git, stores timeline metadata in SQLite, and exposes
manual `lean_check` and SafeVerify endpoints.

## First-Time Setup

From the monorepo root, the recommended setup is:

```sh
npm run setup
```

For this app only:

```sh
npm run setup -- --target ui
```

Manual app-local setup is:

```sh
npm install
cp config/lea.local.example.toml config/lea.local.toml
npm run setup:api
```

`setup:api` creates the adapter virtualenv, installs the editable prover package,
sets up the prover environment, and downloads the pinned Mathlib cache so the
first proof check does not compile Mathlib from scratch.

## Development

Start the adapter and web UI together:

```sh
npm run dev
```

The launcher:

- checks local prerequisites;
- starts the FastAPI adapter on `http://127.0.0.1:8001`;
- waits for `/api/health`;
- starts Vite with `--host 0.0.0.0` on `http://localhost:5173`;
- stops both child processes on `Ctrl+C`.

To start only one process:

```sh
npm run start:api  # FastAPI adapter only
npm run dev:web    # Vite web server only
```

From the monorepo root, `npm run start:adapter` is equivalent to this app's
`npm run start:api`.

## Configuration

The adapter reads `config/lea.local.toml`. The standalone Settings page edits the
same file, so manual edits and UI edits share one source of truth.

Common fields:

```toml
lea_root = "prover"
model = "gemini/gemini-3.1-pro-preview"
max_turns = 20
max_spend_usd = 25.00
narrate_tool_steps = true
openai_api_key = ""
anthropic_api_key = ""
google_api_key = ""
```

Provider keys are exported into the adapter process environment when config is
loaded, because LiteLLM reads provider credentials from environment variables.
The returned `LeaConfig` object does not carry secrets.

The current interactive UI gates impactful tools (`bash`, `write_file`,
`edit_file`) with allow/deny/always-for-session prompts. Overleaf-originated runs
are marked autonomous and skip this gate.

## Using The UI

- Chat messages and status chips show the prover's live reasoning, tool calls,
  checks, and terminal status.
- The proof canvas shows git-backed file snapshots from each `code_step`; use the
  stepper to inspect earlier proof states.
- Human edits in the canvas write to the same working tree, commit as user-authored
  steps, and can include an edit note for the next run.
- `lean_check` checks the current file without starting an agent run and
  back-fills the latest step's verdict.
- SafeVerify audits a finished proof with kernel replay and axiom checks.
- Projects create shared proof repos under `prover/workspace/proofs/Lea/<Project>`
  so sessions can import sibling lemmas.
- Project Instructions, Memory, Blueprint, uploaded files, and the filesystem tab
  are all backed by files in that project repo.
- The Stats page reads persisted usage and cost from SQLite.

## Health Check

Run:

```sh
npm run doctor
```

Manual endpoint checks:

```sh
curl http://127.0.0.1:8001/api/health
curl http://127.0.0.1:8001/api/sessions
curl -I http://127.0.0.1:5173/
```

If `prover/` is missing, the checkout is incomplete. If a run appears to sit on
`lean_check` for minutes, run `npm run doctor`; a failing Mathlib cache check
usually means `npm run setup:api` needs to finish successfully.

## Data

- App database: `data/lea-interface.sqlite3`
- Adapter event/log data: `data/`
- Local adapter config: `config/lea.local.toml`
- Vendored prover: `prover/`
- Proof repos and project repos: `prover/workspace/proofs/`
- Overleaf LaTeX mirror: `prover/workspace/context/overleaf/`

Do not commit `config/lea.local.toml`; rotate any API key that is pasted into
logs or chat.

## Tests

Frontend unit tests:

```sh
npm run test:frontend
```

TypeScript check:

```sh
npm run typecheck
```

Adapter tests:

```sh
cd adapter
./.venv/bin/python -m pytest
```

## Upgrading An Existing Checkout

The app database is created from the authoritative schema in `adapter/app/db.py`
with `CREATE TABLE IF NOT EXISTS`. There are no in-place schema migrations; this
local app treats the database as disposable/rebuildable.

When pulling a schema-changing update, the simplest fix is:

```sh
npm run reset:local
```

Preview first:

```sh
npm run reset:local -- --dry-run
```

This clears local sessions, proofs, logs, and SQLite state while keeping installed
dependencies and caches. For surgical data preservation, inspect the failing table
and recreate only that feature table from `init_db()`, but do not drop
`sessions`, `runs`, `code_steps`, or `messages` unless you are intentionally
discarding run history.
