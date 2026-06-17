#!/usr/bin/env bash
#
# Reset generated logs & formalizations back to fresh-setup state.
#
# Removes only the runtime artifacts that accumulate as you use the apps —
# generated proofs/formalizations, Overleaf companion job logs + state, and the
# local SQLite database. Everything that "npm run setup" produces (node deps,
# Python .venv, the Lean/Mathlib .lake build cache) and your root .env are left
# UNTOUCHED, so this leaves you exactly where you'd be right after setup, with
# no slow Mathlib re-download.
#
# All targets are gitignored; committed source is never touched.
#
# Usage (from anywhere):
#   bash reset-logs-and-formalizations.sh            # asks for confirmation
#   bash reset-logs-and-formalizations.sh --dry-run  # show what would be removed
#   bash reset-logs-and-formalizations.sh --yes      # skip the confirmation prompt
#
set -euo pipefail

# Resolve repo root from this script's location, so it works from any cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- Paths (current monorepo layout) ---------------------------------------
PROVER_WS="apps/lea-standalone/prover/workspace"
PROOFS_DIR="$PROVER_WS/proofs"           # generated Lean formalizations (per-run UUID dirs)
PROJECTS_DIR="$PROVER_WS/projects"        # generated project scaffolds (if present)
OVERLEAF_CTX="$PROVER_WS/context/overleaf"

COMPANION_DIR="apps/overleaf-extension/.overleaf-lean-stub"
COMPANION_JOBS="$COMPANION_DIR/jobs"      # per-run *.log files
COMPANION_BACKUPS="$COMPANION_DIR/backups"
COMPANION_JOBS_INDEX="$COMPANION_DIR/jobs.json"
COMPANION_CACHE="$COMPANION_DIR/cache.json"

DB_DIR="apps/lea-standalone/data"
# Match the sqlite db plus any -journal/-wal/-shm sidecars.
DB_GLOBS=("$DB_DIR"/*.sqlite3 "$DB_DIR"/*.sqlite3-* "$DB_DIR"/*.sqlite "$DB_DIR"/*.db)

say()  { printf '%s\n' "$*"; }
note() { printf '  %s %s\n' "$1" "$2"; }

count_entries() { # count children of a dir, excluding .gitkeep
  local d="$1"
  [ -d "$d" ] || { echo 0; return; }
  find "$d" -mindepth 1 -maxdepth 1 ! -name .gitkeep | wc -l | tr -d ' '
}

# --- Summary ----------------------------------------------------------------
say "Repo: $ROOT"
say ""
say "Will clear (generated runtime state — all gitignored):"
note "•" "Formalizations/proofs:   $PROOFS_DIR ($(count_entries "$PROOFS_DIR") item(s))"
note "•" "Generated projects:      $PROJECTS_DIR ($(count_entries "$PROJECTS_DIR") item(s))"
note "•" "Overleaf LaTeX context:  $OVERLEAF_CTX"
note "•" "Companion job logs:      $COMPANION_JOBS ($(count_entries "$COMPANION_JOBS") log(s))"
note "•" "Companion backups:       $COMPANION_BACKUPS"
note "•" "Companion index/cache:   $COMPANION_JOBS_INDEX, $COMPANION_CACHE  (reset to {})"
note "•" "Local SQLite database:   $DB_DIR/*.sqlite3"
say ""
say "Will KEEP: node_modules, Python .venv, Lean .lake build cache, and .env"
say ""

if [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] No files will be deleted."
elif [ "$ASSUME_YES" -eq 0 ]; then
  read -r -p "Proceed with deletion? [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) say "Aborted."; exit 1 ;;
  esac
fi
say ""

# --- Helpers (respect dry-run) ---------------------------------------------
clear_dir_contents() { # remove children of dir, keep the dir + any .gitkeep
  local label="$1" d="$2"
  if [ ! -d "$d" ]; then note "skip" "$label (not present)"; return; fi
  local n; n="$(count_entries "$d")"
  if [ "$n" -eq 0 ]; then note "ok" "$label already empty"; return; fi
  if [ "$DRY_RUN" -eq 1 ]; then note "would clear" "$label ($n item(s))"; return; fi
  find "$d" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
  note "cleared" "$label ($n item(s))"
}

remove_dir() { # remove a dir entirely
  local label="$1" d="$2"
  if [ ! -e "$d" ]; then note "skip" "$label (not present)"; return; fi
  if [ "$DRY_RUN" -eq 1 ]; then note "would remove" "$label"; return; fi
  rm -rf "$d"
  note "removed" "$label"
}

reset_json() { # overwrite a json file with {}
  local label="$1" f="$2"
  if [ "$DRY_RUN" -eq 1 ]; then note "would reset" "$label -> {}"; return; fi
  mkdir -p "$(dirname "$f")"
  printf '{}\n' > "$f"
  note "reset" "$label -> {}"
}

remove_glob() { # remove files matching given paths (globs already expanded by caller)
  local label="$1"; shift
  local found=0
  for f in "$@"; do
    [ -e "$f" ] || continue
    found=1
    if [ "$DRY_RUN" -eq 1 ]; then note "would remove" "$f"; else rm -f "$f"; note "removed" "$f"; fi
  done
  [ "$found" -eq 0 ] && note "skip" "$label (none present)"
  return 0
}

# --- Do the work ------------------------------------------------------------
clear_dir_contents "proofs/formalizations" "$PROOFS_DIR"
clear_dir_contents "generated projects"    "$PROJECTS_DIR"
remove_dir         "Overleaf LaTeX context" "$OVERLEAF_CTX"
remove_dir         "companion job logs"     "$COMPANION_JOBS"
remove_dir         "companion backups"      "$COMPANION_BACKUPS"
reset_json         "companion job index"    "$COMPANION_JOBS_INDEX"
reset_json         "companion cache"        "$COMPANION_CACHE"
remove_glob        "local SQLite database"  "${DB_GLOBS[@]}"

# Recreate the empty dirs the apps expect on next run.
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$PROOFS_DIR" "$PROJECTS_DIR" "$COMPANION_JOBS" "$DB_DIR"
fi

say ""
if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run complete — nothing was deleted."
else
  say "Done. Logs & formalizations cleared; repo is back to fresh-setup state."
fi
