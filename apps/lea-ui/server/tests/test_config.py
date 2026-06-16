from pathlib import Path

import pytest

from app.config import load_config


def test_load_config_defaults_to_local_lea_api(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text("")

    config = load_config(config_path, environ={})

    assert config.lea_api_base_url == "http://127.0.0.1:8000"
    assert config.model == "gemini/gemini-3.1-pro-preview"
    assert config.max_turns is None
    assert config.max_spend_usd is None
    assert config.lea_api_key is None
    assert config.lea_root == Path(__file__).resolve().parents[4] / "vendor" / "lea-prover"
    assert config.narrate_tool_steps is False
    assert config.permission_tier == "none"
    assert config.theorem_translation_max_retries == 3


def test_load_config_honors_api_settings(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        lea_api_base_url = "http://localhost:8123/"
        lea_api_key = "test-key"
        model = "o4-mini"
        max_turns = 7
        max_spend_usd = 12.5
        lea_job_timeout_seconds = 45
        lea_root = "../../vendor/lea-prover"
        google_api_key = "google-secret"
        anthropic_api_key = "anthropic-secret"
        openai_api_key = "openai-secret"
        openai_base_url = "https://openai.example/v1"
        narrate_tool_steps = true
        permission_tier = "stepwise"
        theorem_translation_max_retries = 5
        """
    )

    config = load_config(config_path, environ={})

    assert config.lea_api_base_url == "http://localhost:8123"
    assert config.lea_api_key == "test-key"
    assert config.model == "o4-mini"
    assert config.max_turns == 7
    assert config.max_spend_usd == 12.5
    assert config.lea_job_timeout_seconds == 45
    assert isinstance(config.lea_root, Path)
    assert config.lea_root.name == "lea-prover"
    assert config.google_api_key == "google-secret"
    assert config.anthropic_api_key == "anthropic-secret"
    assert config.openai_api_key == "openai-secret"
    assert config.openai_base_url == "https://openai.example/v1"
    assert config.narrate_tool_steps is True
    assert config.permission_tier == "stepwise"
    assert config.theorem_translation_max_retries == 5


def test_load_config_rejects_invalid_api_base_url(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text('lea_api_base_url = "file:///tmp/lea"\n')

    with pytest.raises(ValueError, match="lea_api_base_url"):
        load_config(config_path, environ={})


def test_load_config_rejects_non_boolean_narration_flag(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text('narrate_tool_steps = "maybe"\n')

    with pytest.raises(ValueError, match="narrate_tool_steps"):
        load_config(config_path, environ={})


def test_load_config_rejects_invalid_permission_tier(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text('permission_tier = "ask_everything"\n')

    with pytest.raises(ValueError, match="permission_tier"):
        load_config(config_path, environ={})


@pytest.mark.parametrize(
    "value",
    ["0", "-1", "true", "1.5", '"3"'],
)
def test_load_config_rejects_invalid_theorem_translation_retries(tmp_path, value):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(f"theorem_translation_max_retries = {value}\n")

    with pytest.raises(ValueError, match="theorem_translation_max_retries"):
        load_config(config_path, environ={})


def test_load_config_rejects_negative_max_spend(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text("max_spend_usd = -1\n")

    with pytest.raises(ValueError, match="max_spend_usd"):
        load_config(config_path, environ={})


def test_load_config_uses_root_env_over_legacy_toml_and_shell_over_env(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    env_path = tmp_path / ".env"
    config_path.write_text(
        """
        model = "legacy-model"
        max_turns = 3
        openai_api_key = "legacy-openai"
        lea_root = "../../vendor/lea-prover"
        """
    )
    env_path.write_text(
        """
        LEA_MODEL=o4-mini
        LEA_MAX_TURNS=7
        OPENAI_API_KEY=env-openai
        LEA_ROOT=vendor/lea-prover
        LEA_NARRATE_TOOL_STEPS=true
        LEA_PERMISSION_TIER=theorem_translation
        LEA_THEOREM_TRANSLATION_MAX_RETRIES=4
        """
    )

    config = load_config(
        config_path,
        env_path=env_path,
        environ={"LEA_MODEL": "shell-model", "ANTHROPIC_API_KEY": "shell-anthropic"},
    )

    assert config.model == "shell-model"
    assert config.max_turns == 7
    assert config.openai_api_key == "env-openai"
    assert config.anthropic_api_key == "shell-anthropic"
    assert config.narrate_tool_steps is True
    assert config.permission_tier == "theorem_translation"
    assert config.theorem_translation_max_retries == 4
    assert config.lea_root == Path(__file__).resolve().parents[4] / "vendor" / "lea-prover"
