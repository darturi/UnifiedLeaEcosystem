import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureHighlighter,
  highlightToLines,
  isHighlighterReady,
} from './lib/leanHighlight.mjs';

// The highlighter now wraps Shiki (the real Lean 4 TextMate grammar) via the pure-JS
// engine, so it runs in node with no WASM. These pin the contract the canvas relies
// on: tokens are per-line, reconstruct the source exactly, and carry theme colors.

test('is not ready until initialized, then loads', async () => {
  assert.equal(isHighlighterReady(), false);
  assert.equal(highlightToLines('theorem t : True'), null); // null before load → plain fallback
  await ensureHighlighter();
  assert.equal(isHighlighterReady(), true);
});

test('tokens are per-line and reconstruct the source exactly', async () => {
  await ensureHighlighter();
  const code = 'theorem foo : Nat := 2 -- note\n/- a block\n   comment -/\n  simp [add_comm]';
  const lines = highlightToLines(code);
  assert.ok(Array.isArray(lines));
  assert.equal(lines.length, code.split('\n').length);
  const rebuilt = lines.map((toks) => toks.map((t) => t.content).join('')).join('\n');
  assert.equal(rebuilt, code); // exact round-trip → aligns with the canvas line rows
});

test('assigns theme colors to tokens', async () => {
  await ensureHighlighter();
  const [line] = highlightToLines('theorem foo : Nat');
  const kw = line.find((t) => t.content === 'theorem');
  assert.ok(kw, 'the keyword token exists');
  assert.match(kw.color || '', /^#/, 'tokens carry a hex color from the theme');
});

test('multi-line block comments are recognized (grammar is stateful)', async () => {
  await ensureHighlighter();
  // The inside of a /- … -/ that spans lines should color like the opener — proof
  // the grammar carries comment state across lines (the old regex could not).
  const lines = highlightToLines('/- open\n   still comment -/\nreal');
  const opener = lines[0].find((t) => t.content.includes('open'));
  const inside = lines[1].find((t) => t.content.includes('still'));
  assert.ok(opener && inside);
  assert.equal(opener.color, inside.color); // same (comment) color across the line break
});
