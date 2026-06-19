"""Unit tests for the blueprint parser + validator (T1, D28).

Pure functions over markdown text — no repo/DB needed. The contract under test: a
fence-aware line-scan that tolerates sloppy prose, and a validator that returns
advisory warnings (never raises)."""

from app import blueprint


def test_parse_basic_node():
    text = (
        "# Blueprint — Epsilon\n\n"
        "## continuous_sq\n"
        "- kind: lemma\n"
        "- lean: `Lea.Epsilon.continuous_sq`\n"
        "- uses: tendsto_iff_eps, distance_lower\n"
        "\n"
        "The function x ↦ x² is continuous in the ε–δ sense.\n"
    )
    parsed = blueprint.parse(text)
    assert len(parsed["nodes"]) == 1
    node = parsed["nodes"][0]
    assert node["key"] == "continuous_sq"
    assert node["kind"] == "lemma"
    # Backticks around the decl are stripped.
    assert node["lean"] == "Lea.Epsilon.continuous_sq"
    assert node["uses"] == ["tendsto_iff_eps", "distance_lower"]
    assert "continuous in the ε–δ sense" in node["statement"]
    # The `# Blueprint` title is not a node and not in the statement.
    assert "Blueprint — Epsilon" not in node["statement"]


def test_parse_edges_from_uses():
    text = (
        "## a\n- kind: lemma\n- uses: b, c\n\nstatement a\n"
        "## b\n- kind: lemma\n\nstatement b\n"
        "## c\n- kind: definition\n\nstatement c\n"
    )
    parsed = blueprint.parse(text)
    assert [n["key"] for n in parsed["nodes"]] == ["a", "b", "c"]
    assert parsed["edges"] == [{"from": "a", "to": "b"}, {"from": "a", "to": "c"}]


def test_parse_missing_fields_are_none():
    # A planned node: named, no decl yet, no deps.
    parsed = blueprint.parse("## planned\n- kind: theorem\n\nTODO state it.\n")
    node = parsed["nodes"][0]
    assert node["kind"] == "theorem"
    assert node["lean"] is None
    assert node["uses"] == []
    assert parsed["edges"] == []


def test_parse_ignores_fenced_example():
    # A ```-fenced example (as in the seed) must NOT register as a real node.
    text = (
        "# Blueprint — Demo\n\n"
        "Here is the format:\n\n"
        "```\n"
        "## example_node\n"
        "- kind: lemma\n"
        "- uses: somewhere\n"
        "```\n\n"
        "## real_node\n"
        "- kind: lemma\n\n"
        "An actual node.\n"
    )
    parsed = blueprint.parse(text)
    assert [n["key"] for n in parsed["nodes"]] == ["real_node"]
    assert parsed["edges"] == []


def test_parse_tolerates_garbage_lines():
    # Prose, stray dashes, and non-header bullets never break the scan.
    text = (
        "## node\n"
        "- kind: lemma\n"
        "- some random bullet that is not a header\n"
        "Let $f : [0,1] \\to \\mathbb{R}$ be continuous: with a colon, even.\n"
        "- another: not-a-recognised-key\n"
    )
    parsed = blueprint.parse(text)
    assert len(parsed["nodes"]) == 1
    node = parsed["nodes"][0]
    assert node["kind"] == "lemma"
    # Unrecognised `- key:` lines fall through to the statement, not the header.
    assert "another: not-a-recognised-key" in node["statement"]
    assert "with a colon, even" in node["statement"]


def test_parse_empty_text():
    parsed = blueprint.parse("")
    assert parsed == {"nodes": [], "edges": []}


def test_validate_clean_blueprint_has_no_warnings():
    text = (
        "## a\n- kind: lemma\n- uses: b\n\nstmt a\n"
        "## b\n- kind: definition\n\nstmt b\n"
    )
    assert blueprint.validate(text) == []


def test_validate_flags_dangling_edge():
    warnings = blueprint.validate("## a\n- kind: lemma\n- uses: ghost\n\nstmt\n")
    assert any("ghost" in w["message"] and w["node"] == "a" for w in warnings)


def test_validate_flags_missing_and_unknown_kind():
    warnings = blueprint.validate("## a\n\nno kind here\n## b\n- kind: corollary\n\nbad kind\n")
    messages = " ".join(w["message"] for w in warnings)
    assert "no `kind:`" in messages
    assert "unrecognised kind `corollary`" in messages


def test_validate_flags_duplicate_keys():
    warnings = blueprint.validate("## a\n- kind: lemma\n\none\n## a\n- kind: lemma\n\ntwo\n")
    assert any("duplicate node key `a`" in w["message"] for w in warnings)
