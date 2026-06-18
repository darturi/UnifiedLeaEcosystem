import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightLine } from './lib/leanHighlight.mjs';

const text = (spans) => spans.map((s) => s.text).join('');
const clsOf = (spans, word) => spans.find((s) => s.text === word)?.cls;

test('round-trips the original line exactly', () => {
  const line = 'theorem sqrt_two_irrational : Irrational (Real.sqrt 2) := by';
  assert.equal(text(highlightLine(line)), line);
});

test('classifies keywords, types, numbers, comments', () => {
  const spans = highlightLine('theorem foo : Nat := 2 -- note');
  assert.equal(clsOf(spans, 'theorem'), 'kw');
  assert.equal(clsOf(spans, 'Nat'), 'ty');
  assert.equal(clsOf(spans, '2'), 'num');
  assert.equal(spans.find((s) => s.text.startsWith('--'))?.cls, 'com');
  assert.equal(clsOf(spans, 'foo'), ''); // lowercase identifier is plain
});

test('a full-line comment is one comment span', () => {
  const spans = highlightLine('-- formalized statement (approved)');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].cls, 'com');
});

test('strings are highlighted as str', () => {
  const spans = highlightLine('open "Mathlib"');
  assert.equal(clsOf(spans, '"Mathlib"'), 'str');
  assert.equal(clsOf(spans, 'open'), 'kw');
});

test('empty line yields no spans', () => {
  assert.deepEqual(highlightLine(''), []);
});
