# Overleaf Lea Formalizer MVP

This repository contains a local MVP for turning labeled Overleaf theorem blocks into Lean files through the Lea prover.

## Pieces

- `extension/`: Chrome MV3 extension for Overleaf.
- `companion/`: local HTTP service that runs Lea and tracks formalization jobs.
- `shared/`: parser and helper logic used by tests and the companion.
- `tests/`: Node test suite.

## Theorem Syntax

The MVP requires labeled theorem blocks:

```tex
\theorem{
  Every finite tree has at least two leaves.
}\label{my_theorem_name}
```

The `\label{...}` value is used as the generated Lean declaration name and filename. It must be a valid Lean identifier: letters, digits, and underscores, with no leading digit.

For a minimal test document, define the display macro in the preamble:

```tex
\newcommand{\theorem}[1]{\paragraph{Theorem.} #1}
```

## One-Time Local Setup

Run the setup script from the repository root:

```sh
npm run setup
```

The script does the one-time local work:

- creates the Lean workspace files if needed
- clones or updates Lea at `vendor/lea-prover`
- runs `uv sync` for Lea
- runs `lake update` and `lake exe cache get` for Mathlib
- writes `.env` and `.overleaf-lean-stub/settings.json` with local absolute paths

Then edit `.env` and replace the placeholder API key:

```text
OPENAI_API_KEY=your_openai_key_here
```

Check setup:

```sh
npm run doctor
```

Fix anything marked with `✗` before starting the companion.

## Run The Companion

```sh
npm start
```

The companion listens on:

```text
http://127.0.0.1:31245
```

On startup, the companion checks whether this project directory is a valid Lean workspace. If not, it creates:

```text
lean-toolchain
lakefile.lean
Formalization/
```

The generated `lakefile.lean` includes Mathlib pinned to the workspace Lean toolchain. The setup
script fetches Mathlib and its compiled cache so Lea-created files can use `import Mathlib`.

If you ever need to refresh that manually, run:

```sh
lake update
lake exe cache get
```

It also stores the selected workspace path in:

```text
.overleaf-lean-stub/settings.json
```

## Configure The Extension

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load unpacked extension from the `extension/` directory.
4. Open the extension options page.
5. Confirm the companion URL is `http://127.0.0.1:31245`.

If the companion starts and this project directory is not already a Lean workspace, it creates a minimal one automatically:

- `lean-toolchain`
- `lakefile.lean` or `lakefile.toml`

## Run Tests

```sh
npm test
```

## Lea Setup

The main workflow expects:

- a local clone of `https://github.com/chinmayhegde/lea-prover` at `vendor/lea-prover`
- `uv` available on `PATH`
- `OPENAI_API_KEY` in `.env` or exported in the shell that runs `npm start`
- Lean and Lake available on `PATH`

The extension options page stores only paths and model settings. API keys stay in `.env` or the companion process environment.

## Generated Lean File

For Overleaf project `abc123` and label `my_theorem_name`, Lea creates or edits:

```text
Formalization/Overleaf/abc123/my_theorem_name.lean
```

The legacy `/stubs` endpoint still writes to `Formalization/Generated/`, but the extension no longer uses it for the main workflow.
# LeaOverleafExtension
