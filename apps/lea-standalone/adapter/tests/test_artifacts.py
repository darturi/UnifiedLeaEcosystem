from app.artifacts import classify_lean_artifact


def test_classifies_pure_definition_artifact():
    code = """
import Mathlib

def Subadditive (a : Nat -> Int) : Prop := True
"""
    assert classify_lean_artifact(code) == "definition"


def test_classifies_theorem_artifact():
    code = """
import Mathlib

theorem t : True := by
  trivial
"""
    assert classify_lean_artifact(code) == "proof"


def test_classifies_mixed_artifact_as_not_pure_definition():
    code = """
def helper : Nat := 0

lemma helper_ok : helper = 0 := by
  rfl
"""
    assert classify_lean_artifact(code) == "mixed"


def test_ignores_declaration_words_in_comments_and_strings():
    code = '''
-- theorem fake : True := by trivial
def label : String := "lemma also fake"
'''
    assert classify_lean_artifact(code) == "definition"
