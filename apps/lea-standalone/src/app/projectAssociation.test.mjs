import assert from 'node:assert/strict';
import test from 'node:test';

import { hasResolvedProjectAssociation } from './projectAssociation.mjs';

test('stale project id without resolved theorem does not count as associated', () => {
  assert.equal(hasResolvedProjectAssociation(null), false);
  assert.equal(hasResolvedProjectAssociation(undefined), false);
});

test('resolved project theorem counts as associated', () => {
  assert.equal(
    hasResolvedProjectAssociation({
      name: 'solo',
      proof_path: 'workspace/proofs/Lea/Epsilon/solo.lean',
      module_name: 'Lea.Epsilon.solo',
    }),
    true,
  );
});
