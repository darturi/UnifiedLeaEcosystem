# Overleaf Lea Formalizer

This app is the Overleaf side of the LeaEcosystem monorepo. It provides a Chrome
extension plus a local Node companion that sends labeled theorem blocks from
Overleaf to the shared Lea adapter.

The default path is:

```text
Overleaf page -> Chrome extension -> companion (:31245) -> FastAPI adapter (:8001)
```

The adapter then drives the vendored prover at `apps/lea-standalone/prover/`
in-process. The companion does not start its own prover backend.

For beta testers installing from a pinned release tag, see
[BETA_INSTALL.md](BETA_INSTALL.md).

## Pieces

- `extension/`: Chrome MV3 extension injected into Overleaf.
- `companion/`: local HTTP service that validates theorem payloads, starts Lea
  runs, tracks jobs, and reads adapter-persisted usage.
- `shared/`: theorem parser and Lean path helpers used by the companion and tests.
- `tests/`: Node test suite.

Generated Lean work happens under:

```text
apps/lea-standalone/prover/workspace/
```

## Theorem Syntax

The extension looks for `% lea:` comments inside ordinary theorem-like LaTeX
environments. Mark only the blocks you want Lea to formalize:

```tex
\begin{theorem}\label{thm:finite-tree-leaves}
% lea: formalize label=finite_tree_leaves
Every finite tree has at least two leaves.
\end{theorem}
```

The `label=...` value is required. It is used as the Overleaf theorem identifier
and fallback Lean declaration name. It must be a valid Lean identifier: letters,
digits, and underscores, with no leading digit.

Initially supported environments are `theorem`, `lemma`, `proposition`, and
`corollary`. Unmarked environments are ignored.

### `uses={...}`

Use `uses={...}` when a theorem should depend on earlier theorems from the same
Overleaf project. Values are Overleaf labels, not Lean theorem names. Each
referenced theorem must already be formalized, or at least have a saved sorry
stub from an older build, before Lea starts the new run.

```tex
\begin{lemma}
% lea: formalize label=my_next_theorem uses={my_prior_theorem, another_prior_theorem}
Prove this using earlier project results.
\end{lemma}
```

If a referenced label cannot be resolved, the extension blocks the run and
reports which theorem needs to be formalized first.

### `context={...}`

Use `context={...}` to pass natural-language guidance to Lea for this theorem:
proof strategy, notation hints, suggested lemmas, or warnings about how to
interpret the statement.

```tex
\begin{theorem}
% lea: formalize label=even_square context={Use the assumption that n is even, rewrite n as 2 * k, then use ring_nf.}
If n is even, then n^2 is even.
\end{theorem}
```

You can combine all fields:

```tex
\begin{proposition}\label{prop:main-bound}
% lea: formalize label=main_bound uses={auxiliary_bound, monotonicity_lemma} context={Start from auxiliary_bound, then apply monotonicity_lemma to compare the two sides.}
The desired main bound holds.
\end{proposition}
```

Multiline marker metadata is also supported when the `% lea:` lines are adjacent:

```tex
\begin{corollary}
% lea: formalize
% lea: label=main_corollary
% lea: uses={main_bound}
% lea: context={Apply the main bound directly.}
The corollary follows.
\end{corollary}
```

### Deprecated legacy syntax

The older custom command syntax still works temporarily for existing beta
documents, but new documents should use `% lea:` comment markers:

```tex
\theorem[label=my_theorem_name]{
  Every finite tree has at least two leaves.
}
```

## Setup

Run setup from the monorepo root:

```sh
npm run setup
```

For only the Overleaf app:

```sh
npm run setup -- --target overleaf
```

The unified setup installs workspace Node dependencies, delegates adapter/prover
setup to `apps/lea-standalone`, downloads the Lean/Mathlib cache, writes root
`.env` defaults, and writes `.overleaf-lean-stub/settings.json`.

Current default environment values:

```text
LEA_ROOT=apps/lea-standalone/prover
LEA_API_BASE_URL=http://127.0.0.1:8001
LEA_UI_BASE_URL=http://localhost:5173
OVERLEAF_COMPANION_URL=http://127.0.0.1:31245
```

Add provider keys in the standalone Settings page, the extension settings UI, or
the monorepo root `.env`:

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GOOGLE_API_KEY=
LEA_JOB_TIMEOUT_SECONDS=900
```

Check setup:

```sh
npm run doctor
```

Fix anything marked as failing before starting a formalization.

## Running

Start the shared adapter from the monorepo root:

```sh
npm run start:adapter
```

Or, from `apps/overleaf-extension`, use the workspace helper:

```sh
npm run start:lea-api
```

Then start the companion:

```sh
npm run dev:overleaf       # from the monorepo root
npm start                  # from apps/overleaf-extension
```

The companion listens on:

```text
http://127.0.0.1:31245
```

## Configure The Extension

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load the unpacked extension from `apps/overleaf-extension/extension/`.
4. Open the extension options page.
5. Confirm the companion URL is `http://127.0.0.1:31245`.
6. Confirm the Lea repo path points to `apps/lea-standalone/prover`.
7. Confirm the Lea UI base URL is `http://localhost:5173`.

## Workflow

When a theorem is visible in Overleaf, the extension adds status badges and a
popover. The main action is **Formalize**, which asks the companion to create an
autonomous adapter run. The adapter records the session, run, messages, code
steps, and usage, so **View in Lea UI** can deep-link to the standalone proof
timeline.

## Generated Lean Work

Project records and proof files are written in the standalone prover workspace:

```text
apps/lea-standalone/prover/workspace/projects/
apps/lea-standalone/prover/workspace/proofs/Lea/<ProjectName>/
```

Optional mirrored Overleaf context is written under:

```text
apps/lea-standalone/prover/workspace/context/overleaf/<ProjectSlug>/
  manifest.json
  tex/active.tex
```

Formalization prompts include only the manifest path. Lea can open the mirrored
`.tex` file if it decides the additional context is useful.

Temporary retry behavior: when a failed theorem is retried, the companion removes
the prior generated proof file and matching project markdown theorem entry before
asking Lea to run again. This prevents stale failed artifacts from interfering
with artifact mapping.

## Usage And Session Links

Usage comes from the standalone adapter's persisted stats endpoint. The
companion falls back to its local job index only when the adapter is unreachable.

The extension opens Lea sessions through:

```text
http://localhost:5173/?session=<session_id>
```

Set `LEA_UI_BASE_URL` if your Vite server is running elsewhere.

## Optional LaTeX Context

The extension can mirror the active Overleaf editor buffer into the Lea workspace
so the agent can inspect surrounding LaTeX when notation or exposition matters.
This is off by default and can be enabled from extension settings.

The mirror currently tracks the active editor file, not the full Overleaf file
tree.

## Tests

Run the Overleaf test suite:

```sh
npm test
```

From the monorepo root, `npm test` runs this suite first and then the standalone
frontend suite.

## Reset Local Run State

From the monorepo root:

```sh
npm run reset:local
```

This clears Lea project entries, proof entries, mirrored Overleaf LaTeX context,
companion job logs, companion indexes, and the standalone SQLite database while
keeping installed dependencies and caches.

Preview first:

```sh
npm run reset:local -- --dry-run
```
