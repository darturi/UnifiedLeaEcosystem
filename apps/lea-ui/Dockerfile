# syntax=docker/dockerfile:1

# =============================================================================
# Lea Interface — self-contained image (frontend + UI adapter + bundled Lea API
# + Lean 4 + Mathlib). Built for linux/arm64 (Apple Silicon Macs).
#
# Build:  docker buildx build --platform linux/arm64 -f apps/lea-ui/Dockerfile -t lea-interface:local --load .
# Run:    docker compose up
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: build the React frontend into static assets (dist/)
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /web

COPY apps/lea-ui/package.json apps/lea-ui/package-lock.json ./
RUN npm ci

# Only the files the Vite build actually reads (keeps this layer small + cacheable).
COPY apps/lea-ui/index.html apps/lea-ui/vite.config.ts apps/lea-ui/postcss.config.mjs ./
COPY apps/lea-ui/src ./src
RUN npm run build   # -> /web/dist

# -----------------------------------------------------------------------------
# Stage 2: runtime — Python 3.13 + uv (base), plus Lean toolchain and Mathlib
# -----------------------------------------------------------------------------
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS runtime

# System packages: git (lake fetches Mathlib), curl/ca-certificates (elan +
# health checks), libgmp10 (Lean runtime dependency).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates libgmp10 \
 && rm -rf /var/lib/apt/lists/*

# Install the Lean toolchain manager (elan) and pin the project's Lean version.
ENV ELAN_HOME=/root/.elan
ENV PATH="/root/.elan/bin:${PATH}"
RUN curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh \
 && sh /tmp/elan-init.sh -y --default-toolchain leanprover/lean4:v4.29.0 \
 && rm /tmp/elan-init.sh \
 && lean --version

WORKDIR /app

# --- Bundled Lea agent + API (the submodule) -------------------------------
# Copy the submodule first so the expensive Mathlib bake is its own cache layer.
COPY vendor/lea-prover ./vendor/lea-prover

# Bake Mathlib: download the prebuilt oleans (multi-GB). `lake exe cache get`
# resolves dependencies (clones Mathlib) and downloads the prebuilt cache
# instead of compiling Mathlib from source.
#
# NOTE: we do NOT run `lake build` here. The workspace's @[default_target] is
# `lean_lib Lea` rooted at proofs/, which the agent populates at runtime — at
# build time proofs/ is empty so `lake build` fails on a missing proofs/Lea.lean.
# We only need Mathlib's oleans, so we just fetch the cache and verify it landed.
WORKDIR /app/vendor/lea-prover/workspace
RUN lake exe cache get \
 && test -n "$(ls -A .lake/packages/mathlib/.lake/build/lib 2>/dev/null)" \
 && echo "[build] Mathlib oleans present" \
 && rm -rf .lake/packages/*/.git \
 && rm -rf /root/.cache/mathlib \
 && echo "[build] removed dependency .git histories + compressed cache (~1GB)"

# Python deps for the agent + Lea API (creates vendor/lea-prover/.venv).
WORKDIR /app/vendor/lea-prover
RUN uv sync --extra api

# --- UI adapter (FastAPI) ---------------------------------------------------
WORKDIR /app/server
COPY apps/lea-ui/server ./
RUN uv sync   # creates /app/server/.venv

# --- Built frontend + entrypoint -------------------------------------------
COPY --from=web /web/dist /app/dist
COPY apps/lea-ui/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /app

# Defaults that make the adapter and Lea API agree on paths/URLs in-container.
# Provider key + model come from the runtime environment; local development uses
# the monorepo root .env.
ENV PYTHONUNBUFFERED=1 \
    LEA_API_BASE_URL=http://127.0.0.1:8000 \
    LEA_ROOT=/app/vendor/lea-prover \
    LEA_WEB_DIST=/app/dist \
    LEA_MODEL=gemini/gemini-3.1-pro-preview

EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8001/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
