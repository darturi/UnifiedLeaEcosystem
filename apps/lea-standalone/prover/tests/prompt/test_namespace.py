"""Tests for load_system_prompt's `namespace` parameter (D32).

The prover stays project-agnostic: the only project-aware knob is a namespace
string the adapter hands it, which swaps the default Lea.Misc workspace block for
a project block. Default/loose behavior must be byte-identical.

Run:  uv run python -m tests.prompt.test_namespace
Exits 0 if every check passes, 1 otherwise.
"""

import sys

from lea.prompt import load_system_prompt

_FAILURES: list[str] = []


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def test_default_namespace_is_lea_misc():
    prompt = load_system_prompt("interactive")
    check("default keeps namespace Lea.Misc", "namespace Lea.Misc" in prompt)
    check("default keeps the Lea/Misc write path", "/Lea/Misc/" in prompt)


def test_explicit_lea_misc_matches_default():
    # Passing the default namespace explicitly is a no-op (same as None).
    check(
        "explicit Lea.Misc == default",
        load_system_prompt("interactive", namespace="Lea.Misc")
        == load_system_prompt("interactive"),
    )


def test_project_namespace_swaps_the_block():
    prompt = load_system_prompt("interactive", namespace="Lea.Epsilon")
    check("project namespace stated", "namespace Lea.Epsilon" in prompt)
    check("project end-namespace stated", "end Lea.Epsilon" in prompt)
    check("project block mentions importable name", "Lea.Epsilon.<name>" in prompt)
    check("project block invites sibling imports", "sibling modules" in prompt)
    # The loose Lea.Misc block is fully replaced — no Misc residue.
    check("no Lea.Misc namespace residue", "Lea.Misc" not in prompt)
    check("no Lea/Misc path residue", "/Lea/Misc/" not in prompt)


def test_project_block_honors_workspace_dir():
    # workspace + namespace compose: the project block points at the given dir.
    prompt = load_system_prompt(
        "default", workspace="/tmp/proofs/Lea/Epsilon", namespace="Lea.Epsilon"
    )
    check("project block uses the workspace dir", "/tmp/proofs/Lea/Epsilon" in prompt)
    check("project block uses the namespace", "namespace Lea.Epsilon" in prompt)
    check("default WORKSPACE path retargeted away", "workspace/proofs/Lea/Misc" not in prompt)


def main():
    print("prompt namespace (D32) tests:")
    test_default_namespace_is_lea_misc()
    test_explicit_lea_misc_matches_default()
    test_project_namespace_swaps_the_block()
    test_project_block_honors_workspace_dir()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        sys.exit(1)
    print("All prompt namespace tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
