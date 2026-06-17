from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


MONOREPO_ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = MONOREPO_ROOT / "packages" / "lea-model-catalog" / "models.json"


@lru_cache(maxsize=1)
def _catalog() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text())


def default_model() -> str:
    return str(_catalog()["default_model"])


def model_options() -> list[dict[str, str]]:
    return [dict(option) for option in _catalog()["models"]]


def model_families() -> list[dict[str, Any]]:
    return [dict(family) for family in _catalog()["families"]]
