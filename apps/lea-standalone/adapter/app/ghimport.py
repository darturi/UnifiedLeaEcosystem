"""GitHub import for skills — the "paste a link → Add" path (v2.1.1 W4, D56).

The primary way to add a skill is a GitHub URL. We fetch by **shallow clone**
(no API tokens for public repos, no rate-limited contents API), locate the skill
markdown, and **snapshot** it into the skill's `body` (D45 — the row is the
source of truth, not a live link). `source_url` + `source_ref` are recorded so a
later re-sync is possible.

Supported URL shapes (`normalize_github_url`):
  - repo root:  https://github.com/owner/repo(.git)
  - a subtree:  https://github.com/owner/repo/tree/<ref>/<subdir>
  - a file:     https://github.com/owner/repo/blob/<ref>/<path>.md
  - raw file:   https://raw.githubusercontent.com/owner/repo/<ref>/<path>.md
  - a gist:     https://gist.github.com/<user>/<id>  (or /<id>)

Locating the md when the URL points at a repo/subtree (not a specific file):
`SKILL.md` → `README.md` → the first `*.md` found (D56). Guards: shallow clone
(`--depth 1`), a clone timeout, and a body-size cap; the temp clone dir is always
removed. The token (when configured) is injected into the clone URL for private
repos and scrubbed from any error — public repos need none.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .gitstore import _inject_token, _scrub

# Guards (D56): a shallow clone shouldn't hang or drag in a giant file.
CLONE_TIMEOUT_SECONDS = 60
MAX_BODY_BYTES = 256 * 1024  # a skill is prose; 256 KB is already generous

_PRIORITY_MD = ("SKILL.md", "README.md")


class GitHubImportError(RuntimeError):
    """The URL was unusable, the clone failed, or no skill markdown was found."""


@dataclass
class ImportTarget:
    """A normalized GitHub reference: what to clone, at which ref, and where to
    look inside it. `explicit_file` (relative to the repo root) is set when the URL
    points at one file; otherwise `subdir` is the directory to search."""

    clone_url: str
    repo_name: str
    ref: str | None = None
    subdir: str = ""
    explicit_file: str | None = None
    source_url: str = ""


@dataclass
class ImportedSkill:
    name: str
    body: str
    source_url: str
    source_ref: str | None


def normalize_github_url(url: str) -> ImportTarget:
    """Parse a GitHub-flavored URL into an `ImportTarget`. Raises on anything that
    isn't a github.com / raw.githubusercontent.com / gist.github.com URL."""
    raw = (url or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme not in ("https", "http"):
        raise GitHubImportError("Enter an https GitHub URL (repo, file, or gist).")
    host = (parsed.hostname or "").lower()
    parts = [p for p in parsed.path.split("/") if p]

    if host in ("github.com", "www.github.com"):
        return _target_from_github(parts, raw)
    if host == "raw.githubusercontent.com":
        return _target_from_raw(parts, raw)
    if host == "gist.github.com":
        return _target_from_gist(parts, raw)
    raise GitHubImportError(
        "Not a GitHub URL. Use github.com, raw.githubusercontent.com, or gist.github.com."
    )


def _target_from_github(parts: list[str], source_url: str) -> ImportTarget:
    if len(parts) < 2:
        raise GitHubImportError("That GitHub URL is missing an owner/repo.")
    owner, repo = parts[0], parts[1]
    repo = repo[:-4] if repo.endswith(".git") else repo
    clone_url = f"https://github.com/{owner}/{repo}.git"
    target = ImportTarget(clone_url=clone_url, repo_name=repo, source_url=source_url)
    # …/tree/<ref>/<subdir…>  or  …/blob/<ref>/<path…>
    if len(parts) >= 4 and parts[2] in ("tree", "blob"):
        target.ref = parts[3]
        rest = "/".join(parts[4:])
        if parts[2] == "blob":
            if not rest.endswith(".md"):
                raise GitHubImportError("A GitHub file link must point at a .md file.")
            target.explicit_file = rest
        else:
            target.subdir = rest
    return target


def _target_from_raw(parts: list[str], source_url: str) -> ImportTarget:
    # raw.githubusercontent.com/owner/repo/<ref>/<path…>
    if len(parts) < 4:
        raise GitHubImportError("That raw URL is missing owner/repo/ref/path.")
    owner, repo, ref = parts[0], parts[1], parts[2]
    path = "/".join(parts[3:])
    if not path.endswith(".md"):
        raise GitHubImportError("A raw file link must point at a .md file.")
    return ImportTarget(
        clone_url=f"https://github.com/{owner}/{repo}.git",
        repo_name=repo, ref=ref, explicit_file=path, source_url=source_url,
    )


def _target_from_gist(parts: list[str], source_url: str) -> ImportTarget:
    # gist.github.com/<user>/<id>  or  gist.github.com/<id>
    if not parts:
        raise GitHubImportError("That gist URL is missing an id.")
    gist_id = parts[-1]
    return ImportTarget(
        clone_url=f"https://gist.github.com/{gist_id}.git",
        repo_name=gist_id, source_url=source_url,
    )


def fetch_skill(url: str, token: str | None = None) -> ImportedSkill:
    """Import a skill from a GitHub URL: normalize → shallow-clone → locate the md →
    snapshot into `body`. Returns the raw material (name/body/provenance); the caller
    persists + assigns. Raises `GitHubImportError` on any failure (message scrubbed
    of the token)."""
    target = normalize_github_url(url)
    dest = Path(tempfile.mkdtemp(prefix="lea-ghimport-"))
    try:
        _clone(target, dest, token)
        md_path = _locate_md(dest, target)
        if md_path.stat().st_size > MAX_BODY_BYTES:
            raise GitHubImportError("That markdown file is too large to import as a skill.")
        body = md_path.read_text(encoding="utf-8", errors="replace").strip()
        if not body:
            raise GitHubImportError("The skill markdown file is empty.")
        return ImportedSkill(
            name=_derive_name(md_path, dest, target),
            body=body,
            source_url=target.source_url,
            source_ref=target.ref or _head_sha(dest),
        )
    finally:
        shutil.rmtree(dest, ignore_errors=True)


def _clone(target: ImportTarget, dest: Path, token: str | None) -> None:
    """Shallow-clone `target` into `dest`. Tries the pinned ref first (branch/tag),
    then falls back to the default branch (a commit-SHA ref can't be `--branch`ed on
    a shallow clone). The token is injected for the clone only; errors are scrubbed."""
    clone_url = _inject_token(target.clone_url, token) if token else target.clone_url
    attempts: list[list[str]] = []
    if target.ref:
        attempts.append(["clone", "--depth", "1", "--branch", target.ref, clone_url, str(dest)])
    attempts.append(["clone", "--depth", "1", clone_url, str(dest)])

    last_err = "clone failed"
    for args in attempts:
        # Each attempt needs an empty dest (git refuses a non-empty target).
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        try:
            proc = subprocess.run(
                ["git", *args], capture_output=True, text=True, timeout=CLONE_TIMEOUT_SECONDS
            )
        except subprocess.TimeoutExpired:
            raise GitHubImportError("Timed out cloning the repository.") from None
        if proc.returncode == 0:
            return
        last_err = _scrub(proc.stderr.strip() or "clone failed", token)
    raise GitHubImportError(f"Could not clone the repository: {last_err}")


def _locate_md(dest: Path, target: ImportTarget) -> Path:
    """Find the skill markdown (D56). An explicit file wins; otherwise search the
    subdir for SKILL.md → README.md → the first *.md."""
    if target.explicit_file:
        f = dest / target.explicit_file
        if not f.is_file():
            raise GitHubImportError(f"File not found in the repo: {target.explicit_file}")
        return f
    base = dest / target.subdir if target.subdir else dest
    if not base.is_dir():
        raise GitHubImportError(f"Path not found in the repo: {target.subdir}")
    for name in _PRIORITY_MD:
        cand = _find_ci(base, name)
        if cand:
            return cand
    mds = sorted(p for p in base.rglob("*.md") if _in_repo(p))
    if mds:
        return mds[0]
    raise GitHubImportError("No markdown (.md) file found to import as a skill.")


def _find_ci(base: Path, name: str) -> Path | None:
    """A direct child of `base` whose name matches `name` case-insensitively."""
    target = name.lower()
    for child in base.iterdir():
        if child.is_file() and child.name.lower() == target:
            return child
    return None


def _in_repo(path: Path) -> bool:
    """Skip anything inside a `.git` dir when scanning for markdown."""
    return ".git" not in path.parts


def _derive_name(md_path: Path, dest: Path, target: ImportTarget) -> str:
    """A friendly default name (user-editable later). A generic README/SKILL file
    takes its containing directory's name (or the repo name at the root); a named
    file uses its stem. Separators become spaces."""
    stem = md_path.stem
    if stem.lower() in ("readme", "skill"):
        parent = md_path.parent
        raw = target.repo_name if parent == dest else parent.name
    else:
        raw = stem
    name = raw.replace("-", " ").replace("_", " ").strip()
    return name or target.repo_name


def _head_sha(dest: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(dest), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
    except subprocess.SubprocessError:
        return None
    return proc.stdout.strip() or None if proc.returncode == 0 else None
