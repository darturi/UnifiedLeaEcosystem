import assert from 'node:assert/strict';
import test from 'node:test';

function splitCode(code) {
  if (!code) return [];
  const lines = code.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function buildInlineDiff(previousCode, currentCode) {
  const oldLines = splitCode(previousCode);
  const newLines = splitCode(currentCode);
  const table = Array.from({ length: oldLines.length + 1 }, () =>
    Array(newLines.length + 1).fill(0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ kind: 'unchanged', line: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push({ kind: 'removed', line: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ kind: 'added', line: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) rows.push({ kind: 'removed', line: oldLines[oldIndex++] });
  while (newIndex < newLines.length) rows.push({ kind: 'added', line: newLines[newIndex++] });
  return rows;
}

function previousStepForPath(steps, currentIndex) {
  const current = steps[currentIndex];
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (steps[index].path === current.path) return steps[index];
  }
  return undefined;
}

test('marks inserted lines as added', () => {
  const rows = buildInlineDiff('a\nc', 'a\nb\nc');
  assert.deepEqual(rows.map((row) => row.kind), ['unchanged', 'added', 'unchanged']);
});

test('marks removed lines as removed', () => {
  const rows = buildInlineDiff('a\nb\nc', 'a\nc');
  assert.deepEqual(rows.map((row) => row.kind), ['unchanged', 'removed', 'unchanged']);
});

test('marks replacements as removed then added', () => {
  const rows = buildInlineDiff('a\nold\nc', 'a\nnew\nc');
  assert.deepEqual(rows.map((row) => row.kind), ['unchanged', 'removed', 'added', 'unchanged']);
});

test('empty previous file renders current lines as added', () => {
  const rows = buildInlineDiff('', 'a\nb');
  assert.deepEqual(rows.map((row) => row.kind), ['added', 'added']);
});

test('path-aware previous step ignores other files', () => {
  const steps = [
    { path: 'A.lean', code: 'a' },
    { path: 'B.lean', code: 'b' },
    { path: 'A.lean', code: 'a2' },
  ];
  assert.equal(previousStepForPath(steps, 2), steps[0]);
});

