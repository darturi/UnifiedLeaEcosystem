import json
from io import BytesIO
import urllib.error

from app import db
from app import settings as settings_service


def test_settings_payload_masks_api_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        LEA_MODEL=o4-mini
        LEA_MAX_TURNS=12
        LEA_MAX_SPEND_USD=20.0
        LEA_PERMISSION_TIER=theorem_translation
        LEA_THEOREM_TRANSLATION_MAX_RETRIES=4
        OPENAI_API_KEY=sk-secret-1234
        """
    )

    payload = settings_service.settings_payload(env_path)

    assert payload["model"] == "o4-mini"
    assert payload["max_turns"] == 12
    assert payload["max_spend_usd"] == 20.0
    assert payload["theorem_translation_max_retries"] == 4
    assert payload["api_keys"]["openai"] == {"configured": True, "last4": "1234"}
    assert payload["api_keys"]["anthropic"] == {"configured": False, "last4": None}
    assert [model["value"] for model in payload["model_options"]] == [
        "o4-mini",
        "gpt-5.4-mini",
        "gpt-5.4",
        "gpt-5.5",
        "gpt-4o",
        "gemini/gemini-3.1-pro-preview",
        "gemini/gemini-2.5-pro",
        "gemini/gemini-2.5-flash",
        "anthropic/claude-opus-4-8",
        "anthropic/claude-sonnet-4-6",
    ]
    assert payload["model_options"][5]["family"] == "google"


def test_update_settings_writes_root_env_values(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    monkeypatch.setattr(settings_service, "_verify_api_key_credentials", lambda family, value, config, model=None: None)
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        LEA_API_BASE_URL=http://127.0.0.1:8000
        LEA_ROOT=vendor/lea-prover
        LEA_MODEL=gpt-4o
        OPENAI_API_KEY=sk-oldsecret
        """
    )

    payload = settings_service.update_settings(
        {
            "model": "anthropic/claude-sonnet-4-6",
            "max_turns": 30,
            "max_spend_usd": 9.5,
            "permission_tier": "stepwise",
            "theorem_translation_max_retries": 7,
            "api_keys": {
                "openai": {"clear": True},
                "anthropic": {"value": "sk-ant-secret123456"},
            },
        },
        env_path,
    )
    text = env_path.read_text()

    assert payload["model"] == "anthropic/claude-sonnet-4-6"
    assert payload["permission_tier"] == "stepwise"
    assert payload["theorem_translation_max_retries"] == 7
    # Unrelated config is preserved.
    assert "LEA_ROOT=vendor/lea-prover" in text
    assert "LEA_MODEL=anthropic/claude-sonnet-4-6" in text
    assert "LEA_MAX_TURNS=30" in text
    assert "LEA_MAX_SPEND_USD=9.5" in text
    assert "LEA_PERMISSION_TIER=stepwise" in text
    assert "LEA_THEOREM_TRANSLATION_MAX_RETRIES=7" in text
    assert "OPENAI_API_KEY" not in text
    assert "ANTHROPIC_API_KEY=sk-ant-secret123456" in text


def test_update_settings_accepts_all_supported_models_with_family_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    monkeypatch.setattr(settings_service, "_verify_api_key_credentials", lambda family, value, config, model=None: None)
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        OPENAI_API_KEY=sk-openai-secret
        GEMINI_API_KEY=AIza12345678901234567890
        ANTHROPIC_API_KEY=sk-ant-secret
        """
    )

    for option in settings_service.MODEL_OPTIONS:
        payload = settings_service.update_settings({"model": option["value"]}, env_path)
        assert payload["model"] == option["value"]


def test_update_settings_rejects_invalid_theorem_translation_retries(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text("")

    try:
        settings_service.update_settings({"theorem_translation_max_retries": 0}, env_path)
    except ValueError as exc:
        assert str(exc) == "theorem_translation_max_retries must be at least 1"
    else:
        raise AssertionError("Expected ValueError")


def test_update_settings_rejects_selected_model_without_api_key(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        LEA_MODEL=gpt-4o
        LEA_MAX_TURNS=12
        """
    )

    try:
        settings_service.update_settings({"model": "anthropic/claude-sonnet-4-6"}, env_path)
    except settings_service.SettingsValidationError as exc:
        assert str(exc) == "An API key for Anthropic is required before saving this model."
        assert exc.field == "api_keys.anthropic"
    else:
        raise AssertionError("Expected SettingsValidationError")


