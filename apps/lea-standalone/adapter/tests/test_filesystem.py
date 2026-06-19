"""U1/U2 tests: the project filesystem service (D34) — tree, read, edit, export.

Pure service tests against a scratch git repo. No DB: `project_repo_dir` only reads
`namespace`, so a minimal project dict + a git-init'd repo is all that's needed."""

import io
import zipfile

import pytest

from app import filesystem as fs
from app.gitstore import GitStore


def _make_repo(tmp_path):
    """A git-init'd project repo at proofs/Lea/Demo + the (proofs_root, project) the
    service functions take. Returns (proofs_root, project, repo_path)."""
    proofs = tmp_path / "workspace" / "proofs"
    project = {"namespace": "Lea.Demo", "slug": "demo"}
    repo = proofs / "Lea" / "Demo"
    GitStore(proofs).init_repo(repo, subject="init")
    return proofs, project, repo


def test_build_tree_nests_dirs_first_and_hides_internals(tmp_path):
    _, _, repo = _make_repo(tmp_path)
    (repo / ".lea").mkdir()
    (repo / ".lea" / "blueprint.md").write_text("# bp\n")
    (repo / "Foo.lean").write_text("theorem foo : True := trivial\n")
    # .git exists (init'd) and a fake .lake should both be hidden.
    (repo / ".lake").mkdir()
    (repo / ".lake" / "junk.olean").write_text("binary-ish")

    tree = fs.build_tree(repo)
    names = [e["name"] for e in tree]
    assert ".git" not in names and ".lake" not in names
    # dirs before files: .lea (dir) precedes Foo.lean (file)
    assert names == [".lea", "Foo.lean"]

    lea = next(e for e in tree if e["name"] == ".lea")
    assert lea["type"] == "dir"
    assert [c["name"] for c in lea["children"]] == ["blueprint.md"]
    assert lea["children"][0]["path"] == ".lea/blueprint.md"

    foo = next(e for e in tree if e["name"] == "Foo.lean")
    assert foo["type"] == "file" and foo["size"] > 0


def test_build_tree_missing_repo_is_empty(tmp_path):
    assert fs.build_tree(tmp_path / "nope") == []


def test_read_text_file(tmp_path):
    _, _, repo = _make_repo(tmp_path)
    (repo / "Foo.lean").write_text("theorem foo : True := trivial\n")
    assert fs.read_text_file(repo, "Foo.lean").startswith("theorem foo")


def test_read_missing_file_raises_not_found(tmp_path):
    _, _, repo = _make_repo(tmp_path)
    with pytest.raises(fs.FilesystemError) as exc:
        fs.read_text_file(repo, "Ghost.lean")
    assert exc.value.code == "not_found"


def test_read_binary_file_raises_binary(tmp_path):
    _, _, repo = _make_repo(tmp_path)
    (repo / "img.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe")
    with pytest.raises(fs.FilesystemError) as exc:
        fs.read_text_file(repo, "img.png")
    assert exc.value.code == "binary"


@pytest.mark.parametrize("bad", ["../escape.txt", "/etc/passwd", ".git/config", ".lake/x"])
def test_path_guard_rejects_escapes_and_hidden_dirs(tmp_path, bad):
    _, _, repo = _make_repo(tmp_path)
    with pytest.raises(fs.FilesystemError) as exc:
        fs.read_text_file(repo, bad)
    assert exc.value.code == "bad_path"


def test_write_text_file_commits_and_persists(tmp_path):
    proofs, project, repo = _make_repo(tmp_path)
    sha = fs.write_text_file(project, proofs, "sub/New.lean", "theorem n : True := trivial\n")
    assert sha  # a real commit sha
    assert (repo / "sub" / "New.lean").read_text().startswith("theorem n")
    # the write is committed — a fresh read sees it
    assert fs.read_text_file(repo, "sub/New.lean").startswith("theorem n")


def test_write_rejects_path_escape(tmp_path):
    proofs, project, _ = _make_repo(tmp_path)
    with pytest.raises(fs.FilesystemError) as exc:
        fs.write_text_file(project, proofs, "../sneaky.txt", "x")
    assert exc.value.code == "bad_path"


def test_export_zip_includes_source_excludes_internals(tmp_path):
    _, _, repo = _make_repo(tmp_path)
    (repo / "Foo.lean").write_text("theorem foo : True := trivial\n")
    (repo / ".lea").mkdir()
    (repo / ".lea" / "memory.md").write_text("# mem\n")
    (repo / ".lake").mkdir()
    (repo / ".lake" / "junk.olean").write_text("nope")

    data = fs.export_zip(repo)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
    assert any(n.endswith("Demo/Foo.lean") for n in names)
    assert any(n.endswith("Demo/.lea/memory.md") for n in names)
    assert not any(".lake" in n for n in names)
    assert not any("/.git/" in n for n in names)
