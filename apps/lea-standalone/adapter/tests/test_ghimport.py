"""W4 tests: GitHub import for skills (D56). URL normalization is pure and unit-
tested directly; the clone→locate→snapshot path is exercised against a real *local*
git repo used as the clone source (git clone accepts a filesystem path), with
`normalize_github_url` monkeypatched to point at it — no network."""

import subprocess

import pytest

from app import ghimport


# ── URL normalization (pure) ─────────────────────────────────────────────────


def test_normalize_repo_root():
    t = ghimport.normalize_github_url("https://github.com/owner/repo")
    assert t.clone_url == "https://github.com/owner/repo.git"
    assert t.repo_name == "repo"
    assert t.ref is None and t.subdir == "" and t.explicit_file is None


def test_normalize_strips_dot_git():
    t = ghimport.normalize_github_url("https://github.com/owner/repo.git")
    assert t.clone_url == "https://github.com/owner/repo.git"
    assert t.repo_name == "repo"


def test_normalize_tree_subdir():
    t = ghimport.normalize_github_url("https://github.com/owner/repo/tree/main/skills/ring")
    assert t.ref == "main"
    assert t.subdir == "skills/ring"
    assert t.explicit_file is None


def test_normalize_blob_file():
    t = ghimport.normalize_github_url("https://github.com/owner/repo/blob/dev/skills/ring.md")
    assert t.ref == "dev"
    assert t.explicit_file == "skills/ring.md"


def test_normalize_blob_non_md_rejected():
    with pytest.raises(ghimport.GitHubImportError):
        ghimport.normalize_github_url("https://github.com/owner/repo/blob/main/src/main.py")


def test_normalize_raw_file():
    t = ghimport.normalize_github_url("https://raw.githubusercontent.com/owner/repo/main/a/b.md")
    assert t.clone_url == "https://github.com/owner/repo.git"
    assert t.ref == "main"
    assert t.explicit_file == "a/b.md"


def test_normalize_raw_non_md_rejected():
    with pytest.raises(ghimport.GitHubImportError):
        ghimport.normalize_github_url("https://raw.githubusercontent.com/o/r/main/a/b.txt")


def test_normalize_gist():
    t = ghimport.normalize_github_url("https://gist.github.com/someone/abc123")
    assert t.clone_url == "https://gist.github.com/abc123.git"


def test_normalize_rejects_non_github_and_bad_scheme():
    with pytest.raises(ghimport.GitHubImportError):
        ghimport.normalize_github_url("https://gitlab.com/o/r")
    with pytest.raises(ghimport.GitHubImportError):
        ghimport.normalize_github_url("git@github.com:o/r.git")
    with pytest.raises(ghimport.GitHubImportError):
        ghimport.normalize_github_url("https://github.com/only-owner")


# ── clone → locate → snapshot (against a local git repo) ─────────────────────


def _make_repo(path, files: dict[str, str]):
    """A real git repo at `path` seeded with `files` (relative path → content)."""
    path.mkdir(parents=True)
    for rel, content in files.items():
        f = path / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content)
    for args in (
        ["init", "-q"],
        ["config", "user.name", "t"],
        ["config", "user.email", "t@t"],
        ["add", "-A"],
        ["commit", "-q", "-m", "seed"],
    ):
        subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True)
    return path


def _point_at(monkeypatch, repo, *, subdir="", explicit_file=None):
    target = ghimport.ImportTarget(
        clone_url=str(repo), repo_name="repo", subdir=subdir,
        explicit_file=explicit_file, source_url="https://github.com/you/repo",
    )
    monkeypatch.setattr(ghimport, "normalize_github_url", lambda url: target)


def test_fetch_snapshots_skill_md(tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "remote", {"SKILL.md": "# Ring\nuse `ring`", "README.md": "ignore"})
    _point_at(monkeypatch, repo)

    imported = ghimport.fetch_skill("https://github.com/you/repo")
    assert imported.body == "# Ring\nuse `ring`"          # SKILL.md wins over README.md
    assert imported.source_url == "https://github.com/you/repo"
    assert imported.source_ref                            # resolved to the cloned HEAD sha
    assert imported.name == "repo"                        # generic name → repo name


def test_fetch_prefers_readme_then_first_md(tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "remote", {"README.md": "readme body", "zzz.md": "other"})
    _point_at(monkeypatch, repo)
    assert ghimport.fetch_skill("https://github.com/you/repo").body == "readme body"

    repo2 = _make_repo(tmp_path / "remote2", {"alpha.md": "A body", "beta.md": "B body"})
    _point_at(monkeypatch, repo2)
    imported = ghimport.fetch_skill("https://github.com/you/repo")
    assert imported.body == "A body"       # first *.md, sorted
    assert imported.name == "alpha"        # named file → its stem


def test_fetch_explicit_file(tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "remote", {"skills/foo-bar.md": "foo body", "README.md": "root"})
    _point_at(monkeypatch, repo, explicit_file="skills/foo-bar.md")

    imported = ghimport.fetch_skill("https://github.com/you/repo/blob/main/skills/foo-bar.md")
    assert imported.body == "foo body"
    assert imported.name == "foo bar"      # stem, separators → spaces


def test_fetch_subdir(tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "remote", {"README.md": "root", "sub/SKILL.md": "sub skill"})
    _point_at(monkeypatch, repo, subdir="sub")
    assert ghimport.fetch_skill("https://github.com/you/repo/tree/main/sub").body == "sub skill"


def test_fetch_no_markdown_is_error(tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "remote", {"code.py": "print('hi')"})
    _point_at(monkeypatch, repo)
    with pytest.raises(ghimport.GitHubImportError):
        ghimport.fetch_skill("https://github.com/you/repo")


def test_fetch_missing_explicit_file_is_error(tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "remote", {"README.md": "root"})
    _point_at(monkeypatch, repo, explicit_file="nope.md")
    with pytest.raises(ghimport.GitHubImportError):
        ghimport.fetch_skill("https://github.com/you/repo/blob/main/nope.md")


def test_fetch_cleans_up_temp_clone(tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "remote", {"SKILL.md": "body"})
    _point_at(monkeypatch, repo)
    seen: dict = {}

    real_mkdtemp = ghimport.tempfile.mkdtemp

    def spy(*a, **k):
        path = real_mkdtemp(*a, **k)
        seen["path"] = path
        return path

    monkeypatch.setattr(ghimport.tempfile, "mkdtemp", spy)
    ghimport.fetch_skill("https://github.com/you/repo")
    from pathlib import Path
    assert not Path(seen["path"]).exists()   # temp clone dir removed in finally
