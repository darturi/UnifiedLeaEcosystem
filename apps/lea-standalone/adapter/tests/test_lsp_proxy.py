"""v2.2 · L1/L2 — the LSP-over-WebSocket proxy's pure pieces.

The full pump needs a live `lake serve`, so these pin the parts we can test
hermetically: the `file://` URI rewriting in both directions (the seam that maps a
browser's virtual document path to the real on-disk file, D60/D64), the
Content-Length framing, and Lake-root resolution. If the rewrite is wrong the Lean
server opens the wrong file (or none); if the framing is wrong nothing parses.
"""

import asyncio
import json

import pytest

from app import lsp_proxy

PREFIX = "/abs/workspace"


def test_rewrite_client_to_server_prefixes_uris():
    msg = {
        "method": "textDocument/didOpen",
        "params": {"textDocument": {"uri": "file:///proofs/s1/Main.lean", "text": "x"}},
    }
    out = lsp_proxy._apply_client_to_server(msg, PREFIX)
    assert out["params"]["textDocument"]["uri"] == "file:///abs/workspace/proofs/s1/Main.lean"


def test_rewrite_prefixes_root_uri_and_root_path():
    msg = {"method": "initialize", "params": {
        "rootUri": "file://", "rootPath": "/", "capabilities": {}}}
    out = lsp_proxy.rewrite_client_to_server(msg, PREFIX)
    assert out["params"]["rootUri"] == f"file://{PREFIX}"
    # rootPath is deprecated (the server uses rootUri); a trailing slash is harmless.
    assert out["params"]["rootPath"].rstrip("/") == PREFIX


def test_definition_requests_are_not_rewritten():
    # lean4web leaves textDocument/definition URIs alone (remapped on the response);
    # rewriting them would break go-to-definition.
    msg = {"method": "textDocument/definition", "params": {
        "textDocument": {"uri": "file:///proofs/s1/Main.lean"}}}
    out = lsp_proxy._apply_client_to_server(msg, PREFIX)
    assert out["params"]["textDocument"]["uri"] == "file:///proofs/s1/Main.lean"


def test_rewrite_server_to_client_strips_prefix():
    msg = {"method": "textDocument/publishDiagnostics", "params": {
        "uri": f"file://{PREFIX}/proofs/s1/Main.lean", "diagnostics": []}}
    out = lsp_proxy.rewrite_server_to_client(msg, PREFIX)
    assert out["params"]["uri"] == "file:///proofs/s1/Main.lean"


def test_rewrite_round_trips_nested_lists():
    # locations come back as arrays of {uri, range}; every uri must be stripped.
    server_msg = {"result": [
        {"uri": f"file://{PREFIX}/a.lean", "range": {}},
        {"uri": f"file://{PREFIX}/b.lean", "range": {}},
    ]}
    out = lsp_proxy.rewrite_server_to_client(server_msg, PREFIX)
    assert [loc["uri"] for loc in out["result"]] == ["file:///a.lean", "file:///b.lean"]


def test_encode_produces_content_length_frame():
    frame = lsp_proxy._encode({"jsonrpc": "2.0", "id": 1})
    header, _, body = frame.partition(b"\r\n\r\n")
    assert header == f"Content-Length: {len(body)}".encode()
    assert json.loads(body) == {"jsonrpc": "2.0", "id": 1}


def test_read_message_parses_a_framed_message():
    payload = {"jsonrpc": "2.0", "method": "hi", "params": {}}
    frame = lsp_proxy._encode(payload)

    async def run():
        reader = asyncio.StreamReader()
        reader.feed_data(frame)
        reader.feed_eof()
        return await lsp_proxy._read_message(reader)

    assert asyncio.run(run()) == payload


def test_read_message_returns_none_at_eof():
    async def run():
        reader = asyncio.StreamReader()
        reader.feed_eof()
        return await lsp_proxy._read_message(reader)

    assert asyncio.run(run()) is None


def test_resolve_target_finds_lake_root_and_relative_name(tmp_path):
    root = tmp_path / "workspace"
    (root / "proofs" / "s1").mkdir(parents=True)
    (root / "lakefile.toml").write_text("")
    proof = root / "proofs" / "s1" / "Main.lean"
    proof.write_text("theorem t : True := trivial")

    lake_root, file_name = lsp_proxy.resolve_target(str(proof))
    assert lake_root == root.resolve()
    assert file_name == "proofs/s1/Main.lean"


def test_resolve_target_raises_without_lakefile(tmp_path):
    proof = tmp_path / "Main.lean"
    proof.write_text("x")
    with pytest.raises(FileNotFoundError):
        lsp_proxy.resolve_target(str(proof))
