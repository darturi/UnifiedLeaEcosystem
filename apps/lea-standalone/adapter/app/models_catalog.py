"""LiteLLM-backed model catalog + per-model API-key requirements.

This powers two things in Settings:
  1. The searchable model picker — the full LiteLLM catalog (~2k chat models
     across ~76 providers), not just a curated shortlist.
  2. The dynamic API-key prompt — which env var(s) a chosen model needs, so the
     API Keys section can surface the right field (OpenAI, Anthropic, Gemini,
     HuggingFace, Mistral, …) on demand.

All LiteLLM access is isolated in this module and degrades gracefully if
LiteLLM can't be imported, so the rest of the adapter never hard-depends on it
(the curated MODEL_OPTIONS in settings.py remain the fallback).
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

logger = logging.getLogger("lea-interface.models")

# F3: why the catalog is unavailable, when it is. Graceful degradation is right —
# Settings must still open — but degrading *silently* means the picker shows a
# curated fallback list that looks authoritative, and the per-model key prompt
# quietly stops warning about missing keys. The reason is kept so the API can say so.
_UNAVAILABLE_REASON: str | None = None

try:  # LiteLLM is heavy and optional — never let its absence break Settings.
    import litellm

    _AVAILABLE = True
except Exception as _exc:  # noqa: BLE001
    litellm = None  # type: ignore[assignment]
    _AVAILABLE = False
    _UNAVAILABLE_REASON = f"{type(_exc).__name__}: {_exc}"
    logger.warning("LiteLLM unavailable; model catalog falls back to the curated list: %s",
                   _UNAVAILABLE_REASON)

# Entries in litellm.model_cost that aren't real, selectable chat models.
_SKIP_VALUES = {"sample_spec"}


def is_available() -> bool:
    return _AVAILABLE


def unavailable_reason() -> str | None:
    """Why the LiteLLM catalog isn't loaded, or None when it is (F3)."""
    return _UNAVAILABLE_REASON


@lru_cache(maxsize=1)
def list_chat_models() -> list[dict[str, str]]:
    """Every chat-capable model in the LiteLLM catalog as {value, label, provider}."""
    if not _AVAILABLE:
        return []
    models: list[dict[str, str]] = []
    for value, spec in litellm.model_cost.items():
        if value in _SKIP_VALUES or not isinstance(spec, dict):
            continue
        if spec.get("mode") != "chat":
            continue
        models.append(
            {
                "value": value,
                "label": value,
                "provider": _normalize_provider(str(spec.get("litellm_provider") or "")),
            }
        )
    models.sort(key=lambda m: (m["provider"], m["value"]))
    return models


def _normalize_provider(provider: str) -> str:
    # Fold LiteLLM's chat/variant suffixes (cohere_chat, bedrock_converse) so the
    # UI shows one stable provider label per vendor.
    return provider.replace("_chat", "").replace("_converse", "")


def requirements_for(model: str) -> dict[str, Any]:
    """The env var name(s) a model can authenticate with, plus its provider.

    `required_keys` is the set of acceptable env vars (any one satisfies it —
    e.g. Gemini accepts GOOGLE_API_KEY or GEMINI_API_KEY). Whether one is
    actually configured is decided by the caller against the saved keys, not the
    adapter's own process environment.
    """
    if not _AVAILABLE or not model:
        return {"provider": None, "required_keys": []}
    try:
        provider = litellm.get_llm_provider(model)[1]
    except Exception:  # noqa: BLE001
        logger.warning("Could not resolve the provider for model %r", model, exc_info=True)
        provider = None
    try:
        info = litellm.validate_environment(model)
        required = [str(k) for k in (info.get("missing_keys") or []) if str(k).strip()]
    except Exception:  # noqa: BLE001
        # F3: an empty `required` reads downstream as "this model needs no key", so
        # Settings stops prompting for one and the run fails later with an auth error
        # instead. The caller falls back to the family map; this is why.
        logger.warning("Could not resolve required keys for model %r", model, exc_info=True)
        required = []
    return {
        "provider": _normalize_provider(str(provider)) if provider else None,
        "required_keys": required,
    }
