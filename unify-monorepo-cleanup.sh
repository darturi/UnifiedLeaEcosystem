#!/usr/bin/env bash
#
# Untracks the per-app files made redundant by unifying config, reset, and
# .gitignore into the monorepo root. Run on macOS from the repo root:
#
#   bash unify-monorepo-cleanup.sh
#
# The code edits that make these safe to remove (unified root reset script,
# .lake/ added to root .gitignore, legacy .env/TOML fallbacks stripped from
# setup.mjs / config.py / settings.py / doctors / dev.mjs, and rewritten tests)
# are already in your working tree. This script only removes the now-dead files
# and stages the deletions.
set -euo pipefail

cd /Users/danielarturi/Developer/VIDA_Dev/LeaEcosystem

echo "==> Removing redundant per-app env/config templates"
git rm -f apps/overleaf-extension/.env.example
git rm -f apps/lea-ui/config/lea.local.example.toml

echo "==> Removing redundant per-app .gitignores (root now covers them)"
git rm -f apps/lea-ui/.gitignore
git rm -f apps/overleaf-extension/.gitignore

echo "==> Removing per-app reset scripts (logic now in scripts/reset-local-state.mjs)"
git rm -f apps/overleaf-extension/companion/reset-local-state.mjs
git rm -f apps/lea-ui/scripts/reset-local-state.mjs

echo ""
echo "Done. Review with 'git status', then verify and commit:"
echo "  npm run doctor      # expect all green, no legacy WARN"
echo "  npm test            # JS suites"
echo "  (cd apps/lea-ui/server && ./.venv/bin/python -m pytest -q)   # Python suites"
echo "  npm run reset:local -- --dry-run"
echo "  git commit -m 'Unify per-app config, reset, and gitignore into monorepo root'"
