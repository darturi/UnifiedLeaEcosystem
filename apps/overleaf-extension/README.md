# Overleaf Lea Formalizer MVP

This repository contains a local MVP for sending labeled Overleaf theorem blocks to Lea and tracking the resulting Lean proofs in Lea's own workspace.

For beta testers installing from a pinned release tag, see [BETA_INSTALL.md](BETA_INSTALL.md).

## Pieces

- `extension/`: Chrome MV3 extension for Overleaf.
- `companion/`: local HTTP service that starts Lea jobs and tracks statuses.
- `shared/`: parser and helper logic used by tests and the companion.
- `tests/`: Node test suite.
- `vendor/lea-prover/`: Lea checkout. All Lean work happens under `vendor/lea-prover/workspace`.

## Theorem Syntax

The MVP requires theorem blocks with extension metadata in the optional argument:

```tex
\theorem[label=my_theorem_name]{
  Every finite tree has at least two leaves.
}
```

The `label=...` value is used as the Overleaf theorem identifier and fallback generated Lean declaration name. It must be a valid Lean identifier: letters, digits, and underscores, with no leading digit.

The optional argument also accepts two optional metadata fields: `uses={...}` and `context={...}`.

### `uses={...}`

Use `uses={...}` when a theorem should depend on one or more earlier theorems from the same Overleaf project. The values are Overleaf labels, not Lean theorem names. Each referenced theorem must already be formalized, or at least have a saved sorry stub, before Lea starts the new run.

```tex
\theorem[label=my_next_theorem, uses={my_prior_theorem, another_prior_theorem}]{
  Prove this using earlier project results.
}
```

The companion resolves each label to Lea's recorded theorem name, module name, and proof file before sending the prompt. Lea is then instructed to make use of those results during formalization.

Each `uses={...}` entry must be a valid Lean identifier:

```tex
\theorem[label=final_result, uses={base_case, induction_step}]{
  The final result follows from the base case and induction step.
}
```

If a referenced label cannot be resolved, the extension blocks the run and reports which theorem needs to be formalized first.

### `context={...}`

Use `context={...}` to pass natural-language guidance to Lea for this specific theorem. This is useful for proof strategy, notation hints, suggested lemmas, or warnings about how to interpret the statement.

```tex
\theorem[label=my_guided_theorem, context={Use induction on n, then simplify.}]{
  Prove this with the suggested strategy.
}
```

When provided, the context text is added to the Lea prompt as formalization guidance. It does not affect LaTeX rendering.

Use braces around context text that contains commas, square-bracket tactics, or spans multiple lines:

```tex
\theorem[
  label=even_square,
  context={Use the assumption that n is even, rewrite n as 2 * k, then use ring_nf.}
]{
  If n is even, then n^2 is even.
}
```

You can combine `label`, `uses`, and `context` in the same theorem:

```tex
\theorem[
  label=main_bound,
  uses={auxiliary_bound, monotonicity_lemma},
  context={Start from auxiliary_bound, then apply monotonicity_lemma to compare the two sides.}
]{
  The desired main bound holds.
}
```

For a minimal test document, define the display macro in the preamble. The optional argument is consumed by the extension and ignored by LaTeX rendering:

```tex
\usepackage{xparse}
\NewDocumentCommand{\theorem}{O{} +m}{\paragraph{Theorem.} #2}
```

If your document already defines `\theorem`, replace `\NewDocumentCommand` with `\RenewDocumentCommand`.

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

Then edit `.env` and replace the placeholder API key, or enter provider keys in the extension settings UI. When entered through the UI, keys are written by the local companion to `.env`; they are not stored in Chrome or `.overleaf-lean-stub/settings.json`.

```text
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GEMINI_API_KEY=your_gemini_key_here
# GOOGLE_API_KEY is also accepted for Gemini
LEA_API_BASE_URL=http://127.0.0.1:8000
LEA_JOB_TIMEOUT_SECONDS=900
LEA_LATEX_CONTEXT_MODE=off
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

This removes Lea project markdowns, Lea proof files, mirrored Overleaf LaTeX context, companion job logs, backups, and local job/cache indexes. Preview the reset without deleting anything:

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

The extension options page stores local companion and Lea runtime settings. API keys stay in `.env` or the companion process environment.

## Optional LaTeX Context

Lea can optionally mirror the currently open Overleaf editor buffer into its workspace so proof-search agents can inspect surrounding LaTeX when notation or exposition matters. This is off by default. Enable it from the extension settings or set:

```text
LEA_LATEX_CONTEXT_MODE=active_file
```

The v1 mirror only tracks the active editor file, not the full Overleaf file tree. Mirrored context is written under:

```text
vendor/lea-prover/workspace/context/overleaf/<ProjectSlug>/
  manifest.json
  tex/active.tex
```

Formalization prompts include only the manifest path. Lea can open the mirrored `.tex` file if it decides the additional context is useful.

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
