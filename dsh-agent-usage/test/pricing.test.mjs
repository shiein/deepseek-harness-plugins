import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateCellCost, hasPrice, pricingTable, PRICES } from '../host/pricing.js';

test('profile overrides add and replace rates; invalid entries are reported, not applied', () => {
  const { table, applied, invalid } = pricingTable({
    'my-local-model': { input: 1, output: 2 },
    'Claude-Sonnet-4-5': { input: 10, output: 20, cacheRead: 1 },
    broken: { input: -1, output: 2 },
    'no-output': { input: 1 },
    'bad-fast': { input: 1, output: 1, fast: { input: 'x', output: 1 } },
  });
  assert.deepEqual(applied.sort(), ['claude-sonnet-4-5', 'my-local-model']);
  assert.deepEqual(invalid.sort(), ['bad-fast', 'broken', 'no-output']);
  assert.equal(hasPrice('my-local-model'), false, 'the built-in table is untouched');
  assert.equal(hasPrice('my-local-model', table), true);
  const cell = { model: 'claude-sonnet-4-5-20250929', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 };
  assert.equal(estimateCellCost(cell, table), 10 + 20 + 1);
  assert.equal(estimateCellCost(cell), PRICES['claude-sonnet-4-5'].input + PRICES['claude-sonnet-4-5'].output + PRICES['claude-sonnet-4-5'].cacheRead);
  assert.equal(estimateCellCost({ ...cell, costUsd: 0.5 }, table), 0.5, 'reported cost passes through');
  assert.deepEqual(pricingTable('nope').invalid, ['(prices must be an object)']);
});
