# Theorem Formalization Interface

Local React UI for running [Lea](https://github.com/shaswatpatel123/lea-prover/tree/lea_api) through the bundled Lea API, streaming proof progress, rendering math-rich explanations, and saving chat/code history in SQLite.

## One-Command Dev

After setup, start the bundled Lea API, UI adapter API, and web UI with:

```bash
npm run dev
```

The launcher:

- checks required local files
- starts the bundled Lea API from `../../vendor/lea-prover`
- waits for `http://127.0.0.1:8000/v1/healthz`
- starts the local FastAPI adapter backend
- waits for `http://127.0.0.1:8001/api/health`
- starts Vite with `--host 0.0.0.0`
- waits for `http://127.0.0.1:5173`
- prints the browser URL

Stop all local processes with `Ctrl+C`.

## First-Time Setup

From the monorepo root:

```bash
npm run setup
```

This sets up the full monorepo: shared Node dependencies, the bundled Lea API,
Lean/Mathlib cache, root `.env`, this UI's adapter API, and the Overleaf
companion settings.

If you only need the UI:

```bash
npm run setup -- --target ui
```

The setup can take a while on the first run, but it prevents the first proof check from compiling Mathlib during `lean_check`.

If cloning from scratch, this is equivalent:

```bash
git clone --recurse-submodules <repo-url>
```

Edit the monorepo root `.env` and set `LEA_MODEL`, `LEA_MAX_TURNS`, and one provider key such as `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. You can also export provider keys in your shell instead of writing them to `.env`.

Set `LEA_NARRATE_TOOL_STEPS=true` to ask the bundled Lea agent to emit short Markdown/LaTeX progress summaries before it calls tools. This keeps step narration inside Lea rather than synthesizing it in the UI adapter.

Set `LEA_PERMISSION_TIER=theorem_translation` to pause each run for approval of the checked top-level Lean theorem skeleton before proof search starts. Use `LEA_PERMISSION_TIER=none` to disable approval prompts.

Set `LEA_THEOREM_TRANSLATION_MAX_RETRIES=3` to control how many internal preflight attempts Lea makes to produce a checked Lean theorem statement before surfacing the approval step. This only affects the theorem translation permission tier.

The default config uses the bundled Lea API at `http://127.0.0.1:8000` and resolves Lean file paths relative to the submodule:

```text
LEA_API_BASE_URL=http://127.0.0.1:8000
LEA_ROOT=vendor/lea-prover
```

Advanced users can point `LEA_API_BASE_URL` at an external Lea API. In that case `npm run dev` will use the configured external service instead of starting the bundled one.

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

If the submodule is missing, run `npm run setup` from the monorepo root.

If a run appears to sit on `lean_check` for minutes, run `npm run doctor`. A failing `Lean workspace Mathlib cache` check means the first check is compiling Mathlib locally; rerun `npm run setup -- --target ui` from the monorepo root and wait for the cache download to finish.

## Data

- App database: `data/lea-interface.sqlite3`
- Raw Lea API event diagnostics: `data/lea-api-events/`
- Local adapter config: monorepo root `.env`
- Bundled Lea API submodule: `../../vendor/lea-prover`
- Local Lea file snapshots: configured by `LEA_ROOT`

Do not commit `.env`; rotate any API key that is pasted into logs or chat. All private runtime config lives in the monorepo root `.env`.
