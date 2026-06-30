"""P3 tests: project CRUD routes (D31). Route functions are called directly (as the
other route tests do), with `load_config` patched so the proofs root is a tmp dir."""

import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

from app import db, store
from app.config import LeaConfig
from app.routes import projects as projects_route
from app.routes.projects import DocUpdate, FilePut, ProjectCreate, ProjectUpdate, SessionCreate


def _upload(project_id, filename, data, content_type=None):
    """Call the async upload route directly with a constructed UploadFile."""
    headers = Headers({"content-type": content_type}) if content_type else None
    uf = UploadFile(filename=filename, file=io.BytesIO(data), headers=headers)
    return asyncio.run(projects_route.upload_file(project_id, uf))


def _setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(
        projects_route, "load_config",
        lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path, max_spend_usd=None),
    )
    return tmp_path / "workspace" / "proofs"


def test_create_lists_and_gets_a_project(tmp_path, monkeypatch):
    proofs = _setup(tmp_path, monkeypatch)

    created = projects_route.create_project(ProjectCreate(title="Real Analysis", description="ε–δ"))
    assert created["slug"] == "real-analysis"
    assert created["namespace"] == "Lea.RealAnalysis"
    assert (proofs / "Lea" / "RealAnalysis" / ".lea" / "blueprint.md").is_file()

    listed = projects_route.list_projects()["projects"]
    assert len(listed) == 1
    assert listed[0]["id"] == created["id"]
    assert listed[0]["session_count"] == 0

    detail = projects_route.get_project(created["id"])
    assert detail["id"] == created["id"]
    assert detail["sessions"] == []  # no sessions yet


