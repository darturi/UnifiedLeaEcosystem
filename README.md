# Theorem Formalization Interface

Local React UI for running [Lea](https://github.com/chinmayhegde/lea-prover), streaming proof progress, and saving chat/code history in SQLite.

## One-Command Dev

After setup, start both the API and web UI with:

```bash
npm run dev
```

The launcher:

- checks required local files
- starts the FastAPI backend
- waits for `http://127.0.0.1:8000/api/health`
- starts Vite with `--host 0.0.0.0`
- waits for `http://127.0.0.1:5173`
- prints the browser URL

Stop both servers with `Ctrl+C`.

## First-Time Setup

```bash
npm install
npm run setup:api
cp config/lea.local.example.toml config/lea.local.toml
```

Edit `config/lea.local.toml` and set `provider`, `model`, `max_turns`, and the matching API key.

Ensure Lea exists at `external/lea-prover`. This exported folder is not a Git repo, so the current copy is a normal checkout. In a Git repo, prefer:

```bash
git submodule add https://github.com/chinmayhegde/lea-prover.git external/lea-prover
```

Build Lea's workspace once:

```bash
cd external/lea-prover/workspace
mkdir -p proofs
printf 'import Mathlib\n' > proofs/Lea.lean
lake exe cache get
lake build
cd ../../..
```

## Health Check

Run:

```bash
npm run doctor
```

Manual endpoint checks:

```bash
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:8000/api/sessions
curl -I http://127.0.0.1:5173/
```

## Data

- App database: `data/lea-interface.sqlite3`
- Lea proof workspace: `external/lea-prover/workspace/proofs`
- Local secrets: `config/lea.local.toml`

Do not commit `config/lea.local.toml`; rotate any API key that is pasted into logs or chat.

