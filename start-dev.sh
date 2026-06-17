#!/usr/bin/env bash
#
# Start the whole Lea dev stack:
#   - standalone UI: FastAPI adapter (:8001) + Vite frontend (:5173)  [npm run dev:ui]
#   - Overleaf companion (:31245)                                     [npm run dev:overleaf]
#
# By default this first clears ALL previous session data (the adapter SQLite DB —
# sessions/runs/code steps — plus proof files, project entries, and companion job
# logs) via `npm run reset:local`, so you start from a clean slate.
#
# Pass --keep-data (or -k) to start WITHOUT clearing anything.
#
# Stop everything with Ctrl+C.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

KEEP_DATA=0
for arg in "$@"; do
  case "$arg" in
    -k|--keep-data) KEEP_DATA=1 ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--keep-data|-k]"
      echo "  (default)        clear previous session data, then start everything"
      echo "  --keep-data, -k  keep previous session data"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $(basename "$0") [--keep-data|-k]" >&2
      exit 1
      ;;
  esac
done

# Reset must happen BEFORE the adapter starts — it deletes the SQLite file, and
# the adapter recreates it (with the current schema) on startup.
if [[ "$KEEP_DATA" -eq 1 ]]; then
  echo "[start] Keeping previous session data (reset skipped)."
else
  echo "[start] Clearing previous session data..."
  npm run reset:local
fi

pids=()
cleaned_up=0
cleanup() {
  [[ "$cleaned_up" -eq 1 ]] && return
  cleaned_up=1
  echo
  echo "[start] Shutting down..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM

echo "[start] Starting UI (adapter :8001 + frontend :5173)..."
npm run dev:ui &
pids+=($!)

echo "[start] Starting Overleaf companion (:31245)..."
npm run dev:overleaf &
pids+=($!)

echo "[start] All processes launched. Press Ctrl+C to stop."

# If any child exits, tear the rest down too. (Portable poll — avoids `wait -n`,
# which needs bash 4+, while macOS still ships bash 3.2.)
while :; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      cleanup
      exit 0
    fi
  done
  sleep 1
done
