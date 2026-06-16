# Beta Install Guide

These instructions install the beta version of the Overleaf Lea Formalizer Chrome extension from the pinned beta tag.

## What You Need

- Google Chrome
- Git
- Node.js 20 or newer
- `uv`
- Lean and Lake available on your `PATH`
- An OpenAI API key

If you are not sure whether the command-line tools are installed, continue with the steps below. The `doctor` command will report anything missing.

## 1. Clone The Beta

Replace `beta-2026-06-16` if you were given a newer beta tag.

```sh
git clone --branch beta-2026-06-16 --recurse-submodules https://github.com/darturi/LeaOverleafExtension.git
cd LeaOverleafExtension
```

If you already cloned without submodules, run this from inside the repository:

```sh
git submodule update --init --recursive
```

## 2. Run Setup

```sh
npm run setup
```

This prepares the local Lea checkout, installs the Lea API dependencies, fetches Lean dependencies, downloads the Mathlib cache, and writes local settings files.

The first setup may take a while because Lean and Mathlib artifacts are large.

## 3. Add Your API Key

Open the `.env` file in the repository root and replace the placeholder key:

```text
OPENAI_API_KEY=your_openai_key_here
```

with:

```text
OPENAI_API_KEY=sk-...
```

Leave these defaults unless Daniel tells you otherwise:

```text
LEA_API_BASE_URL=http://127.0.0.1:8000
LEA_PROVIDER=openai
LEA_MODEL=o4-mini
LEA_MAX_TURNS=20
LEA_LATEX_CONTEXT_MODE=off
LEA_JOB_TIMEOUT_SECONDS=900
```

## 4. Check Your Install

```sh
npm run doctor
```

Every required check should show a checkmark. If anything shows an `x`, fix that item and run `npm run doctor` again.

## 5. Start The Local Services

Open two terminal windows or tabs in the repository root.

In the first terminal, start the Lea API:

```sh
npm run start:lea-api
```

In the second terminal, start the Overleaf companion:

```sh
npm start
```

Keep both terminals running while you use the extension.

## 6. Load The Chrome Extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on Developer Mode.
4. Click Load unpacked.
5. Select the `extension` folder inside this repository.
6. Open the extension options page.
7. Confirm the companion URL is:

```text
http://127.0.0.1:31245
```

8. Confirm the Lea repo path points to this checkout's `vendor/lea-prover` folder.

## 7. Use It In Overleaf

Open an Overleaf project and write theorem blocks like this:

```tex
\theorem[label=my_theorem_name]{
  Every finite tree has at least two leaves.
}
```

The `label=...` value should be a valid Lean identifier: letters, digits, and underscores, with no leading digit.

## Updating To A New Beta

If Daniel gives you a new beta tag, run these commands from inside the repository:

```sh
git fetch --tags origin
git checkout beta-NEW-TAG-HERE
git submodule update --init --recursive
npm run setup
npm run doctor
```

Then restart both local services:

```sh
npm run start:lea-api
npm start
```

## Troubleshooting

If setup or doctor fails, send Daniel:

- the command you ran
- the full terminal output
- whether you are on macOS, Windows, or Linux
- the output of:

```sh
git rev-parse --short HEAD
git -C vendor/lea-prover rev-parse --short HEAD
npm run doctor
```
