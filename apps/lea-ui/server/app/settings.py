from __future__ import annotations

import re
import socket
import urllib.error
import urllib.request
import json
import ssl
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import ROOT_ENV_PATH, LeaConfig, load_config
from .env import patch_dotenv
from . import store
from .model_catalog import model_options


CONFIG_PATH = ROOT_ENV_PATH
PERMISSION_TIERS = {"none", "theorem_translation", "stepwise"}
API_KEY_FIELDS = {
    "openai": "openai_api_key",
    "anthropic": "anthropic_api_key",
    "google": "google_api_key",
}
CONFIG_ENV_FIELDS = {
    "model": "LEA_MODEL",
    "max_turns": "LEA_MAX_TURNS",
    "max_spend_usd": "LEA_MAX_SPEND_USD",
    "permission_tier": "LEA_PERMISSION_TIER",
    "theorem_translation_max_retries": "LEA_THEOREM_TRANSLATION_MAX_RETRIES",
    "openai_api_key": "OPENAI_API_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "google_api_key": "GEMINI_API_KEY",
}
PROVIDER_LABELS = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
}
MODEL_OPTIONS = model_options()
MODEL_FAMILY_BY_VALUE = {str(option["value"]): str(option["family"]) for option in MODEL_OPTIONS}
KEY_VALIDATORS = {
    "openai": re.compile(r"^sk-[A-Za-z0-9_-]{8,}$"),
    "anthropic": re.compile(r"^sk-ant-.+"),
    "google": re.compile(r"^AIza[A-Za-z0-9_-]{20,}$"),
}


class SettingsValidationError(ValueError):
    def __init__(self, message: str, field: str | None = None):
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class ApiKeyUpdate:
    value: str | None = None
    clear: bool = False


def settings_payload(path: Path | None = None) -> dict[str, Any]:
    config = _load_settings_config(path)
    stats = store.usage_stats()
    return {
        "model": config.model,
        "max_turns": config.max_turns,
        "max_spend_usd": config.max_spend_usd,
        "permission_tier": config.permission_tier,
        "theorem_translation_max_retries": config.theorem_translation_max_retries,
        "current_spend_usd": float(stats["global"]["cost_usd"]),
        "api_keys": {
            family: _masked_key(getattr(config, field))
            for family, field in API_KEY_FIELDS.items()
        },
        "model_options": MODEL_OPTIONS,
        "permission_tiers": [
            {"value": "none", "label": "Fully autonomous"},
            {"value": "theorem_translation", "label": "Approve theorem formalization"},
            {"value": "stepwise", "label": "Approve each agent step"},
        ],
    }


