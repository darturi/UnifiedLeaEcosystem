#!/usr/bin/env bash
#
# Return the working tree to the state of a fresh `git clone --recurse-submodules`:
# removes every generated / installed artifact (node deps, Python venvs, the Lean
# build cache, local run state) and the gitignored root .env. The committed source
# and the lea-prover submodule checkout are left intact.
#
# Your current .env is backed up to /tmp first, so the API key is recoverable.
#
# Run on macOS from the repo root:  bash reset-to-clean.sh
set -euo pipefail

cd /Users/danielarturi/Developer/VIDA_Dev/LeaEcosystem

if [ -f .env ]; then
  cp .env /tmp/lea-root-env.backup
  echo "==> Backed up .env to /tmp/lea-root-env.backup"
fi

echo "==> Removing Node dependencies"
rm -rf node_modules apps/lea-ui/node_modules

echo "==> Removing Python virtualenvs"
rm -rf vendor/lea-prover/.venv apps/lea-ui/server/.venv

echo "==> Removing Lean/Mathlib build cache (~7.3 GB)"
rm -rf vendor/lea-prover/workspace/.lake

echo "==> Removing generated Overleaf companion run state"
rm -rf apps/overleaf-extension/.overleaf-lean-stub

echo "==> Removing Lea workspace generated artifacts"
rm -rf vendor/lea-prover/workspace/projects/* \
       vendor/lea-prover/workspace/proofs/* \
       vendor/lea-prover/workspace/context/overleaf/* 2>/dev/null || true

echo "==> Removing Lea UI local data (SQLite + events)"
rm -rf apps/lea-ui/data

echo "==> Removing root .env (recreated by setup from .env.example)"
rm -f .env

echo ""
echo "Working tree is now at fresh-clone state."
echo "Next: npm run setup"
