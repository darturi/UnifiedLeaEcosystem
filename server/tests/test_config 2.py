from pathlib import Path

from app.config import apply_provider_env, load_config


def test_load_config_defaults_relative_lea_root(tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        provider = "openai"
        model = "gpt-4o"
        max_turns = 7
        lea_root = "external/lea-prover"
        openai_api_key = "test-key"
        """
    )

    config = load_config(config_path)

    assert config.provider == "openai"
    assert config.model == "gpt-4o"
    assert config.max_turns == 7
    assert config.lea_root.name == "lea-prover"
    assert config.openai_api_key == "test-key"


def test_apply_provider_env_sets_configured_keys(monkeypatch, tmp_path):
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        model = "claude-sonnet-4-20250514"
        anthropic_api_key = "anthropic-test"
        """
    )
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    apply_provider_env(load_config(config_path))

    assert Path(load_config(config_path).lea_root).name == "lea-prover"
    assert __import__("os").environ["ANTHROPIC_API_KEY"] == "anthropic-test"

