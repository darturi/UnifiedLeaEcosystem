"""HTTP routes split by resource. `main.py` wires these together; each module
owns one resource's endpoints (D2). Routers are plain `APIRouter`s with no shared
state beyond the store / bridge / config modules they import."""
