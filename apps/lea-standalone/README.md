# Theorem Formalization Interface

Local React UI for running [Lea](https://github.com/shaswatpatel123/lea-prover/tree/lea_api) through the bundled Lea API, streaming proof progress, rendering math-rich explanations, and saving chat/code history in SQLite.

## One-Command Dev

After setup, start the bundled Lea API, UI adapter API, and web UI with:

```bash
npm run dev
```

The launcher:

- checks required local files
- starts the bundled Lea API from `prover`
- waits for `http://127.0.0.1:8000/v1/healthz`
- starts the local FastAPI adapter backend
- waits for `http://127.0.0.1:8001/api/health`
- starts Vite with `--host 0.0.0.0`
- waits for `http://127.0.0.1:5173`
- prints the browser URL

Stop all local processes with `Ctrl+C`.

## First-Time Setup

```bash
npm install
cp config/lea.local.example.toml config/lea.local.toml
npm run setup:api
```

The Lea prover is vendored directly in this repo at `prover/`, so there is no submodule to initialize.

`npm run setup:api` installs the Python services and downloads the pinned Mathlib build cache. This can take a while on the first run, but it prevents the first proof check from compiling Mathlib during `lean_check`.

Edit `config/lea.local.toml` and set `model`, `max_turns`, and one provider key such as `google_api_key`, `anthropic_api_key`, or `openai_api_key`. You can also export provider keys in your shell instead of writing them to the config file.

Set `narrate_tool_steps = true` to ask the bundled Lea agent to emit short Markdown/LaTeX progress summaries before it calls tools. This keeps step narration inside Lea rather than synthesizing it in the UI adapter.

Set `permission_tier = "theorem_translation"` to pause each run for approval of the checked top-level Lean theorem skeleton before proof search starts. Use `permission_tier = "none"` to disable approval prompts.

Set `theorem_translation_max_retries = 3` to control how many internal preflight attempts Lea makes to produce a checked Lean theorem statement before surfacing the approval step. This only affects the theorem translation permission tier.

The default config uses the bundled Lea API at `http://127.0.0.1:8000` and resolves Lean file paths relative to the vendored prover at `prover/`:

```toml
lea_api_base_url = "http://127.0.0.1:8000"
lea_root = "prover"
```

Advanced users can point `lea_api_base_url` at an external Lea API. In that case `npm run dev` will use the configured external service instead of starting the bundled one.

To install only the bundled agent dependencies manually, run `npm run setup:agent`.

## Using The UI

- The chat panel groups assistant narration by Lea API turns and labels them as `Step 1`, `Step 2`, and so on.
- The final result summary is not counted as a step. Successful summaries are highlighted green; failures and max-turns notices are highlighted red.
- The Lean Code panel shows file snapshots recovered from API code artifacts, transcript tool calls, checked Lean file paths, or `lea_root` snapshots.
- Use the Lean Code arrows to review earlier code steps. The corresponding chat step is outlined.
- After a run completes, click a chat step to jump the Lean Code panel to the matching code step.
- Markdown and TeX math in assistant messages are rendered in the chat panel.

## Health Check

Run:

```bash
npm run doctor
```

Manual endpoint checks:

```bash
curl http://127.0.0.1:8001/api/health
curl http://127.0.0.1:8001/api/sessions
curl http://127.0.0.1:8000/v1/healthz
curl -I http://127.0.0.1:5173/
```

If `prover/` is missing, the checkout is broken; re-clone the repo.

If a run appears to sit on `lean_check` for minutes, run `npm run doctor`. A failing `Lean workspace Mathlib cache` check means the first check is compiling Mathlib locally; rerun `npm run setup:api` and wait for the cache download to finish.

## Data

- App database: `data/lea-interface.sqlite3`
- Raw Lea API event diagnostics: `data/lea-api-events/`
- Local adapter config: `config/lea.local.toml`
- Bundled Lea API (vendored in-repo): `prover`
- Local Lea file snapshots: configured by `lea_root`

Do not commit `config/lea.local.toml`; rotate any API key that is pasted into logs or chat.

## Upgrading an existing checkout (database schema)

The app DB (`data/lea-interface.sqlite3`) is created with `CREATE TABLE IF NOT
EXISTS` and there are **no in-place `ALTER` migrations** — by design, the schema is
treated as disposable/rebuildable for a single local user. So when you pull a change
that alters the schema (e.g. the v2.1 Projects tables — new `projects` columns and a
`project_files` table), an **already-existing** `lea-interface.sqlite3` will *not*
auto-upgrade, and the affected endpoint fails with an error like:

```
sqlite3.OperationalError: table projects has no column named description
```

Fixes, from simplest to most surgical:

- **Fresh DB (sanctioned):** `npm run reset:local` clears local run state (proofs,
  logs, SQLite) so the next start rebuilds the schema. Preview with
  `npm run reset:local -- --dry-run`. This **discards existing sessions**.
- **Preserve sessions (surgical):** if only feature tables changed and you want to
  keep your chat/run history, drop just the changed tables and let `init_db`
  recreate them from the authoritative schema — e.g. for the v2.1 Projects change:

  ```sh
  sqlite3 data/lea-interface.sqlite3 'drop table if exists projects; drop table if exists project_files;'
  cd adapter && ./.venv/bin/python -c "from app.db import init_db; init_db()"
  ```

  (Safe here because `projects`/`project_files` hold no essential local data on an
  existing UI checkout; don't drop `sessions`/`runs`/`code_steps`/`messages`.)

A fresh `npm run setup` on a new machine is unaffected — it starts from an empty DB.
A proper cross-version migration path that **preserves user data** across web-app
updates is planned; until then, use one of the two fixes above.
