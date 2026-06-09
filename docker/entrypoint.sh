#!/usr/bin/env bash
# Starts the bundled Lea API (internal :8000) and the UI adapter (:8001), which
# also serves the built frontend.
#
# No API key is needed to start. The container boots keyless; the user adds and
# validates their key in the app's Settings pane, which saves it to
# /app/config/lea.local.toml (mounted as a volume so it persists). The adapter
# forwards that key to the Lea API per run.
set -euo pipefail

api_pid=""
cleanup() { [ -n "$api_pid" ] && kill "$api_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[lea] starting Lea API on 127.0.0.1:8000 ..."
( cd /app/external/lea-prover \
  && LEA_API_HOST=127.0.0.1 LEA_API_PORT=8000 .venv/bin/python -m lea_api ) &
api_pid=$!

echo "[lea] waiting for Lea API to become healthy ..."
ready=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8000/v1/healthz >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "[lea] ERROR: Lea API exited during startup." >&2
    exit 1
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "[lea] ERROR: Lea API did not become healthy in time." >&2
  exit 1
fi
echo "[lea] Lea API ready."

echo "[lea] starting UI on http://localhost:8001"
echo "[lea] open it, then add your API key in Settings (no key needed to start)."
cd /app/server
exec .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8001
