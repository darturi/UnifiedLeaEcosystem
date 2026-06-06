# Theorem Formalization Interface

Local React UI for running [Lea](https://github.com/shaswatpatel123/lea-prover/tree/lea_api) through the bundled Lea API, streaming proof progress, rendering math-rich explanations, and saving chat/code history in SQLite.

## One-Command Dev

After setup, start the bundled Lea API, UI adapter API, and web UI with:

```bash
npm run dev
```

The launcher:

- checks required local files
- starts the bundled Lea API from `external/lea-prover`
- waits for `http://127.0.0.1:8000/v1/healthz`
- starts the local FastAPI adapter backend
- waits for `http://127.0.0.1:8001/api/health`
- starts Vite with `--host 0.0.0.0`
- waits for `http://127.0.0.1:5173`
- prints the browser URL

Stop all local processes with `Ctrl+C`.

## First-Time Setup

```bash
git submodule update --init --recursive
npm install
cp config/lea.local.example.toml config/lea.local.toml
npm run setup:api
```

If cloning from scratch, this is equivalent:

```bash
git clone --recurse-submodules <repo-url>
```

Edit `config/lea.local.toml` and set `model`, `max_turns`, and one provider key such as `google_api_key`, `anthropic_api_key`, or `openai_api_key`. You can also export provider keys in your shell instead of writing them to the config file.

Set `narrate_tool_steps = true` to ask the bundled Lea agent to emit short Markdown/LaTeX progress summaries before it calls tools. This keeps step narration inside Lea rather than synthesizing it in the UI adapter.

Set `permission_tier = "theorem_translation"` to pause each run for approval of the checked top-level Lean theorem skeleton before proof search starts. Use `permission_tier = "none"` to disable approval prompts.

The default config uses the bundled Lea API at `http://127.0.0.1:8000` and resolves Lean file paths relative to the submodule:

```toml
lea_api_base_url = "http://127.0.0.1:8000"
lea_root = "external/lea-prover"
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

If the submodule is missing, run `git submodule update --init --recursive`.

## Data

- App database: `data/lea-interface.sqlite3`
- Raw Lea API event diagnostics: `data/lea-api-events/`
- Local adapter config: `config/lea.local.toml`
- Bundled Lea API submodule: `external/lea-prover`
- Local Lea file snapshots: configured by `lea_root`

Do not commit `config/lea.local.toml`; rotate any API key that is pasted into logs or chat.
