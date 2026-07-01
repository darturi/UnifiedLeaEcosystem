"""Per-session git store — git owns proof-content history (architecture D7/D8).

Each session is its own git repo at ``<proofs_root>/<session-id>/`` (the proof
``.lean`` files live there so Lake/Lean can compile them; the ``.git`` dir is
invisible to Lake). The adapter — not the prover — owns this store: the prover is
a stateless library, and the adapter is the single source of truth for history.

This module grows across Group B:
  - B1 (here): per-session repo init.
  - B2: commit on every write, with turn/author/tool metadata.
  - B3: read path — snapshot via ``git show``, step diff via ``git diff``.
  - B4: diff-on-divergence — diff since the last agent commit.

A ``GitStore`` holds the proofs root so it can be pointed at a scratch dir in
tests without monkeypatching. The adapter constructs one at startup:
``GitStore(config.lea_root / "workspace" / "proofs")``.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from urllib.parse import urlparse, urlunparse

# Identity for commits the adapter makes on the agent's behalf. Set repo-locally
# at init so the store never depends on the host's global git config (there is
# none in Docker/CI, where a global-less ``git commit`` would otherwise fail).
GIT_USER_NAME = "lea"
GIT_USER_EMAIL = "lea@nyu.edu"

# Co-author trailer appended to commit messages (Claude-Code style), so the proof
# history attributes work to Lea even when the committer is the adapter process.
CO_AUTHOR_TRAILER = f"Co-authored-by: Lea <{GIT_USER_EMAIL}>"


class GitStoreError(RuntimeError):
    """A git invocation failed. Carries the failing command's stderr."""


def commit_message(subject: str) -> str:
    """A commit subject plus the Lea co-author trailer (blank line between)."""
    return f"{subject}\n\n{CO_AUTHOR_TRAILER}"


