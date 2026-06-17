"""CLI entry point that records an externally-started Lea API run.

The Overleaf companion starts a run against the Lea API directly and owns its
lifecycle (theorem-translation approvals, spend enforcement). To make that run
appear in the UI exactly like a UI-originated one, the companion spawns this
recorder as a subprocess. The recorder creates a session + run in the shared
store (tagged ``origin='overleaf'``), links it to the matching project, then
attaches as an additional event-stream subscriber via :func:`runner.record_run`
to persist the full process timeline.

It prints a single JSON object to stdout on completion:
``{"session_id": ..., "run_id": ..., "status": ...}``.

Usage:
    python -m app.recorder --api-run-id run_abc \\
        --task "Prove ..." --title "theorem-label" \\
        --project-slug myproj --project-path workspace/projects/myproj.md \\
        --origin overleaf --external-ref '{"overleaf_project_id": "..."}'
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from queue import Queue
from typing import Any

from .config import load_config
from .db import init_db
from .runner import RunnerContext, record_run
from . import store


def _build_project(
    *,
    slug: str | None,
    title: str | None,
    path: str | None,
    config,
) -> tuple[dict | None, dict | None]:
    """Return (project_row, project_payload) for an optional project slug."""
    if not slug:
        return None, None
    project = store.find_or_create_project(slug=slug, title=title, path=path)
    project_path = Path(str(project["path"]))
    context_text = ""
    if config.lea_root is not None:
        full_path = project_path if project_path.is_absolute() else config.lea_root / project_path
        if full_path.exists():
            context_text = full_path.read_text()
    payload = {
        "project_id": project["slug"],
        "project_slug": project["slug"],
        "project_title": project["title"],
        "project_path": str(project_path),
        "project_context": context_text,
        "record_on_success": True,
    }
    return project, payload


def _parse_external_ref(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def run(argv: list[str] | None = None) -> dict:
    parser = argparse.ArgumentParser(description="Record an externally-started Lea API run into the shared store.")
    parser.add_argument("--api-run-id", required=True, help="The Lea API run_id to record.")
    parser.add_argument("--task", default="", help="The task/prompt text (stored as the user message).")
    parser.add_argument("--title", default="", help="Session title (defaults to the task).")
    parser.add_argument("--origin", default="overleaf", help="Origin tag for the session/run.")
    parser.add_argument("--model", default=None, help="Model id (defaults to configured model).")
    parser.add_argument("--provider", default=None, help="Provider name.")
    parser.add_argument("--max-turns", type=int, default=None, help="Max turns for the run.")
    parser.add_argument("--project-slug", default=None, help="Project slug to link this run to.")
    parser.add_argument("--project-title", default=None, help="Project title (used only when creating it).")
    parser.add_argument("--project-path", default=None, help="Project markdown path (used only when creating it).")
    parser.add_argument("--external-ref", default=None, help="JSON object of origin-specific identifiers.")
    args = parser.parse_args(argv)

    init_db()
    config = load_config()

    project, project_payload = _build_project(
        slug=args.project_slug,
        title=args.project_title,
        path=args.project_path,
        config=config,
    )
    project_id = project["id"] if project else None

    title = (args.title or args.task or "Overleaf formalization").strip()
    external_ref = _parse_external_ref(args.external_ref)
    session = store.create_session(
        title,
        project_id=project_id,
        origin=args.origin,
        external_ref=external_ref,
    )
    run_row = store.create_run(
        session["id"],
        args.model or config.model,
        args.provider,
        args.max_turns if args.max_turns is not None else config.max_turns,
        project_id=project_id,
        origin=args.origin,
    )
    if args.task.strip():
        store.add_message(session["id"], "user", args.task.strip(), run_row["id"])

    context = RunnerContext(
        session_id=session["id"],
        run_id=run_row["id"],
        task=args.task,
        config=config,
        events=Queue(),
        project=project_payload,
    )
    status = record_run(context, args.api_run_id)
    return {"session_id": session["id"], "run_id": run_row["id"], "status": status}


def main(argv: list[str] | None = None) -> int:
    result = run(argv)
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
    return 0 if result["status"] in {"success"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
