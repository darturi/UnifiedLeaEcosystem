from pathlib import Path

import pytest

from app.config import load_config


def test_load_config_defaults_to_local_lea_api(tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("")

    config = load_config(env_path=env_path, environ={})

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
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        LEA_API_BASE_URL=http://localhost:8123/
        LEA_API_KEY=test-key
        LEA_MODEL=o4-mini
        LEA_MAX_TURNS=7
        LEA_MAX_SPEND_USD=12.5
        LEA_JOB_TIMEOUT_SECONDS=45
        LEA_ROOT=vendor/lea-prover
        GOOGLE_API_KEY=google-secret
        ANTHROPIC_API_KEY=anthropic-secret
        OPENAI_API_KEY=openai-secret
        OPENAI_BASE_URL=https://openai.example/v1
        LEA_NARRATE_TOOL_STEPS=true
        LEA_PERMISSION_TIER=stepwise
        LEA_THEOREM_TRANSLATION_MAX_RETRIES=5
        """
    )

    config = load_config(env_path=env_path, environ={})

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
    env_path = tmp_path / ".env"
    env_path.write_text("LEA_API_BASE_URL=file:///tmp/lea\n")

    with pytest.raises(ValueError, match="lea_api_base_url"):
        load_config(env_path=env_path, environ={})


def test_load_config_rejects_non_boolean_narration_flag(tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("LEA_NARRATE_TOOL_STEPS=maybe\n")

    with pytest.raises(ValueError, match="narrate_tool_steps"):
        load_config(env_path=env_path, environ={})


def test_load_config_rejects_invalid_permission_tier(tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("LEA_PERMISSION_TIER=ask_everything\n")

    with pytest.raises(ValueError, match="permission_tier"):
        load_config(env_path=env_path, environ={})


@pytest.mark.parametrize(
    "value",
    ["0", "-1", "true", "1.5", "abc"],
)
def test_load_config_rejects_invalid_theorem_translation_retries(tmp_path, value):
    env_path = tmp_path / ".env"
    env_path.write_text(f"LEA_THEOREM_TRANSLATION_MAX_RETRIES={value}\n")

    with pytest.raises(ValueError, match="theorem_translation_max_retries"):
        load_config(env_path=env_path, environ={})


def test_load_config_rejects_negative_max_spend(tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("LEA_MAX_SPEND_USD=-1\n")

    with pytest.raises(ValueError, match="max_spend_usd"):
        load_config(env_path=env_path, environ={})


def test_load_config_uses_shell_over_root_env(tmp_path):
    env_path = tmp_path / ".env"
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
