from pathlib import Path

import pytest

from app.config import load_config


def test_load_config_defaults_to_local_lea_api(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text("")

    config = load_config(config_path)

    assert config.lea_api_base_url == "http://127.0.0.1:8000"
    assert config.model == "gemini/gemini-3.1-pro-preview"
    assert config.max_turns is None
    assert config.max_spend_usd is None
    assert config.lea_api_key is None
    assert config.lea_root == Path(__file__).resolve().parents[2] / "external" / "lea-prover"
    assert config.narrate_tool_steps is False
    assert config.permission_tier == "none"


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
        lea_root = "external/lea-prover"
        google_api_key = "google-secret"
        anthropic_api_key = "anthropic-secret"
        openai_api_key = "openai-secret"
        openai_base_url = "https://openai.example/v1"
        narrate_tool_steps = true
        permission_tier = "stepwise"
        """
    )

    config = load_config(config_path)

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


def test_load_config_rejects_invalid_api_base_url(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text('lea_api_base_url = "file:///tmp/lea"\n')

    with pytest.raises(ValueError, match="lea_api_base_url"):
        load_config(config_path)


def test_load_config_rejects_non_boolean_narration_flag(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text('narrate_tool_steps = "false"\n')

    with pytest.raises(ValueError, match="narrate_tool_steps"):
        load_config(config_path)


def test_load_config_rejects_invalid_permission_tier(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text('permission_tier = "ask_everything"\n')

    with pytest.raises(ValueError, match="permission_tier"):
        load_config(config_path)


def test_load_config_rejects_negative_max_spend(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text("max_spend_usd = -1\n")

    with pytest.raises(ValueError, match="max_spend_usd"):
        load_config(config_path)
