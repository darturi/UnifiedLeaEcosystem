from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Mapping


ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_dotenv(content: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if not ENV_KEY_RE.match(key):
            continue
        values[key] = _parse_env_value(value.strip())
    return values


def read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    return parse_dotenv(path.read_text())


def merged_env(file_values: Mapping[str, str] | None = None, environ: Mapping[str, str] | None = None) -> dict[str, str]:
    return {**dict(file_values or {}), **dict(environ or os.environ)}


def patch_dotenv(path: Path, updates: Mapping[str, Any]) -> None:
    patch = {key: value for key, value in updates.items() if ENV_KEY_RE.match(key)}
    if not patch:
        return

    lines = path.read_text().splitlines() if path.exists() else []
    next_lines: list[str] = []
    seen: set[str] = set()
    key_pattern = re.compile(r"^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$")

    for line in lines:
        match = key_pattern.match(line)
        if not match or match.group(2) not in patch:
            next_lines.append(line)
            continue
        key = match.group(2)
        seen.add(key)
        value = patch[key]
        if value is None or value == "":
            continue
        next_lines.append(f"{match.group(1)}{key}{match.group(3)}{format_env_value(value)}")

    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    for key, value in patch.items():
        if key not in seen and value is not None and value != "":
            next_lines.append(f"{key}={format_env_value(value)}")

    while next_lines and not next_lines[-1]:
        next_lines.pop()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(next_lines).rstrip() + "\n")


def format_env_value(value: Any) -> str:
    text = str(value)
    if re.search(r"""[\s#"'\\]""", text):
        return json.dumps(text)
    return text


def _parse_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        if value[0] == '"':
            try:
                parsed = json.loads(value)
                return str(parsed)
            except json.JSONDecodeError:
                pass
        return value[1:-1]
    return value
