# Overleaf Lea Formalizer MVP

This repository contains a local MVP for sending labeled Overleaf theorem blocks to Lea and tracking the resulting Lean proofs in Lea's own workspace.

## Pieces

- `extension/`: Chrome MV3 extension for Overleaf.
- `companion/`: local HTTP service that starts Lea jobs and tracks statuses.
- `shared/`: parser and helper logic used by tests and the companion.
- `tests/`: Node test suite.
- `vendor/lea-prover/`: Lea checkout. All Lean work happens under `vendor/lea-prover/workspace`.

## Theorem Syntax

The MVP requires labeled theorem blocks:

```tex
\theorem{
  Every finite tree has at least two leaves.
}\label{my_theorem_name}
```

The `\label{...}` value is used as the generated Lean declaration name. It must be a valid Lean identifier: letters, digits, and underscores, with no leading digit.

For a minimal test document, define the display macro in the preamble:

```tex
\newcommand{\theorem}[1]{\paragraph{Theorem.} #1}
```

## One-Time Local Setup

Run the setup script from the repository root:

```sh
git submodule update --init --recursive
npm run setup
```

The script does the one-time local work:

- initializes or updates the Lea submodule at `vendor/lea-prover`
- runs `uv sync --extra api` for the bundled Lea API
- runs `lake update` in `vendor/lea-prover/workspace` when the local Mathlib checkout is missing
- runs `lake exe cache get` in `vendor/lea-prover/workspace`
- verifies `import Mathlib` against the compiled cache so first-run cache issues fail during setup
- writes `.env` for API/runtime settings and `.overleaf-lean-stub/settings.json` for local Lea paths

To force a Lean dependency refresh:

```sh
npm run update-lean-deps
```

Then edit `.env` and replace the placeholder API key:

```text
OPENAI_API_KEY=your_openai_key_here
LEA_API_BASE_URL=http://127.0.0.1:8000
LEA_JOB_TIMEOUT_SECONDS=900
```

Check setup:

```sh
npm run doctor
```

Fix anything marked with `✗` before starting the companion.

## Run The Companion

Start the bundled Lea API in one terminal:

```sh
npm run start:lea-api
```

Then start the Overleaf companion in another terminal:

```sh
npm start
```

The companion listens on:

```text
http://127.0.0.1:31245
```

## Configure The Extension

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load unpacked extension from the `extension/` directory.
4. Open the extension options page.
5. Confirm the companion URL is `http://127.0.0.1:31245`.
6. Confirm the Lea repo path points to this checkout's `vendor/lea-prover`.

## Run Tests

```sh
npm test
```

## Reset Local Run State

To clear prior local formalization runs while keeping Lea dependencies intact:

```sh
npm run reset:local
```

This removes Lea project markdowns, Lea proof files, companion job logs, backups, and local job/cache indexes. Preview the reset without deleting anything:

```sh
npm run reset:local -- --dry-run
```

## Lea Setup

The main workflow expects:

- the `vendor/lea-prover` submodule initialized from `https://github.com/darturi/lea-prover.git`
- `uv` available on `PATH`
- the Lea API reachable at `LEA_API_BASE_URL` (default `http://127.0.0.1:8000`)
- `OPENAI_API_KEY` in `.env` or exported in the shell that runs `npm start`
- optional `LEA_JOB_TIMEOUT_SECONDS` in `.env` to fail and unblock stalled Lea runs
- Lean and Lake available on `PATH`

The extension options page stores only the companion URL, Lea repo path, Lea API URL, and model settings. API keys stay in `.env` or the companion process environment.

## Generated Lean Work

Lea owns all Lean artifacts. Project records live under:

```text
vendor/lea-prover/workspace/projects/
```

The companion passes Overleaf project context to Lea's project-aware API. On
successful runs, Lea records rich markdown entries with theorem metadata,
signature, solving summary, proof path, and module name.

Project proof files live under Lea's project namespace, for example:

```text
vendor/lea-prover/workspace/proofs/Lea/<ProjectName>/
```

Temporary retry behavior: when a failed theorem is retried, the companion removes the prior generated proof file and the matching project markdown theorem entry before asking Lea to run again. This is a stopgap so stale failed Lean files do not interfere with artifact mapping; we should revisit it once we decide how failed Lean files should be retained, archived, or surfaced.
