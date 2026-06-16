from __future__ import annotations

import tomllib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse

from .env import merged_env, read_dotenv


ROOT = Path(__file__).resolve().parents[2]
MONOREPO_ROOT = ROOT.parents[1]
ROOT_ENV_PATH = MONOREPO_ROOT / ".env"
LEGACY_CONFIG_PATH = ROOT / "config" / "lea.local.toml"


@dataclass(frozen=True)
class LeaConfig:
    model: str
    max_turns: int | None
    lea_api_base_url: str
    max_spend_usd: float | None = None
    lea_api_key: str | None = None
    lea_root: Path | None = None
    lea_job_timeout_seconds: int = 900
    google_api_key: str | None = None
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    narrate_tool_steps: bool = False
    permission_tier: str = "none"
    theorem_translation_max_retries: int = 3


def load_config(path: Path | None = None, env_path: Path | None = None, environ: Mapping[str, str] | None = None) -> LeaConfig:
    config_path = path or LEGACY_CONFIG_PATH
    data: dict = {}
    if config_path.exists():
        data = tomllib.loads(config_path.read_text())
    env_file_path = env_path if env_path is not None else (ROOT_ENV_PATH if path is None else None)
    env_file_values = read_dotenv(env_file_path) if env_file_path is not None else {}
    env = merged_env(env_file_values, os.environ if environ is None else environ)
    env_data = _config_from_env(env)
    config_data = {**data, **env_data}

    env_lea_root = env.get("LEA_ROOT") if "lea_root" in env_data else None
    lea_root = config_data.get("lea_root", "../../vendor/lea-prover")
    resolved_lea_root = None
    if lea_root:
        resolved_lea_root = Path(lea_root)
        if not resolved_lea_root.is_absolute():
            resolved_lea_root = ((MONOREPO_ROOT if env_lea_root else ROOT) / resolved_lea_root).resolve()

    max_turns = config_data.get("max_turns")
    timeout = config_data.get("lea_job_timeout_seconds", 900)
    narrate_tool_steps = config_data.get("narrate_tool_steps", False)
    narrate_tool_steps = _coerce_bool(narrate_tool_steps, "narrate_tool_steps")
    if not isinstance(narrate_tool_steps, bool):
        raise ValueError("narrate_tool_steps must be a boolean")
    permission_tier = config_data.get("permission_tier", "none")
    if not isinstance(permission_tier, str):
        raise ValueError("permission_tier must be a string")
    if permission_tier not in {"none", "theorem_translation", "stepwise"}:
        raise ValueError("permission_tier must be one of: none, theorem_translation, stepwise")
    theorem_translation_max_retries = config_data.get("theorem_translation_max_retries", 3)
    theorem_translation_max_retries = _coerce_int(theorem_translation_max_retries, "theorem_translation_max_retries")
    if (
        not isinstance(theorem_translation_max_retries, int)
        or isinstance(theorem_translation_max_retries, bool)
    ):
        raise ValueError("theorem_translation_max_retries must be an integer")
    if theorem_translation_max_retries < 1:
        raise ValueError("theorem_translation_max_retries must be at least 1")
    max_spend_usd = config_data.get("max_spend_usd")
    if max_spend_usd is not None:
        max_spend_usd = float(max_spend_usd)
        if max_spend_usd < 0:
            raise ValueError("max_spend_usd must be greater than or equal to 0")

    return LeaConfig(
        model=config_data.get("model", "gemini/gemini-3.1-pro-preview"),
        max_turns=int(max_turns) if max_turns is not None else None,
        max_spend_usd=max_spend_usd,
        lea_api_base_url=_normalize_base_url(config_data.get("lea_api_base_url", "http://127.0.0.1:8000")),
        lea_api_key=config_data.get("lea_api_key"),
        lea_root=resolved_lea_root,
        lea_job_timeout_seconds=int(timeout),
        google_api_key=config_data.get("google_api_key"),
        anthropic_api_key=config_data.get("anthropic_api_key"),
        openai_api_key=config_data.get("openai_api_key"),
        openai_base_url=config_data.get("openai_base_url"),
        narrate_tool_steps=narrate_tool_steps,
        permission_tier=permission_tier,
        theorem_translation_max_retries=theorem_translation_max_retries,
    )


def _normalize_base_url(value: str) -> str:
    parsed = urlparse(str(value).strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("lea_api_base_url must be an absolute http(s) URL")
    return str(value).strip().rstrip("/")


def _config_from_env(env: Mapping[str, str]) -> dict[str, Any]:
    mappings = {
        "LEA_MODEL": "model",
        "LEA_MAX_TURNS": "max_turns",
        "LEA_MAX_SPEND_USD": "max_spend_usd",
        "LEA_API_BASE_URL": "lea_api_base_url",
        "LEA_API_KEY": "lea_api_key",
        "LEA_ROOT": "lea_root",
        "LEA_JOB_TIMEOUT_SECONDS": "lea_job_timeout_seconds",
        "GOOGLE_API_KEY": "google_api_key",
        "GEMINI_API_KEY": "google_api_key",
        "ANTHROPIC_API_KEY": "anthropic_api_key",
        "OPENAI_API_KEY": "openai_api_key",
        "OPENAI_BASE_URL": "openai_base_url",
        "LEA_NARRATE_TOOL_STEPS": "narrate_tool_steps",
        "LEA_PERMISSION_TIER": "permission_tier",
        "LEA_THEOREM_TRANSLATION_MAX_RETRIES": "theorem_translation_max_retries",
    }
    data: dict[str, Any] = {}
    for env_key, config_key in mappings.items():
        value = env.get(env_key)
        if value is not None and str(value) != "":
            if config_key in {"max_turns", "lea_job_timeout_seconds", "theorem_translation_max_retries"}:
                data[config_key] = _coerce_env_int(value, config_key)
            else:
                data[config_key] = value
    return data


def _coerce_bool(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
    raise ValueError(f"{field} must be a boolean")


def _coerce_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    if isinstance(value, int):
        return value
    raise ValueError(f"{field} must be an integer")


def _coerce_env_int(value: Any, field: str) -> int:
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value)
    return _coerce_int(value, field)
