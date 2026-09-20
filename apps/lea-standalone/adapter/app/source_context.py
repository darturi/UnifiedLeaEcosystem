"""Freeze source evidence at admission; preserve target vs evidence hash semantics."""
import hashlib
import json
from .alignment_schemas import SourceBundle


def source_hash(bundle: dict, *, identity=False) -> str:
    proof = bundle.get("proofAssociation") or {}
    value = {
        "version": bundle["version"], "targetKey": bundle["targetKey"],
        "targetKind": bundle.get("targetKind", "theorem"), "statement": bundle["statement"],
        "proof": bundle.get("proof", ""),
        "proofAssociation": {k: proof.get(k) for k in ("status", "method", "sourceFile", "proofHash")},
        "uses": bundle.get("uses") or [], "context": bundle.get("context") or "",
        "relevantSource": [] if identity else bundle.get("relevantSource") or [],
        "mirror": None if identity else bundle.get("mirror"),
    }
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def validate_source(bundle: dict) -> dict:
    value = SourceBundle.model_validate(bundle).model_dump()
    evidence = source_hash(value)
    identity = source_hash(value, identity=True)
    if value["bundleHash"] != evidence:
        raise ValueError("source bundle hash does not match its contents")
    if bundle.get("sourceIdentityHash") and bundle["sourceIdentityHash"] != identity:
        raise ValueError("source identity hash does not match its contents")
    value["sourceIdentityHash"] = identity
    return value
