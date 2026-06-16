# LeaEcosystem

## Setup

Run the unified setup from the monorepo root:

```sh
npm run setup
```

This installs workspace Node dependencies, initializes the shared
`vendor/lea-prover` submodule, installs the bundled Lea API dependencies,
downloads and verifies the Lean/Mathlib cache, writes root `.env` defaults, and
prepares both the Overleaf companion and Lea UI.

To set up only one app:

```sh
npm run setup -- --target ui
npm run setup -- --target overleaf
```

To refresh Lean dependencies and the Mathlib cache:

```sh
npm run update-lean-deps
```

## Environment

Private runtime fields are shared through one monorepo-root `.env` file.

```sh
cp .env.example .env
```

Set provider keys, Lea paths, model settings, and timeout/spend limits there.
Shell-exported values override `.env`; older app-local files are read only as
migration fallbacks.
