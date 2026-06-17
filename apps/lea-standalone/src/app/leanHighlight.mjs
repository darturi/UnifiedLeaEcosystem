// Minimal Lean 4 syntax highlighter for the canvas.
//
// Tokenizes one line into [{ cls, text }] spans matching the mockup palette
// (kw / ty / fn / str / num / com). Deliberately small and dependency-free —
// it is cosmetic, not a parser, so "good enough and never wrong-looking" beats
// completeness. Unknown text falls through as a plain span (cls: '').

const KEYWORDS = new Set([
  'theorem', 'lemma', 'def', 'example', 'instance', 'structure', 'class', 'inductive',
  'abbrev', 'import', 'open', 'namespace', 'end', 'section', 'variable', 'variables',
  'by', 'fun', 'let', 'have', 'show', 'from', 'with', 'do', 'return', 'match',
  'if', 'then', 'else', 'calc', 'where', 'deriving', 'attribute', 'set_option',
  'exact', 'apply', 'intro', 'intros', 'refine', 'rw', 'rewrite', 'simp', 'simpa',
  'ring', 'linarith', 'nlinarith', 'omega', 'norm_num', 'constructor', 'cases',
  'rcases', 'rintro', 'obtain', 'use', 'exists', 'induction', 'sorry', 'admit',
  'unfold', 'dsimp', 'subst', 'contradiction', 'assumption', 'trivial', 'decide',
]);

// Order matters: comments and strings first, then numbers, names, symbols.
const TOKEN_RE = /(--[^\n]*)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_']*)|(\s+)|([^\sA-Za-z0-9_]+)/g;

export function highlightLine(line) {
  if (!line) return [];
  const spans = [];
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    const [, comment, str, num, word, space, sym] = match;
    if (comment !== undefined) spans.push({ cls: 'com', text: comment });
    else if (str !== undefined) spans.push({ cls: 'str', text: str });
    else if (num !== undefined) spans.push({ cls: 'num', text: num });
    else if (word !== undefined) spans.push({ cls: classifyWord(word), text: word });
    else if (space !== undefined) spans.push({ cls: '', text: space });
    else if (sym !== undefined) spans.push({ cls: '', text: sym });
  }
  return spans;
}

function classifyWord(word) {
  if (KEYWORDS.has(word)) return 'kw';
  // Capitalized identifiers read as types/namespaces (Nat, Real, Irrational, …).
  if (/^[A-Z]/.test(word)) return 'ty';
  return '';
}
