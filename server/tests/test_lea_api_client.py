import json
from io import BytesIO
from urllib.error import HTTPError

import pytest

from app.config import LeaConfig
from app.lea_api_client import LeaApiClient, LeaApiError, parse_sse_lines


class FakeResponse:
    def __init__(self, body=b"", status=200, lines=None):
        self._body = body
        self.status = status
        self.lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self._body

    def __iter__(self):
        return iter(self.lines or [])


def make_config(**overrides):
    return LeaConfig(
        model=overrides.get("model", "o4-mini"),
        max_turns=overrides.get("max_turns", 5),
        lea_api_base_url=overrides.get("lea_api_base_url", "http://lea-api.test"),
        lea_api_key=overrides.get("lea_api_key"),
        lea_root=overrides.get("lea_root"),
        lea_job_timeout_seconds=overrides.get("lea_job_timeout_seconds", 900),
        narrate_tool_steps=overrides.get("narrate_tool_steps", False),
    )


def test_start_run_posts_task_config_and_bearer_auth():
    seen = {}

    def transport(request, timeout=None):
        seen["url"] = request.full_url
        seen["method"] = request.get_method()
        seen["headers"] = dict(request.header_items())
        seen["body"] = json.loads(request.data.decode("utf-8"))
        return FakeResponse(json.dumps({"run_id": "api-1"}).encode("utf-8"))

    client = LeaApiClient(make_config(lea_api_key="secret"), transport=transport)

    result = client.start_run("prove True")

    assert result["run_id"] == "api-1"
    assert seen["url"] == "http://lea-api.test/v1/runs"
    assert seen["method"] == "POST"
    assert seen["headers"]["Authorization"] == "Bearer secret"
    assert seen["body"] == {
        "task": "prove True",
        "config": {
            "agent": {"max_turns": 5, "narrate_tool_steps": False},
            "model": {"name": "o4-mini"},
        },
    }


def test_start_run_sends_narration_flag_even_without_max_turns():
    seen = {}

    def transport(request, timeout=None):
        seen["body"] = json.loads(request.data.decode("utf-8"))
        return FakeResponse(json.dumps({"run_id": "api-1"}).encode("utf-8"))

    LeaApiClient(make_config(max_turns=None, narrate_tool_steps=True), transport=transport).start_run("task")

    assert seen["body"]["config"]["agent"] == {"narrate_tool_steps": True}


def test_start_run_omits_bearer_auth_when_key_missing():
    headers = {}

    def transport(request, timeout=None):
        headers.update(dict(request.header_items()))
        return FakeResponse(json.dumps({"run_id": "api-1"}).encode("utf-8"))

    LeaApiClient(make_config(), transport=transport).start_run("task")

    assert "Authorization" not in headers


def test_parse_sse_lines_applies_event_type_and_json_payload():
    response = BytesIO(
        b"event: text_delta\n"
        b'data: {"seq": 0, "text": "hello"}\n'
        b"\n"
        b'data: {"seq": 1, "type": "finished", "reason": "completed"}\n'
        b"\n"
    )

    assert list(parse_sse_lines(response)) == [
        {"seq": 0, "text": "hello", "type": "text_delta"},
        {"seq": 1, "type": "finished", "reason": "completed"},
    ]


def test_stream_events_resumes_from_seq():
    seen = {}

    def transport(request, timeout=None):
        seen["url"] = request.full_url
        seen["headers"] = dict(request.header_items())
        return FakeResponse(lines=[b'data: {"seq": 3, "type": "finished"}\n', b"\n"])

    events = list(LeaApiClient(make_config(), transport=transport).stream_events("api-1", from_seq=3))

    assert seen["url"] == "http://lea-api.test/v1/runs/api-1/events?from_seq=3"
    assert seen["headers"]["Last-event-id"] == "2"
    assert events == [{"seq": 3, "type": "finished"}]


def test_cancel_run_posts_cancel_endpoint():
    seen = {}

    def transport(request, timeout=None):
        seen["url"] = request.full_url
        seen["method"] = request.get_method()
        return FakeResponse(json.dumps({"ok": True}).encode("utf-8"))

    result = LeaApiClient(make_config(), transport=transport).cancel_run("api-1")

    assert result == {"ok": True}
    assert seen == {
        "url": "http://lea-api.test/v1/runs/api-1/cancel",
        "method": "POST",
    }


def test_get_transcript_uses_endpoint_and_bearer_auth():
    seen = {}

    def transport(request, timeout=None):
        seen["url"] = request.full_url
        seen["method"] = request.get_method()
        seen["headers"] = dict(request.header_items())
        return FakeResponse(json.dumps({"messages": []}).encode("utf-8"))

    result = LeaApiClient(make_config(lea_api_key="secret"), transport=transport).get_transcript("api-1")

    assert result == {"messages": []}
    assert seen["url"] == "http://lea-api.test/v1/runs/api-1/transcript"
    assert seen["method"] == "GET"
    assert seen["headers"]["Authorization"] == "Bearer secret"


def test_get_transcript_accepts_relative_or_absolute_transcript_url():
    urls = []

    def transport(request, timeout=None):
        urls.append(request.full_url)
        return FakeResponse(json.dumps([]).encode("utf-8"))

    client = LeaApiClient(make_config(), transport=transport)

    assert client.get_transcript("api-1", "/v1/runs/api-1/transcript") == []
    assert client.get_transcript("api-1", "http://lea-api.test/v1/runs/api-1/transcript") == []
    assert urls == [
        "http://lea-api.test/v1/runs/api-1/transcript",
        "http://lea-api.test/v1/runs/api-1/transcript",
    ]


def test_get_transcript_http_error_raises_lea_api_error():
    def transport(request, timeout=None):
        raise HTTPError(request.full_url, 500, "boom", {}, BytesIO(b"failed"))

    with pytest.raises(LeaApiError, match="HTTP 500"):
        LeaApiClient(make_config(), transport=transport).get_transcript("api-1")