def update_settings(values: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    config_path = path or CONFIG_PATH
    current_config = _load_settings_config(config_path)
    updates: dict[str, Any] = {}

    if "model" in values and values["model"] is not None:
        model = str(values["model"]).strip()
        if not model:
            raise ValueError("model must not be empty")
        if model not in MODEL_FAMILY_BY_VALUE:
            raise ValueError("model must be one of the supported models")
        updates["model"] = model

    if "permission_tier" in values and values["permission_tier"] is not None:
        permission_tier = str(values["permission_tier"])
        if permission_tier not in PERMISSION_TIERS:
            raise ValueError("permission_tier must be one of: none, theorem_translation, stepwise")
        updates["permission_tier"] = permission_tier

    if "theorem_translation_max_retries" in values:
        theorem_translation_max_retries = values["theorem_translation_max_retries"]
        if (
            not isinstance(theorem_translation_max_retries, int)
            or isinstance(theorem_translation_max_retries, bool)
        ):
            raise ValueError("theorem_translation_max_retries must be an integer")
        if theorem_translation_max_retries < 1:
            raise ValueError("theorem_translation_max_retries must be at least 1")
        updates["theorem_translation_max_retries"] = theorem_translation_max_retries

    if "max_turns" in values:
        max_turns = values["max_turns"]
        if max_turns is None:
            updates["max_turns"] = None
        else:
            max_turns_int = int(max_turns)
            if max_turns_int < 1:
                raise ValueError("max_turns must be at least 1")
            updates["max_turns"] = max_turns_int

    if "max_spend_usd" in values:
        max_spend_usd = values["max_spend_usd"]
        if max_spend_usd is None:
            updates["max_spend_usd"] = None
        else:
            max_spend_float = float(max_spend_usd)
            if max_spend_float < 0:
                raise ValueError("max_spend_usd must be greater than or equal to 0")
            updates["max_spend_usd"] = max_spend_float

    api_key_updates = values.get("api_keys") or {}
    if not isinstance(api_key_updates, dict):
        raise ValueError("api_keys must be an object")
    for family, field in API_KEY_FIELDS.items():
        raw_update = api_key_updates.get(family)
        if raw_update is None:
            continue
        if not isinstance(raw_update, dict):
            raise ValueError(f"api_keys.{family} must be an object")
        if raw_update.get("clear"):
            updates[field] = None
            continue
        value = raw_update.get("value")
        if value is not None:
            value = str(value).strip()
            if value:
                _validate_api_key_format(family, value)
                _verify_api_key_credentials(
                    family,
                    value,
                    current_config,
                    str(updates.get("model", current_config.model)),
                )
                updates[field] = value

    _validate_selected_model_has_key(current_config, updates)
    _write_config_updates(config_path, updates)
    return settings_payload(config_path)


def current_spend_usd() -> float:
    return float(store.usage_stats()["global"]["cost_usd"])


def spend_limit_reached(max_spend_usd: float | None, pending_cost_usd: float | None = None) -> bool:
    if max_spend_usd is None:
        return False
    return current_spend_usd() + float(pending_cost_usd or 0) >= float(max_spend_usd)


def _masked_key(value: str | None) -> dict[str, Any]:
    if not value:
        return {"configured": False, "last4": None}
    return {"configured": True, "last4": value[-4:] if len(value) >= 4 else value}


def _validate_selected_model_has_key(config: LeaConfig, updates: dict[str, Any]) -> None:
    model = str(updates.get("model", config.model))
    family = _model_family(model)
    if family is None:
        return
    field = API_KEY_FIELDS[family]
    key = updates[field] if field in updates else getattr(config, field)
    if not key:
        raise SettingsValidationError(
            f"An API key for {_provider_label(family)} is required before saving this model.",
            f"api_keys.{family}",
        )
    _validate_api_key_format(family, str(key))


def _model_family(model: str) -> str | None:
    if model in MODEL_FAMILY_BY_VALUE:
        return MODEL_FAMILY_BY_VALUE[model]
    normalized = model.lower()
    if normalized.startswith(("gpt-", "o1", "o3", "o4", "openai/")):
        return "openai"
    if normalized.startswith(("claude-", "anthropic/")):
        return "anthropic"
    if normalized.startswith(("gemini", "google/")):
        return "google"
    return None


def _validate_api_key_format(family: str, value: str) -> None:
    validator = KEY_VALIDATORS.get(family)
    if validator and not validator.match(value):
        raise SettingsValidationError(
            f"The {_provider_label(family)} API key does not look valid. Check the key and try again.",
            f"api_keys.{family}",
        )


def _verify_api_key_credentials(
    family: str,
    value: str,
    config: LeaConfig,
    model: str | None = None,
) -> None:
    request = _provider_verification_request(family, value, config, model)
    if request is None:
        return
    try:
        with urllib.request.urlopen(request, timeout=6, context=_ssl_context()) as response:
            if response.status >= 400:
                raise SettingsValidationError(
                    f"Could not verify the {_provider_label(family)} API key.",
                    f"api_keys.{family}",
                )
    except urllib.error.HTTPError as exc:
        detail = _http_error_detail(exc)
        if exc.code in {401, 403}:
            raise SettingsValidationError(
                _provider_auth_error_message(family, detail),
                f"api_keys.{family}",
            ) from exc
        if family == "anthropic" and _looks_like_model_error(detail):
            raise SettingsValidationError(
                f"Anthropic rejected the selected model: {detail}",
                "model",
            ) from exc
        raise SettingsValidationError(
            f"Could not verify the {_provider_label(family)} API key. Provider returned HTTP {exc.code}: {detail}",
            f"api_keys.{family}",
        ) from exc
    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        raise SettingsValidationError(
            f"Could not verify the {_provider_label(family)} API key. Check your connection and try again.",
            f"api_keys.{family}",
        ) from exc


def _provider_verification_request(
    family: str,
    value: str,
    config: LeaConfig,
    model: str | None = None,
) -> urllib.request.Request | None:
    if family == "openai":
        base_url = (config.openai_base_url or "https://api.openai.com/v1").rstrip("/")
        return urllib.request.Request(
            f"{base_url}/models",
            headers={"Authorization": f"Bearer {value}"},
            method="GET",
        )
    if family == "anthropic":
        body = json.dumps(
            {
                "model": _anthropic_verification_model(model),
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "ping"}],
            }
        ).encode("utf-8")
        return urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "x-api-key": value,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            method="POST",
        )
    if family == "google":
        return urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models?key={value}",
            method="GET",
        )
    return None


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _anthropic_verification_model(model: str | None) -> str:
    if model and _model_family(model) == "anthropic":
        return model
    return "claude-sonnet-4-6"


def _http_error_detail(exc: urllib.error.HTTPError) -> str:
    raw = exc.read().decode("utf-8", errors="replace").strip()
    if not raw:
        return exc.reason or "no response body"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw[:500]
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(error, dict):
        message = error.get("message")
        error_type = error.get("type")
        if message and error_type:
            return f"{error_type}: {message}"
        if message:
            return str(message)
    return raw[:500]


def _provider_auth_error_message(family: str, detail: str) -> str:
    if detail and detail != "no response body":
        return f"The {_provider_label(family)} API key was rejected by the provider: {detail}"
    return f"The {_provider_label(family)} API key was rejected by the provider."


def _looks_like_model_error(detail: str) -> bool:
    normalized = detail.lower()
    return "model" in normalized and (
        "not found" in normalized
        or "does not exist" in normalized
        or "invalid" in normalized
        or "not supported" in normalized
    )


def _provider_label(family: str) -> str:
    return PROVIDER_LABELS.get(family, family.title())


def _load_settings_config(path: Path | None = None) -> LeaConfig:
    if path is None:
        return load_config()
    return load_config(env_path=path)


def _write_config_updates(path: Path, updates: dict[str, Any]) -> None:
    patch_dotenv(
        path,
        {
            CONFIG_ENV_FIELDS[key]: value
            for key, value in updates.items()
            if key in CONFIG_ENV_FIELDS
        },
    )
