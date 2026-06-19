"""Global search endpoint (V1, D31/D41).

`GET /api/search?q=` returns sessions whose title — or whose project's title —
matches the query, each tagged with its project. This is the *only* path to a
project session: the sidebar hides in-project sessions (D30), so search is
load-bearing, not a nicety. The query work lives in `store.search_sessions`
(SQLite LIKE); this route is the thin HTTP layer.
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import store

router = APIRouter()


@router.get("/api/search")
def search(q: str = "") -> dict:
    return {"results": store.search_sessions(q)}
