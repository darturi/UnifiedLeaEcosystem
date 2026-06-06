from app import db
from app import settings as settings_service


def test_settings_payload_masks_api_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        model = "gpt-4o"
        max_turns = 12
        max_spend_usd = 20.0
        permission_tier = "theorem_translation"
        openai_api_key = "sk-secret-1234"
        """
    )

    payload = settings_service.settings_payload(config_path)

    assert payload["model"] == "gpt-4o"
    assert payload["max_turns"] == 12
    assert payload["max_spend_usd"] == 20.0
    assert payload["api_keys"]["openai"] == {"configured": True, "last4": "1234"}
    assert payload["api_keys"]["anthropic"] == {"configured": False, "last4": None}


def test_update_settings_preserves_unrelated_config_and_updates_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    monkeypatch.setattr(settings_service, "_verify_api_key_credentials", lambda family, value, config: None)
    db.init_db()
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        lea_api_base_url = "http://127.0.0.1:8000"
        lea_root = "external/lea-prover"
        model = "gpt-4o"
        max_turns = 12
        permission_tier = "theorem_translation"
        openai_api_key = "old-secret"
        """
    )

    payload = settings_service.update_settings(
        {
            "model": "claude-sonnet-4-6",
            "max_turns": 30,
            "max_spend_usd": 9.5,
            "permission_tier": "stepwise",
            "api_keys": {
                "openai": {"clear": True},
                "anthropic": {"value": "sk-ant-secret123456"},
            },
        },
        config_path,
    )
    text = config_path.read_text()

    assert payload["permission_tier"] == "stepwise"
    assert 'lea_root = "external/lea-prover"' in text
    assert 'model = "claude-sonnet-4-6"' in text
    assert "max_turns = 30" in text
    assert "max_spend_usd = 9.5" in text
    assert 'permission_tier = "stepwise"' in text
    assert "openai_api_key" not in text
    assert 'anthropic_api_key = "sk-ant-secret123456"' in text


def test_update_settings_rejects_selected_model_without_api_key(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        model = "gpt-4o"
        max_turns = 12
        """
    )

    try:
        settings_service.update_settings({"model": "claude-sonnet-4-6"}, config_path)
    except settings_service.SettingsValidationError as exc:
        assert str(exc) == "An API key for Anthropic is required before saving this model."
        assert exc.field == "api_keys.anthropic"
    else:
        raise AssertionError("Expected SettingsValidationError")


def test_update_settings_rejects_malformed_api_key(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        model = "gpt-4o"
        max_turns = 12
        """
    )

    try:
        settings_service.update_settings(
            {
                "model": "gpt-4o",
                "api_keys": {"openai": {"value": "not-a-real-key"}},
            },
            config_path,
        )
    except settings_service.SettingsValidationError as exc:
        assert str(exc) == "The OpenAI API key does not look valid. Check the key and try again."
        assert exc.field == "api_keys.openai"
    else:
        raise AssertionError("Expected SettingsValidationError")


def test_update_settings_rejects_provider_rejected_api_key(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    config_path = tmp_path / "lea.local.toml"
    config_path.write_text(
        """
        model = "gpt-4o"
        max_turns = 12
        """
    )

    def reject_key(family, value, config):
        raise settings_service.SettingsValidationError(
            "The OpenAI API key was rejected by the provider.",
            "api_keys.openai",
        )

    monkeypatch.setattr(settings_service, "_verify_api_key_credentials", reject_key)

    try:
        settings_service.update_settings(
            {
                "model": "gpt-4o",
                "api_keys": {"openai": {"value": "sk-validlooking123456"}},
            },
            config_path,
        )
    except settings_service.SettingsValidationError as exc:
        assert str(exc) == "The OpenAI API key was rejected by the provider."
        assert exc.field == "api_keys.openai"
    else:
        raise AssertionError("Expected SettingsValidationError")