def test_update_settings_rejects_malformed_api_key(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        LEA_MODEL=gpt-4o
        LEA_MAX_TURNS=12
        """
    )

    try:
        settings_service.update_settings(
            {
                "model": "o4-mini",
                "api_keys": {"openai": {"value": "not-a-real-key"}},
            },
            env_path,
        )
    except settings_service.SettingsValidationError as exc:
        assert str(exc) == "The OpenAI API key does not look valid. Check the key and try again."
        assert exc.field == "api_keys.openai"
    else:
        raise AssertionError("Expected SettingsValidationError")


def test_update_settings_allows_anthropic_prefix_then_defers_to_provider_verification(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    seen = {}

    def verify_key(family, value, config, model=None):
        seen["family"] = family
        seen["value"] = value
        seen["model"] = model

    monkeypatch.setattr(settings_service, "_verify_api_key_credentials", verify_key)
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        LEA_MODEL=o4-mini
        LEA_MAX_TURNS=12
        """
    )

    settings_service.update_settings(
        {
            "model": "anthropic/claude-sonnet-4-6",
            "api_keys": {"anthropic": {"value": "sk-ant-api03-test.value/with+chars"}},
        },
        env_path,
    )

    assert seen == {
        "family": "anthropic",
        "value": "sk-ant-api03-test.value/with+chars",
        "model": "anthropic/claude-sonnet-4-6",
    }
    assert "ANTHROPIC_API_KEY=sk-ant-api03-test.value/with+chars" in env_path.read_text()


def test_anthropic_verification_uses_messages_endpoint_with_selected_model(tmp_path):
    request = settings_service._provider_verification_request(
        "anthropic",
        "sk-ant-api03-test",
        settings_service.load_config(tmp_path / "missing.env"),
        "anthropic/claude-sonnet-4-6",
    )

    assert request is not None
    assert request.full_url == "https://api.anthropic.com/v1/messages"
    assert request.get_method() == "POST"
    assert request.headers["X-api-key"] == "sk-ant-api03-test"
    assert request.headers["Anthropic-version"] == "2023-06-01"
    assert request.headers["Content-type"] == "application/json"
    body = json.loads(request.data.decode("utf-8"))
    assert body == {
        "model": "anthropic/claude-sonnet-4-6",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
    }


def test_anthropic_model_error_is_reported_as_model_error(monkeypatch):
    body = json.dumps(
        {
            "error": {
                "type": "invalid_request_error",
                "message": "model: claude-missing does not exist",
            }
        }
    ).encode("utf-8")

    def fail_with_model_error(request, timeout=None, context=None):
        raise urllib.error.HTTPError(
            request.full_url,
            400,
            "Bad Request",
            {},
            BytesIO(body),
        )

    monkeypatch.setattr(settings_service.urllib.request, "urlopen", fail_with_model_error)

    try:
        settings_service._verify_api_key_credentials(
            "anthropic",
            "sk-ant-api03-test",
            settings_service.load_config(),
            "claude-missing",
        )
    except settings_service.SettingsValidationError as exc:
        assert exc.field == "model"
        assert "Anthropic rejected the selected model" in str(exc)
        assert "claude-missing" in str(exc)
    else:
        raise AssertionError("Expected SettingsValidationError")


def test_update_settings_rejects_provider_rejected_api_key(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    env_path = tmp_path / ".env"
    env_path.write_text(
        """
        LEA_MODEL=o4-mini
        LEA_MAX_TURNS=12
        """
    )

    def reject_key(family, value, config, model=None):
        raise settings_service.SettingsValidationError(
            "The OpenAI API key was rejected by the provider.",
            "api_keys.openai",
        )

    monkeypatch.setattr(settings_service, "_verify_api_key_credentials", reject_key)

    try:
        settings_service.update_settings(
            {
                "model": "o4-mini",
                "api_keys": {"openai": {"value": "sk-validlooking123456"}},
            },
            env_path,
        )
    except settings_service.SettingsValidationError as exc:
        assert str(exc) == "The OpenAI API key was rejected by the provider."
        assert exc.field == "api_keys.openai"
    else:
        raise AssertionError("Expected SettingsValidationError")
