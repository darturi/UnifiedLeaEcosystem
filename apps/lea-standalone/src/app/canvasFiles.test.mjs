import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isScratchPath,
  distinctFiles,
  latestIndexForPath,
  mainFilePath,
  mainFileIndex,
} from './lib/canvasFiles.mjs';

// A session where a scratch probe is written AFTER the main proof — the case that
// used to strand the canvas on scratch.lean (#10).
const steps = [
  { path: 'Lea/Misc/Irrational.lean' }, // 0
  { path: 'Lea/Misc/Irrational.lean' }, // 1  ← main file's latest
  { path: 'Lea/Misc/scratch.lean' }, //     2  ← newest overall (a probe)
];

test('isScratchPath matches scratch files case-insensitively', () => {
  assert.equal(isScratchPath('a/Scratch.lean'), true);
  assert.equal(isScratchPath('a/scratchpad.lean'), true);
  assert.equal(isScratchPath('a/Irrational.lean'), false);
  assert.equal(isScratchPath(null), false);
});

test('distinctFiles collapses per path with latest index + scratch flag', () => {
  const files = distinctFiles(steps);
  assert.equal(files.length, 2);
  const main = files.find((f) => f.path.endsWith('Irrational.lean'));
  const scratch = files.find((f) => f.path.endsWith('scratch.lean'));
  assert.deepEqual([main.latestIndex, main.count, main.isScratch], [1, 2, false]);
  assert.deepEqual([scratch.latestIndex, scratch.count, scratch.isScratch], [2, 1, true]);
});

test('latestIndexForPath finds a file’s newest snapshot', () => {
  assert.equal(latestIndexForPath(steps, 'Lea/Misc/Irrational.lean'), 1);
  assert.equal(latestIndexForPath(steps, 'Lea/Misc/scratch.lean'), 2);
  assert.equal(latestIndexForPath(steps, 'nope.lean'), -1);
});

test('mainFilePath / mainFileIndex pick the newest non-scratch file', () => {
  assert.equal(mainFilePath(steps), 'Lea/Misc/Irrational.lean');
  assert.equal(mainFileIndex(steps), 1); // the main file's latest, NOT the scratch at 2
});

test('all-scratch falls back to the last step; empty → none', () => {
  const scratchOnly = [{ path: 'a/scratch.lean' }, { path: 'b/scratch2.lean' }];
  assert.equal(mainFilePath(scratchOnly), 'b/scratch2.lean');
  assert.equal(mainFileIndex(scratchOnly), 1);
  assert.equal(mainFilePath([]), null);
  assert.equal(mainFileIndex([]), -1);
});
