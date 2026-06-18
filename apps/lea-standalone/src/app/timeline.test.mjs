import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, sortCodeSteps } from './lib/timeline.mjs';

const msg = (id, seq, role = 'assistant', extra = {}) => ({
  id,
  session_id: 's',
  role,
  content: id,
  seq,
  created_at: '2026-06-16T00:00:00Z',
  ...extra,
});
const code = (id, seq, extra = {}) => ({
  id,
  session_id: 's',
  author: 'agent',
  path: 'proofs/p.lean',
  commit_sha: 'sha',
  code: '-- ' + id,
  seq,
  created_at: '2026-06-16T00:00:00Z',
  ...extra,
});

test('merges messages and code steps in seq order', () => {
  const { items } = buildTimeline({
    messages: [msg('m1', 0, 'user'), msg('m2', 2)],
    codeSteps: [code('c1', 1)],
  });
  assert.deepEqual(items.map((i) => i.key), ['m:m1', 'c:c1', 'm:m2']);
});

test('code items carry a codeIndex into the sorted code list', () => {
  const { items, codeSteps } = buildTimeline({
    messages: [],
    codeSteps: [code('c2', 3), code('c1', 1)],
  });
  // sorted by seq → c1 (index 0), c2 (index 1)
  assert.deepEqual(codeSteps.map((c) => c.id), ['c1', 'c2']);
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(byKey['c:c1'].codeIndex, 0);
  assert.equal(byKey['c:c2'].codeIndex, 1);
});

test('items without seq (live bubble) sort to the end deterministically', () => {
  const live = msg('live-r1', undefined);
  const { items } = buildTimeline({
    messages: [msg('m1', 0, 'user'), live],
    codeSteps: [code('c1', 1)],
  });
  assert.equal(items[items.length - 1].key, 'm:live-r1');
});

test('sortCodeSteps falls back to created_at then id when seq ties', () => {
  const a = code('a', 1, { created_at: '2026-06-16T00:00:02Z' });
  const b = code('b', 1, { created_at: '2026-06-16T00:00:01Z' });
  assert.deepEqual(sortCodeSteps([a, b]).map((c) => c.id), ['b', 'a']);
});