def _inject_token(remote_url: str, token: str) -> str:
    """Embed the token into an https remote URL for a single push (D34).

    `https://github.com/owner/repo(.git)` → `https://x-access-token:<token>@github.com/owner/repo`.
    Only https/http URLs are rewritten; ssh/other schemes are returned unchanged
    (the token can't help there). The result is used as a one-shot push target and
    is never written to `.git/config`, so the token never lands on disk."""
    parsed = urlparse(remote_url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        return remote_url
    netloc = f"x-access-token:{token}@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse((parsed.scheme, netloc, parsed.path, "", "", ""))


def _scrub(text: str, token: str | None) -> str:
    """Remove the token from any git output before it's surfaced/logged — git echoes
    the (tokenized) URL in errors, which would otherwise leak the credential."""
    return text.replace(token, "***") if token else text


class GitStore:
    def __init__(self, proofs_root: Path | str):
        self.root = Path(proofs_root)

    def session_repo(self, session_id: str) -> Path:
        """The repo path for a session. Pure — no side effects, no I/O."""
        return self.root / session_id

    # ── Generalized primitives (D24) ──────────────────────────────────────────
    # A repo is just a directory with a `.git`; loose sessions resolve it from the
    # session id, projects from `proofs/Lea/<Project>` (the shared repo). These two
    # operate on an explicit path so a project session and a loose session share one
    # git implementation; the `session_id` methods below delegate to them.

    def init_repo(self, repo: Path, *, subject: str = "repo init") -> Path:
        """Create (or no-op if present) a git repo at ``repo`` and return its path.

        Idempotent: a second call leaves an existing repo untouched and adds no
        commit. The empty root commit guarantees ``HEAD`` resolves from the very
        start, so the read paths never hit the "no commits yet" edge."""
        if (repo / ".git").is_dir():
            return repo  # already initialised — re-init/resume is a no-op
        repo.mkdir(parents=True, exist_ok=True)
        self._git(repo, "init", "-q")
        self._git(repo, "config", "user.name", GIT_USER_NAME)
        self._git(repo, "config", "user.email", GIT_USER_EMAIL)
        self._git(repo, "commit", "--allow-empty", "-q", "-m", commit_message(subject))
        return repo

    def commit_all(self, repo: Path, subject: str) -> str:
        """Stage everything under ``repo`` and commit it with ``subject``; return the
        new SHA (or the unchanged HEAD when nothing is staged). The single commit
        primitive every write path funnels through (D8: commit on every write)."""
        self._git(repo, "add", "-A")
        staged = self._git(repo, "diff", "--cached", "--name-only").strip()
        if not staged:
            return self._git(repo, "rev-parse", "HEAD").strip()
        self._git(repo, "commit", "-q", "-m", commit_message(subject))
        return self._git(repo, "rev-parse", "HEAD").strip()

    def commit_write(self, session_id: str, *, turn, author: str = "agent", tool: str) -> str:
        """Commit the current state of the session repo and return the new SHA.

        Called after the agent's `write_file`/`edit_file` lands a file (D8: commit
        on *every* write — including failed/non-compiling states; git doesn't care
        whether the Lean compiles). `turn`/`author`/`tool` are passed through to the
        caller's `code_steps` DB insert, which is the query surface for them — they
        are NOT baked into git as machine-readable fields (that would duplicate the
        DB). The commit subject is a human-readable label for `git log`; the only
        real git metadata is the `Co-authored-by: Lea` attribution trailer.

        An identical write (nothing staged) makes no commit and returns the current
        HEAD — an unchanged file is not a new state.
        """
        repo = self.session_repo(session_id)
        # Build the subject first; commit_all formats files generically, but the
        # session label carries author/tool/turn for `git log` readability.
        self._git(repo, "add", "-A")
        staged = self._git(repo, "diff", "--cached", "--name-only").strip()
        if not staged:
            return self._git(repo, "rev-parse", "HEAD").strip()
        files = ", ".join(staged.splitlines())
        suffix = f" (turn {turn})" if turn is not None else ""  # user edits have no turn
        self._git(repo, "commit", "-q", "-m", commit_message(f"{author} {tool}: {files}{suffix}"))
        return self._git(repo, "rev-parse", "HEAD").strip()

    def head(self, session_id: str) -> str:
        """The session repo's current HEAD sha (the latest committed state)."""
        return self._git(self.session_repo(session_id), "rev-parse", "HEAD").strip()

    def push_to_github(self, repo: Path, remote_url: str, token: str | None, *, branch: str = "main") -> str:
        """Push ``repo``'s current HEAD to ``remote_url``'s ``branch`` (D34).

        The token (when given) is injected into the push URL for *this invocation
        only* — passed as the push target, never via ``git remote set-url`` — so it
        is never persisted to ``.git/config``. The token is scrubbed from both the
        success summary and any error before they leave this method, since git echoes
        the URL (with the token) in its messages. Raises ``GitStoreError`` (scrubbed)
        on a failed push (auth, non-fast-forward, unreachable, …)."""
        push_url = _inject_token(remote_url, token) if token else remote_url
        try:
            out = self._git(repo, "push", push_url, f"HEAD:refs/heads/{branch}")
        except GitStoreError as exc:
            raise GitStoreError(_scrub(str(exc), token)) from None
        return _scrub(out, token).strip()

    def init_session(self, session_id: str) -> Path:
        """Create (or no-op if present) the session's git repo and return its path.

        Thin wrapper over :meth:`init_repo` for the loose per-session repo."""
        return self.init_repo(self.session_repo(session_id), subject="session init")

    def snapshot(self, session_id: str, sha: str, path: str) -> str:
        """File content at a commit — `git show <sha>:<path>`. The canvas stepper.

        Reconstructs any historical step's content from the SHA + path the DB row
        stores. A path absent at this commit (e.g. the file didn't exist yet)
        returns `""` — a normal empty-canvas state. A bad SHA raises (ls-tree
        errors on an unknown rev), so "no such file" and "no such commit" stay
        distinct. Exact bytes, trailing newline preserved — the canvas sees
        precisely what was committed.
        """
        repo = self.session_repo(session_id)
        listed = self._git(repo, "ls-tree", "--name-only", sha, "--", path).strip()
        if not listed:
            return ""
        return self._git(repo, "show", f"{sha}:{path}")

    def uncommitted_diff(self, session_id: str) -> str:
        """The working-tree change not yet committed — `git diff HEAD`.

        Captures a human canvas edit at the moment of divergence: the Save endpoint
        writes the edited content to the file, calls this (working tree now differs
        from HEAD, which is the agent's last committed state), then commits via
        `commit_write(author="user")`. Must run *before* the commit — afterward the
        working tree is clean and this returns "". This is why we need neither a
        cached `last_agent_sha` nor a git-log boundary scan: the delta is captured
        exactly when it happens. `""` when nothing is uncommitted.
        """
        return self._git(self.session_repo(session_id), "diff", "HEAD")

    def diff(self, session_id: str, sha_a: str, sha_b: str, path: str | None = None) -> str:
        """Change between two steps — `git diff <a> <b> [-- <path>]`. The step-diff view.

        `path` scopes the diff to one file (the canvas passes it from the DB row);
        omitted, it diffs the whole session repo. Accepts any revspecs, so callers
        can diff against `HEAD`. Returns `""` when there is no change.
        """
        repo = self.session_repo(session_id)
        args = ["diff", sha_a, sha_b]
        if path is not None:
            args += ["--", path]
        return self._git(repo, *args)

    def _git(self, repo: Path, *args: str) -> str:
        """Run ``git <args>`` in ``repo`` and return stdout; raise on non-zero exit."""
        proc = subprocess.run(
            ["git", *args],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise GitStoreError(f"git {args[0]} failed: {proc.stderr.strip()}")
        return proc.stdout
