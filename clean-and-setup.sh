#!/usr/bin/env bash
#
# Full clean slate + unified setup for LeaEcosystem (both apps).
# Removes old infrastructure, then re-runs the new monorepo setup.
# Your root .env (with API key) is backed up and preserved.
#
# Run on macOS from the repo root:  bash clean-and-setup.sh
#
set -euo pipefail

ROOT="/Users/danielarturi/Developer/VIDA_Dev/LeaEcosystem"
cd "$ROOT"

echo "==> Backing up root .env (API key) to /tmp/lea-root-env.backup"
cp .env /tmp/lea-root-env.backup

echo "==> 1/7 Removing Node dependencies"
rm -rf node_modules apps/lea-ui/node_modules

echo "==> 2/7 Removing Python virtualenvs"
rm -rf vendor/lea-prover/.venv apps/lea-ui/server/.venv

echo "==> 3/7 Removing Lean/Mathlib build cache (~7.3 GB)"
rm -rf vendor/lea-prover/workspace/.lake

echo "==> 4/7 Removing generated Overleaf companion run state"
rm -rf apps/overleaf-extension/.overleaf-lean-stub/jobs \
       apps/overleaf-extension/.overleaf-lean-stub/backups \
       apps/overleaf-extension/.overleaf-lean-stub/cache.json \
       apps/overleaf-extension/.overleaf-lean-stub/jobs.json \
       apps/overleaf-extension/.overleaf-lean-stub/settings.json

echo "==> 5/7 Removing Lea workspace generated artifacts"
rm -rf vendor/lea-prover/workspace/projects/* \
       vendor/lea-prover/workspace/proofs/* \
       vendor/lea-prover/workspace/context/overleaf/* 2>/dev/null || true

echo "==> 6/7 Removing Lea UI local data (sqlite + events)"
rm -rf apps/lea-ui/data/lea-interface.sqlite3 apps/lea-ui/data/lea-api-events

echo "==> 7/7 Removing legacy app-local config (duplicates of root .env)"
rm -f apps/overleaf-extension/.env
rm -f apps/lea-ui/config/lea.local.toml

echo ""
echo "==> Old infrastructure cleared. Root .env preserved:"
grep -c '^OPENAI_API_KEY=sk-' .env >/dev/null && echo "    OPENAI_API_KEY still present in root .env"
echo ""
echo "==> Running unified setup for BOTH apps (this re-downloads Mathlib; slow)"
npm run setup

echo ""
echo "==> Running doctor"
npm run doctor

echo ""
echo "Clean slate setup complete. Next: start services and load the extension."
