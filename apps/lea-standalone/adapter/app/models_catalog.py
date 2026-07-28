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

from functools import lru_cache
from typing import Any

try:  # LiteLLM is heavy and optional — never let its absence break Settings.
    import litellm

    _AVAILABLE = True
except Exception:  # noqa: BLE001
    litellm = None  # type: ignore[assignment]
    _AVAILABLE = False

# Entries in litellm.model_cost that aren't real, selectable chat models.
_SKIP_VALUES = {"sample_spec"}


def is_available() -> bool:
    return _AVAILABLE


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


# Provider -> the env var(s) that can authenticate it, in preference order. ANY one
# of them satisfies the provider (Gemini takes either; Anthropic accepts an auth
# token in place of an API key). An explicit EMPTY tuple means "this provider is not
# authenticated by a single env var" — Vertex/Bedrock use a cloud credential chain
# and Ollama is local — so demanding a key for them would be a false rejection.
#
# This table exists because LiteLLM has no env-independent accessor for it
# (AUDIT-2026-07-24 C11). `validate_environment` answers "what is missing from
# os.environ *right now*", not "what does this model need", and
# `utils.get_provider_fields` covers exactly three providers. Anything not listed
# here falls back to LiteLLM's near-universal `<PROVIDER>_API_KEY` convention.
_PROVIDER_KEYS: dict[str, tuple[str, ...]] = {
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "azure": ("AZURE_API_KEY",),
    "azure_ai": ("AZURE_AI_API_KEY",),
    "huggingface": ("HUGGINGFACE_API_KEY", "HF_TOKEN"),
    "perplexity": ("PERPLEXITYAI_API_KEY",),
    "together_ai": ("TOGETHERAI_API_KEY",),
    "vertex_ai": (),
    "bedrock": (),
    "sagemaker": (),
    "ollama": (),
}


def provider_for(model: str) -> str | None:
    """The model's LiteLLM provider, normalized. Environment-independent."""
    if not _AVAILABLE or not model:
        return None
    try:
        provider = litellm.get_llm_provider(model)[1]
    except Exception:  # noqa: BLE001
        return None
    return _normalize_provider(str(provider)) if provider else None


def requirements_for(model: str) -> dict[str, Any]:
    """The env var name(s) a model can authenticate with, plus its provider.

    `required_keys` is the set of ACCEPTABLE env vars — any one satisfies it. It is a
    property of the model, so this function is a pure function of `model`: whether a
    key is actually configured is the caller's decision, against whatever key store it
    considers authoritative.

    That separation is the point, and it used to be broken (AUDIT-2026-07-24 C11).
    `required_keys` came from `litellm.validate_environment(model)["missing_keys"]`,
    which is computed against `os.environ` — so a key that happened to be exported in
    the shell made the list come back EMPTY, the caller's own "is it configured?"
    check had nothing to check, and `satisfied` was unconditionally true. The result
    was a guard that silently passed any model, and a function whose answer depended
    on the process it ran in (which is why its tests had to stub it out).
    """
    provider = provider_for(model)
    if provider is None:
        return {"provider": None, "required_keys": []}
    if provider in _PROVIDER_KEYS:
        required = list(_PROVIDER_KEYS[provider])
    else:
        required = [f"{provider.upper().replace('-', '_')}_API_KEY"]
    return {"provider": provider, "required_keys": required}
