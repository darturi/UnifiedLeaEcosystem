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
MODEL_OPTIONS = [
    {"value": "gpt-4o", "label": "GPT-4o", "family": "openai"},
    {"value": "gpt-4o-mini", "label": "GPT-4o Mini", "family": "openai"},
    {"value": "gpt-4-turbo", "label": "GPT-4 Turbo", "family": "openai"},
    {"value": "claude-opus-4-7", "label": "Claude Opus 4.7", "family": "anthropic"},
    {"value": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "family": "anthropic"},
    {"value": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "family": "anthropic"},
    {"value": "gemini-2.0-flash", "label": "Gemini 2.0 Flash", "family": "google"},
    {"value": "gemini-1.5-pro", "label": "Gemini 1.5 Pro", "family": "google"},
    {"value": "gemini/gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro Preview", "family": "google"},
]
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
    if path.suffix == ".toml":
        return load_config(path)
    return load_config(env_path=path)


def _write_config_updates(path: Path, updates: dict[str, Any]) -> None:
    if path.suffix == ".toml":
        _write_toml_updates(path, updates)
        return
    patch_dotenv(
        path,
        {
            CONFIG_ENV_FIELDS[key]: value
            for key, value in updates.items()
            if key in CONFIG_ENV_FIELDS
        },
    )


def _write_toml_updates(path: Path, updates: dict[str, Any]) -> None:
    if not updates:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text().splitlines() if path.exists() else []
    updated_keys: set[str] = set()
    key_pattern = re.compile(r"^(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*)$")
    table_pattern = re.compile(r"^\s*\[[^\]]+\]\s*(#.*)?$")
    next_lines: list[str] = []
    in_root = True
    first_table_index: int | None = None

    for line in lines:
        if table_pattern.match(line):
            in_root = False
            if first_table_index is None:
                first_table_index = len(next_lines)
        match = key_pattern.match(line)
        if in_root and match and match.group(2) in updates:
            key = match.group(2)
            updated_keys.add(key)
            value = updates[key]
            if value is None:
                continue
            next_lines.append(f"{match.group(1)}{key}{match.group(3)}{_toml_scalar(value)}")
        else:
            next_lines.append(line)

    missing_lines = [
        f"{key} = {_toml_scalar(updates[key])}"
        for key in updates
        if key not in updated_keys and updates[key] is not None
    ]
    if missing_lines:
        if first_table_index is None:
            if next_lines and next_lines[-1].strip():
                next_lines.append("")
            next_lines.extend(missing_lines)
        else:
            insertion = list(missing_lines)
            if first_table_index > 0 and next_lines[first_table_index - 1].strip():
                insertion.insert(0, "")
            if first_table_index < len(next_lines) and next_lines[first_table_index].strip():
                insertion.append("")
            next_lines[first_table_index:first_table_index] = insertion

    path.write_text("\n".join(next_lines).rstrip() + "\n")


def _toml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(value)
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'
