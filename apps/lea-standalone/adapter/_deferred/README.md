# Deferred to v2.1 — Projects

These modules implement the **Projects** feature (grouping proved theorems into a
named Lean namespace/module). v2 is deliberately project-free (architecture: see
`design/v2-architecture.md` §7 "Deferred / future"); this code is parked here,
out of the active `app/` package and out of the pytest `testpaths`, until v2.1.

- `project_assignment.py` / `project_unassignment.py` — move a proof into/out of a
  project (rewrite namespace, relocate the `.lean`, update the markdown index,
  re-verify) .
- `project_usage.py` — detect cross-theorem project-formalization dependencies.
- `test_project_usage.py` — its test suite.

**On re-integration (v2.1):** these were written against the pre-v2 schema. They
use relative imports (`from .config import …`) that assume placement in `app/`,
and reference `code_steps` columns the v2 clean rebuild dropped (`code`, `kind`,
`used_project_formalizations`) plus store helpers since removed. Expect to rewrite
the store/db project layer against the v2 pointer-based `code_steps` (git owns
content) before wiring the API back into `main.py`.
