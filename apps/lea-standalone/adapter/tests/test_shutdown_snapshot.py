"""Shutdown exports preserve work while removing live and historical secrets."""
import base64
import gzip
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import stat
import subprocess
import zipfile
import zlib

import pytest


ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location("shutdown_snapshot", ROOT / "scripts/shutdown_snapshot.py")
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)


def fixture(tmp_path):
    app = tmp_path / "apps/lea-standalone"
    (app / "adapter").mkdir(parents=True)
    (app / "data").mkdir()
    (app / "config").mkdir()
    (app / "prover/workspace/proofs").mkdir(parents=True)
    (app / "config/lea.local.toml").write_text('model = "test/model"\nmax_turns = 12\nopenai_api_key = "fixture-current-credential"\ngithub_token = "fixture-github-credential"\n')
    (tmp_path / ".env").write_text('OTHER_API_KEY="fixture-env-credential"\nHOSTED_VLLM_API_BASE=http://localhost:1234/v1\n')
    return app


def contents(archive):
    with zipfile.ZipFile(archive) as source:
        return {name: source.read(name) for name in source.namelist()}


def git(repo, *args, data=None):
    return subprocess.run(["git", "-C", str(repo), *args], input=data,
                          check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def test_full_snapshots_preserve_work_and_redact_credentials_everywhere(tmp_path):
    app = fixture(tmp_path)
    db = app / "data/lea-interface.sqlite3"
    with sqlite3.connect(db) as conn:
        conn.execute("pragma secure_delete=off")
        conn.execute("create table timeline(id integer primary key, author text, content text, data text, bytes blob)")
        conn.execute("insert into timeline values (1,'user',?,?,?)", (
            "Please prove this. fixture-current-credential fixture-github-credential fixture-env-credential fixture-shell-credential",
            json.dumps({"api_key": "fixture-retired-credential", "proof": "by simp", "input_tokens": 42}),
            b"\x00fixture-current-credential\xff"))
        conn.execute("insert into timeline values (2,'user',?,null,null)", ("deleted-credential-only-in-free-pages" * 100,))
        conn.commit()
        conn.execute("delete from timeline where id=2")
    original_db = db.read_bytes()
    assert b"deleted-credential-only-in-free-pages" in original_db
    (app / "data/run.log").write_text("fixture-retired-credential\nBearer fixture-bearer-credential\nproof completed\n")
    (app / "data/key-copy.txt").write_text(base64.b64encode(b"fixture-current-credential").decode())
    (app / "data/trace.log.gz").write_bytes(gzip.compress(b"proof fixture-current-credential"))
    (app / "prover/workspace/proofs/Proof.lean").write_text("theorem demo : True := by trivial\n")
    with zipfile.ZipFile(app / "prover/workspace/proofs/reference.docx", "w", zipfile.ZIP_DEFLATED) as doc:
        doc.writestr("word/document.xml", "Reference fixture-current-credential")
        doc.writestr("credentials.json", '{"api_key":"fixture-current-credential"}')
    companion = tmp_path / "apps/overleaf-extension/.overleaf-lean-stub"
    companion.mkdir(parents=True)
    (companion / "jobs.json").write_text('{"job":{"status":"done","source":"A theorem"}}')
    (companion / "settings.json").write_text('{"apiKeys":{"provider":"fixture-companion-credential"},"leaModel":"test/model"}')
    (app / "data/copied-setting.txt").write_text("fixture-companion-credential")
    (app / "data/.env").write_text("SECRET=must-not-export-this-file")
    (app / "prover/workspace/.env").write_text("OTHER_API_KEY=fixture-nested-env-credential")
    (app / "data/provider.token").write_text("fixture-token-file-credential")
    (app / "data/copies.log").write_text("fixture-nested-env-credential fixture-token-file-credential")
    (app / "data/key.pem").write_text("must-not-export-private-key-file")
    outside = tmp_path / "outside.txt"
    outside.write_text("must-not-follow-symlink")
    (app / "data/link").symlink_to(outside)

    first = snapshot.create_snapshot(tmp_path, env={"CUSTOM_API_KEY": "fixture-shell-credential"})
    first_bytes = first.read_bytes()
    exported = contents(first)
    all_bytes = b"\n".join(exported.values())
    for secret in ("fixture-current-credential", "fixture-github-credential", "fixture-env-credential",
                   "fixture-retired-credential", "fixture-bearer-credential", "fixture-shell-credential",
                   "fixture-companion-credential", "deleted-credential-only-in-free-pages", "must-not-follow-symlink",
                   "fixture-nested-env-credential", "fixture-token-file-credential",
                   "must-not-export-this-file", "must-not-export-private-key-file"):
        assert secret.encode() not in all_bytes
    assert b"Please prove this" in all_bytes
    assert snapshot.REDACTED.encode() in exported["data/copied-setting.txt"]
    assert b"theorem demo" in all_bytes
    assert b"A theorem" in all_bytes
    assert db.read_bytes() == original_db
    assert "fixture-current-credential" in (app / "config/lea.local.toml").read_text()
    rows = [json.loads(line) for line in exported["data/lea-interface.sqlite3.jsonl"].splitlines()]
    assert rows[0]["format"] == "lea-sqlite-export-v1"
    assert rows[1]["row"]["author"] == "user"
    assert json.loads(rows[1]["row"]["data"])["input_tokens"] == 42
    assert b"fixture" not in base64.b64decode(rows[1]["row"]["bytes"]["$base64"])
    assert b"fixture" not in gzip.decompress(exported["data/trace.log.gz"])
    with zipfile.ZipFile(io.BytesIO(exported["workspace/proofs/reference.docx"])) as doc:
        assert "credentials.json" not in doc.namelist()
        assert b"fixture" not in doc.read("word/document.xml")
    settings = json.loads(exported["config/lea.local.toml.json"])
    assert settings["model"] == "test/model"
    assert settings["openai_api_key"] == snapshot.REDACTED
    assert json.loads(exported["runtime-settings.json"])["HOSTED_VLLM_API_BASE"] == "http://localhost:1234/v1"
    assert stat.S_IMODE(first.stat().st_mode) == 0o600

    (app / "data/later.log").write_text("second startup")
    second = snapshot.create_snapshot(tmp_path, env={})
    assert second != first
    assert first.read_bytes() == first_bytes
    assert len(list(first.parent.glob("*.zip"))) == 2
    assert "data/run.log" in contents(second)
    assert "data/later.log" in contents(second)
    assert not any("shutdown-archives" in name for name in contents(second))


def test_git_packed_history_is_preserved_and_rotated_secrets_are_scrubbed(tmp_path):
    app = fixture(tmp_path)
    repo = app / "prover/workspace/proofs/project"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Snapshot Test")
    git(repo, "config", "user.email", "snapshot@example.test")
    (repo / "old.env").write_text("EXAMPLE_API_KEY=fixture-old-history-credential\n")
    (repo / "Proof.lean").write_text("theorem first : True := by trivial\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "first proof")
    (repo / "old.env").unlink()
    (repo / "Proof.lean").write_text("theorem second : True := by trivial\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "second proof")
    git(repo, "gc", "--prune=now")
    (app / "data/run.log").write_text("Used fixture-old-history-credential")

    exported = contents(snapshot.create_snapshot(tmp_path, env={}))
    assert not any("/.git/" in name for name in exported)
    assert b"fixture-old-history-credential" not in b"\n".join(exported.values())
    history = exported["workspace/proofs/project/history.fast-export"]
    assert b"theorem first" in history and b"theorem second" in history
    imported = tmp_path / "imported"
    imported.mkdir()
    git(imported, "init", "-q", "--bare")
    git(imported, "fast-import", "--quiet", data=history)
    assert git(imported, "rev-list", "--all", "--count").strip() == b"2"
    assert (repo / "Proof.lean").read_text().startswith("theorem second")


def test_wal_rows_and_relocated_data_workspace_are_included(tmp_path):
    app = fixture(tmp_path)
    workspace = tmp_path / "custom-prover/workspace"
    workspace.mkdir(parents=True)
    (workspace / "notes.md").write_text("saved outside the default workspace")
    data = tmp_path / "custom-data"
    data.mkdir()
    with sqlite3.connect(data / "lea-interface.sqlite3") as conn:
        conn.execute("pragma journal_mode=wal")
        conn.execute("create table notes(body text)")
        conn.execute("insert into notes values ('committed WAL record')")
        conn.commit()
        result = snapshot.create_snapshot(tmp_path, env={"LEA_SHARED_DATA_DIR": "custom-data", "LEA_ROOT": str(workspace.parent)})
    assert result.parent == data / "shutdown-archives"
    exported = contents(result)
    assert b"committed WAL record" in exported["data/lea-interface.sqlite3.jsonl"]
    assert b"saved outside" in exported["workspace/notes.md"]
    assert not any(name.endswith(("-wal", "-shm")) for name in exported)


def test_failed_export_never_publishes_a_partial_archive(tmp_path, monkeypatch):
    app = fixture(tmp_path)
    (app / "data/run.log").write_text("proof completed")
    def fail(*args, **kwargs):
        raise OSError("simulated disk error")
    monkeypatch.setattr(snapshot.os, "replace", fail)
    with pytest.raises(OSError):
        snapshot.create_snapshot(tmp_path, env={})
    assert list((app / "data/shutdown-archives").iterdir()) == []


def test_compressed_database_backups_and_encoded_records_do_not_leak_secrets(tmp_path):
    app = fixture(tmp_path)
    backup = tmp_path / "backup.sqlite3"
    with sqlite3.connect(backup) as conn:
        conn.execute("pragma secure_delete=off")
        conn.execute("create table settings(api_key text default 'fixture-current-credential', payload text)")
        conn.execute("insert into settings values ('fixture-old-backup-credential', 'keep this note')")
        conn.execute("create table deleted(value text)")
        conn.execute("insert into deleted values (?)", ("deleted-backup-credential" * 100,))
        conn.commit()
        conn.execute("delete from deleted")
    assert b"deleted-backup-credential" in backup.read_bytes()
    (app / "data/backup.sqlite3.gz").write_bytes(gzip.compress(backup.read_bytes()))
    payload = base64.b64encode(b'prefix fixture-current-credential suffix').decode()
    (app / "data/encoded.json").write_text(json.dumps({"payload": payload}))
    exported = contents(snapshot.create_snapshot(tmp_path, env={}))
    clean = gzip.decompress(exported["data/backup.sqlite3.gz"])
    assert b"keep this note" in clean
    assert b"fixture-old-backup-credential" not in clean
    assert b"fixture-current-credential" not in clean
    assert b"deleted-backup-credential" not in clean
    payload = json.loads(exported["data/encoded.json"])["payload"]
    assert base64.b64decode(payload) == b"prefix [REDACTED] suffix"


def pdf(text):
    stream = zlib.compress(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode())
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               f"<< /Length {len(stream)} /Filter /FlateDecode >>\nstream\n".encode() + stream + b"\nendstream"]
    data, offsets = b"%PDF-1.4\n", [0]
    for identity, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{identity} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(data)
    data += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    data += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    return data + f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


def test_pdf_compressed_streams_are_inspected_and_credentials_use_safe_logical_export(tmp_path):
    app = fixture(tmp_path)
    (app / "data/reference.pdf").write_bytes(pdf("A proof fixture-current-credential"))
    clean_pdf = pdf("A public proof")
    (app / "data/public.pdf").write_bytes(clean_pdf)
    exported = contents(snapshot.create_snapshot(tmp_path, env={}))
    assert "data/reference.pdf" not in exported
    logical = json.loads(exported["data/reference.pdf.redacted.json"])
    assert logical["format"] == "lea-redacted-pdf-v1"
    decoded = b"\n".join(base64.b64decode(row["object"]["decoded_stream"]["$base64"])
                         for row in logical["objects"] if isinstance(row.get("object"), dict) and "decoded_stream" in row["object"])
    assert b"A proof" in decoded and b"fixture-current-credential" not in decoded
    assert exported["data/public.pdf"] == clean_pdf


def test_unrecognized_token_and_auth_patterns_are_removed_without_redacting_authors():
    redactor = snapshot.Redactor()
    redactor.discover({"api_key": "arbitrary-secret", "author": "user"})
    assert redactor.value({"author": "user", "authentication": "secret"}) == {"author": "user", "authentication": snapshot.REDACTED}
    for text in ("sk-proj-" + "X" * 32, "github_pat_" + "a" * 30,
                 "Bearer unexpected-token", "https://user:password@example.test/repo",
                 'API_KEY="unknown-secret"'):
        assert snapshot.REDACTED in redactor.text(text)
    assert "arbitrary-secret" not in redactor.text(quote_secret("arbitrary-secret"))


def quote_secret(secret):
    return json.dumps({"content": secret})
