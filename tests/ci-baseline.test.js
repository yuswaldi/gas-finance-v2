/**
 * Baseline CI Unit Test (executed in GitHub Actions runner via node --test)
 */
const test = require('node:test');
const assert = require('node:assert');

test('CI environment baseline verification', () => {
  assert.strictEqual(typeof test, 'function', 'node:test runner should be available');
  assert.strictEqual(1 + 1, 2, 'Basic test assertion should succeed');
});