def test_create_rejects_blank_title(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as exc:
        projects_route.create_project(ProjectCreate(title="   "))
    assert exc.value.status_code == 400


def test_detail_includes_project_sessions(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Topology"))
    sess = store.create_session("a proof", project_id=project["id"])

    detail = projects_route.get_project(project["id"])
    assert [s["id"] for s in detail["sessions"]] == [sess["id"]]
    assert projects_route.list_projects()["projects"][0]["session_count"] == 1


def test_create_session_in_project(tmp_path, monkeypatch):
    # D23: a session created inside a project is tagged with project_id and appears
    # in the project's session list.
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Topology"))

    sess = projects_route.create_session_in_project(project["id"], SessionCreate(title="lemma A"))
    assert sess["project_id"] == project["id"]
    assert sess["title"] == "lemma A"
    assert [s["id"] for s in projects_route.get_project(project["id"])["sessions"]] == [sess["id"]]

    # blank title falls back; missing project → 404
    fallback = projects_route.create_session_in_project(project["id"], SessionCreate())
    assert fallback["title"] == "Untitled theorem"
    with pytest.raises(HTTPException) as exc:
        projects_route.create_session_in_project("nope", SessionCreate(title="x"))
    assert exc.value.status_code == 404


def test_update_edits_title_and_description(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Old"))

    updated = projects_route.update_project(
        project["id"], ProjectUpdate(title="New", description="now described")
    )
    assert updated["title"] == "New"
    assert updated["description"] == "now described"
    assert updated["slug"] == project["slug"]  # immutable


def test_delete_removes_repo_and_rows(tmp_path, monkeypatch):
    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Doomed"))
    repo = proofs / "Lea" / "Doomed"
    assert repo.is_dir()

    result = projects_route.delete_project(project["id"])
    assert result["deleted"] is True
    assert not repo.exists()
    assert store.get_project(project["id"]) is None


def test_missing_project_is_404(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    for call in (
        lambda: projects_route.get_project("nope"),
        lambda: projects_route.update_project("nope", ProjectUpdate(title="x")),
        lambda: projects_route.delete_project("nope"),
        lambda: projects_route.get_instructions("nope"),
        lambda: projects_route.put_instructions("nope", DocUpdate(content="x")),
        lambda: projects_route.get_memory("nope"),
        lambda: projects_route.put_memory("nope", DocUpdate(content="x")),
        lambda: projects_route.get_blueprint("nope"),
        lambda: projects_route.put_blueprint("nope", DocUpdate(content="x")),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404


@pytest.mark.parametrize("doc", ["instructions", "memory", "blueprint"])
def test_doc_get_returns_seeded_then_roundtrips_put(tmp_path, monkeypatch, doc):
    # R1/R2: GET returns the seeded template; PUT writes+commits; GET returns the
    # new content; and the composed run context reflects the edit.
    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    get = getattr(projects_route, f"get_{doc}")
    put = getattr(projects_route, f"put_{doc}")

    seeded = get(project["id"])["content"]
    assert doc[:4].lower() in seeded.lower()  # "inst"/"memo" header present

    result = put(project["id"], DocUpdate(content="# Edited\n\n- a durable fact\n"))
    assert result["content"].startswith("# Edited")
    assert len(result["commit_sha"]) == 40  # a real commit landed

    assert get(project["id"])["content"] == "# Edited\n\n- a durable fact\n"
    on_disk = proofs / "Lea" / "Analysis" / ".lea" / f"{doc}.md"
    assert on_disk.read_text() == "# Edited\n\n- a durable fact\n"


def test_file_upload_list_download_delete_roundtrip(tmp_path, monkeypatch):
    # S1: POST stores+indexes; GET lists; GET/{fid} downloads the bytes; DELETE removes.
    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    pid = project["id"]
    assert projects_route.list_files(pid)["files"] == []

    row = _upload(pid, "notes.tex", b"\\section{x}", "text/x-tex")
    assert row["stored_path"] == ".lea/files/notes.tex"
    assert [f["id"] for f in projects_route.list_files(pid)["files"]] == [row["id"]]

    resp = projects_route.download_file(pid, row["id"])
    assert str(resp.path) == str(proofs / "Lea" / "Analysis" / ".lea" / "files" / "notes.tex")
    assert resp.filename == "notes.tex"

    assert projects_route.delete_file(pid, row["id"])["deleted"] is True
    assert projects_route.list_files(pid)["files"] == []


def test_file_upload_rejects_unsupported_type(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    with pytest.raises(HTTPException) as exc:
        _upload(project["id"], "evil.sh", b"rm -rf /")
    assert exc.value.status_code == 415


def test_file_routes_404_on_missing_project_or_file(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    pid = project["id"]
    with pytest.raises(HTTPException) as e1:
        projects_route.list_files("nope")
    assert e1.value.status_code == 404
    with pytest.raises(HTTPException) as e2:
        projects_route.download_file(pid, "no-such-file")
    assert e2.value.status_code == 404
    with pytest.raises(HTTPException) as e3:
        projects_route.delete_file(pid, "no-such-file")
    assert e3.value.status_code == 404


def test_blueprint_route_returns_validator_warnings(tmp_path, monkeypatch):
    # T1: PUT/GET /blueprint attach advisory warnings (a dangling `uses` edge), but
    # still save (warnings never block the write).
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    pid = project["id"]

    bad = "## a\n- kind: lemma\n- uses: ghost\n\nstatement\n"
    put = projects_route.put_blueprint(pid, DocUpdate(content=bad))
    assert len(put["commit_sha"]) == 40  # the malformed blueprint still committed
    assert any("ghost" in w["message"] for w in put["warnings"])

    # The warning is recomputed on GET too, not just returned from the PUT.
    assert any("ghost" in w["message"] for w in projects_route.get_blueprint(pid)["warnings"])


def test_graph_route_derives_node_status(tmp_path, monkeypatch):
    # T2: GET /graph parses the blueprint and derives status from the stored verdict.
    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    pid = project["id"]
    repo = proofs / "Lea" / "Analysis"

    (repo / "helper.lean").write_text("import Mathlib\nnamespace Lea.Analysis\nlemma helper : True := trivial\nend Lea.Analysis\n")
    projects_route.put_blueprint(pid, DocUpdate(content="## helper\n- kind: lemma\n- lean: `Lea.Analysis.helper`\n\nA helper.\n"))
    sess = store.create_session("w", project_id=pid)["id"]
    store.add_code_step(sess, None, "helper.lean", commit_sha="a" * 40, check_status="ok")

    result = projects_route.get_graph(pid)
    node = result["nodes"][0]
    assert node["key"] == "helper"
    assert node["status"] == "proved"
    assert node["last_modified_by"] == sess

    with pytest.raises(HTTPException) as exc:
        projects_route.get_graph("nope")
    assert exc.value.status_code == 404


def test_filesystem_tree_read_edit_export_roundtrip(tmp_path, monkeypatch):
    # U1/U2: the project repo is browsable, any file is readable + editable
    # (write+commit), and the whole thing exports as a zip (D34).
    import io
    import zipfile

    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    pid = project["id"]

    # Tree: the seeded .lea/ dir shows; .git is hidden.
    tree = projects_route.get_tree(pid)["tree"]
    names = [e["name"] for e in tree]
    assert ".lea" in names and ".git" not in names

    # Read a seeded doc through the generic file endpoint.
    bp = projects_route.read_project_file(pid, ".lea/blueprint.md")
    assert bp["content"].startswith("# Blueprint")
    assert bp["lean"] is False

    # Edit a brand-new file → write + commit; reading it back returns the content.
    put = projects_route.write_project_file(pid, FilePut(path="notes/scratch.md", content="# hi\n"))
    assert len(put["commit_sha"]) == 40
    assert put["check"] is None  # not a .lean file
    assert projects_route.read_project_file(pid, "notes/scratch.md")["content"] == "# hi\n"

    # Export: a zip carrying the source + assets, excluding internals.
    resp = projects_route.export_project(pid)
    assert resp.media_type == "application/zip"
    with zipfile.ZipFile(io.BytesIO(resp.body)) as zf:
        entries = zf.namelist()
    assert any(n.endswith("/.lea/blueprint.md") for n in entries)
    assert any(n.endswith("/notes/scratch.md") for n in entries)
    assert not any("/.git/" in n for n in entries)


def test_write_lean_file_returns_check_verdict(tmp_path, monkeypatch):
    # A .lean edit re-uses the standalone check for a verdict (like the v2 canvas, D2).
    # interface_check is patched so the route doesn't invoke real Lean.
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))

    class _Result:
        status = "ok"
        detail = None

    monkeypatch.setattr(projects_route, "interface_check", lambda _path: _Result())
    put = projects_route.write_project_file(
        project["id"], FilePut(path="Foo.lean", content="theorem foo : True := trivial\n")
    )
    assert put["check"] == {"status": "ok", "detail": None}


def test_filesystem_path_guard_and_404s(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    pid = project["id"]

    # Path escape → 400 on both read and write.
    with pytest.raises(HTTPException) as e1:
        projects_route.read_project_file(pid, "../escape.txt")
    assert e1.value.status_code == 400
    with pytest.raises(HTTPException) as e2:
        projects_route.write_project_file(pid, FilePut(path="../sneaky.txt", content="x"))
    assert e2.value.status_code == 400

    # Missing file → 404; hidden dir → 400.
    with pytest.raises(HTTPException) as e3:
        projects_route.read_project_file(pid, "ghost.lean")
    assert e3.value.status_code == 404
    with pytest.raises(HTTPException) as e4:
        projects_route.read_project_file(pid, ".git/config")
    assert e4.value.status_code == 400

    # Missing project → 404 across all filesystem routes.
    for call in (
        lambda: projects_route.get_tree("nope"),
        lambda: projects_route.read_project_file("nope", "x"),
        lambda: projects_route.write_project_file("nope", FilePut(path="x", content="y")),
        lambda: projects_route.export_project("nope"),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404


def test_put_doc_feeds_composed_context(tmp_path, monkeypatch):
    # The edited Instructions/Memory must show up in the next run's context (D25/D26).
    from app import projects as project_service

    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    projects_route.put_instructions(project["id"], DocUpdate(content="Prove √2 is irrational."))
    projects_route.put_memory(project["id"], DocUpdate(content="- explicit witnesses preferred"))

    repo = proofs / "Lea" / "Analysis"
    msg = project_service.compose_context_message(store.get_project(project["id"]), repo)
    assert "Prove √2 is irrational." in msg["content"]
    assert "explicit witnesses preferred" in msg["content"]


# ── Git sharing: set remote + push (6b/U3, D34) ────────────────────────────────

def test_set_project_remote_valid_and_invalid(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    pid = projects_route.create_project(ProjectCreate(title="Share Me"))["id"]
    from app.routes.projects import RemoteUpdate

    res = projects_route.set_project_remote(pid, RemoteUpdate(remote_url="https://github.com/me/share-me.git/"))
    assert res["remote_url"] == "https://github.com/me/share-me.git"  # trailing slash stripped
    assert store.get_project(pid)["remote_url"] == "https://github.com/me/share-me.git"

    with pytest.raises(HTTPException) as ei:
        projects_route.set_project_remote(pid, RemoteUpdate(remote_url="ftp://example.com/x"))
    assert ei.value.status_code == 400


def test_push_guards_no_remote_then_no_token(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from app.routes.projects import RemoteUpdate
    pid = projects_route.create_project(ProjectCreate(title="NoShare"))["id"]

    with pytest.raises(HTTPException) as e1:
        projects_route.push_project(pid)
    assert e1.value.status_code == 400 and "remote" in e1.value.detail.lower()

    projects_route.set_project_remote(pid, RemoteUpdate(remote_url="https://github.com/me/noshare"))
    monkeypatch.setattr(projects_route, "github_token", lambda: None)
    with pytest.raises(HTTPException) as e2:
        projects_route.push_project(pid)
    assert e2.value.status_code == 400 and "token" in e2.value.detail.lower()


def test_push_to_local_bare_repo_functionally(tmp_path, monkeypatch):
    """Push really lands commits on the remote (token=None, a local bare repo as the
    remote). Proves push_to_github targets HEAD:refs/heads/main."""
    import subprocess
    from app.gitstore import GitStore

    proofs = _setup(tmp_path, monkeypatch)
    pid = projects_route.create_project(ProjectCreate(title="Pushy"))["id"]
    repo = projects_route.project_service.project_repo_dir(store.get_project(pid), proofs)
    (repo / "hello.txt").write_text("hi")
    GitStore(proofs).commit_all(repo, "add hello")

    bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(bare)], check=True)
    GitStore(proofs).push_to_github(repo, str(bare), token=None, branch="main")

    log = subprocess.run(
        ["git", "--git-dir", str(bare), "log", "--oneline", "main"],
        capture_output=True, text=True,
    )
    assert "add hello" in log.stdout


def test_push_failure_detail_suggests_lea_only_on_divergence():
    from app.routes.projects import _push_failure_detail
    diverged = _push_failure_detail("! [rejected] main -> main (non-fast-forward)\nUpdates were rejected")
    assert "reconcile" in diverged.lower() and "lea" in diverged.lower()
    auth = _push_failure_detail("fatal: Authentication failed for 'https://github.com/me/repo'")
    assert "reconcile" not in auth.lower()


def test_push_to_diverged_remote_points_at_lea(tmp_path, monkeypatch):
    """A real non-fast-forward push surfaces the 'ask Lea to reconcile' hint."""
    import subprocess
    from app.gitstore import GitStore

    proofs = _setup(tmp_path, monkeypatch)
    pid = projects_route.create_project(ProjectCreate(title="Diverged"))["id"]
    repo = projects_route.project_service.project_repo_dir(store.get_project(pid), proofs)
    (repo / "local.txt").write_text("local")
    GitStore(proofs).commit_all(repo, "local commit")

    bare = tmp_path / "remote.git"
    seed = tmp_path / "seed"
    subprocess.run(["git", "init", "--bare", "-q", str(bare)], check=True)
    subprocess.run(["git", "init", "-q", str(seed)], check=True)
    for k, v in (("user.email", "x@y.z"), ("user.name", "x")):
        subprocess.run(["git", "-C", str(seed), "config", k, v], check=True)
    (seed / "remote.txt").write_text("remote")
    subprocess.run(["git", "-C", str(seed), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(seed), "commit", "-q", "-m", "remote commit"], check=True)
    subprocess.run(["git", "-C", str(seed), "push", "-q", str(bare), "HEAD:refs/heads/main"], check=True)

    store.update_project(pid, remote_url=str(bare))
    monkeypatch.setattr(projects_route, "github_token", lambda: "ghp_dummy")

    with pytest.raises(HTTPException) as ei:
        projects_route.push_project(pid)
    assert ei.value.status_code == 502
    assert "reconcile" in ei.value.detail.lower() and "lea" in ei.value.detail.lower()
