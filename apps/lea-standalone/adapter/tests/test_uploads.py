"""S1/S2 tests: the upload service — validate + sanitize + store + commit + index,
and Tier-2 text extraction. The proofs root is a tmp dir, so these never touch the
real workspace."""

from __future__ import annotations

import io
import subprocess

import pytest

from app import db, projects, store, uploads


def _project(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    proofs = tmp_path / "proofs"
    project = projects.provision_project("Analysis", proofs)
    return project, proofs


def _docx_bytes(text: str) -> bytes:
    import docx

    document = docx.Document()
    document.add_paragraph(text)
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


# ── validation ───────────────────────────────────────────────────────────────
def test_rejects_unsupported_extension(tmp_path, monkeypatch):
    project, proofs = _project(tmp_path, monkeypatch)
    with pytest.raises(uploads.UploadError) as exc:
        uploads.save_upload(project, proofs, "evil.sh", b"#!/bin/sh\nrm -rf /")
    assert exc.value.code == "unsupported"


def test_rejects_oversize_and_empty(tmp_path, monkeypatch):
    project, proofs = _project(tmp_path, monkeypatch)
    big = b"x" * (uploads.MAX_UPLOAD_BYTES + 1)
    with pytest.raises(uploads.UploadError) as exc:
        uploads.save_upload(project, proofs, "huge.txt", big)
    assert exc.value.code == "too_large"
    with pytest.raises(uploads.UploadError) as exc2:
        uploads.save_upload(project, proofs, "empty.txt", b"")
    assert exc2.value.code == "invalid"


# ── filename sanitize + collisions ───────────────────────────────────────────
def test_sanitize_strips_path_and_dedupes():
    # path-escape components are dropped; only the basename survives
    assert uploads.sanitize_filename("../../etc/passwd.txt", set()) == "passwd.txt"
    assert uploads.sanitize_filename("a b/c d.tex", set()) == "c-d.tex"
    # collisions get -2, -3 … (and a colliding sidecar is avoided too)
    existing = {"paper.pdf", "paper-2.pdf"}
    assert uploads.sanitize_filename("paper.pdf", existing) == "paper-3.pdf"


# ── store + commit + index (Tier 1: native text, no sidecar) ─────────────────
def test_native_text_upload_stores_commits_indexes(tmp_path, monkeypatch):
    project, proofs = _project(tmp_path, monkeypatch)
    row = uploads.save_upload(project, proofs, "notes.tex", b"\\section{x}", mime="text/x-tex")

    assert row["filename"] == "notes.tex"
    assert row["stored_path"] == ".lea/files/notes.tex"
    assert row["extracted_path"] is None  # Tier 1 — readable as-is, no sidecar
    repo = proofs / "Lea" / "Analysis"
    assert (repo / ".lea" / "files" / "notes.tex").read_bytes() == b"\\section{x}"
    # committed to the project repo
    log = subprocess.run(["git", "-C", str(repo), "log", "--oneline"], capture_output=True, text=True).stdout
    assert "upload .lea/files/notes.tex" in log
    # indexed
    assert [f["id"] for f in store.list_project_files(project["id"])] == [row["id"]]


# ── Tier 2 extraction (.docx → .txt sidecar) ─────────────────────────────────
def test_docx_extraction_writes_sidecar(tmp_path, monkeypatch):
    project, proofs = _project(tmp_path, monkeypatch)
    row = uploads.save_upload(project, proofs, "paper.docx", _docx_bytes("Hello from docx"))

    assert row["extracted_path"] == ".lea/files/paper.docx.txt"
    repo = proofs / "Lea" / "Analysis"
    assert "Hello from docx" in (repo / ".lea" / "files" / "paper.docx.txt").read_text()


# ── Tier 3 (image: stored, not extracted) ────────────────────────────────────
def test_image_is_stored_not_extracted(tmp_path, monkeypatch):
    project, proofs = _project(tmp_path, monkeypatch)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    row = uploads.save_upload(project, proofs, "fig.png", png, mime="image/png")
    assert row["extracted_path"] is None
    assert row["mime"] == "image/png"


# ── delete removes bytes + sidecar + row ─────────────────────────────────────
def test_delete_removes_file_sidecar_and_row(tmp_path, monkeypatch):
    project, proofs = _project(tmp_path, monkeypatch)
    row = uploads.save_upload(project, proofs, "paper.docx", _docx_bytes("body"))
    repo = proofs / "Lea" / "Analysis"
    assert (repo / ".lea" / "files" / "paper.docx").exists()

    assert uploads.delete_file(project, proofs, row) is True
    assert not (repo / ".lea" / "files" / "paper.docx").exists()
    assert not (repo / ".lea" / "files" / "paper.docx.txt").exists()
    assert store.list_project_files(project["id"]) == []


# ── extraction surfaces in the composed context inventory (D25/D27) ──────────
def test_upload_appears_in_context_inventory(tmp_path, monkeypatch):
    project, proofs = _project(tmp_path, monkeypatch)
    uploads.save_upload(project, proofs, "paper.docx", _docx_bytes("body"))
    repo = proofs / "Lea" / "Analysis"
    msg = projects.compose_context_message(store.get_project(project["id"]), repo)
    # the upload is listed, pointing at its extracted-text sidecar — and the sidecar
    # is NOT listed as its own item
    assert "`.lea/files/paper.docx`" in msg["content"]
    assert "`.lea/files/paper.docx.txt`" in msg["content"]
    assert "- `.lea/files/paper.docx.txt`" not in msg["content"]
