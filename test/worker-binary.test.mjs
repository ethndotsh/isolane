// Which platform package holds the worker for a machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformPackage } from '../dist/worker-binary.js';

test('platform packages', () => {
  assert.equal(platformPackage('linux', 'x64', 'gnu'), '@isolane/worker-linux-x64-gnu');
  assert.equal(platformPackage('linux', 'arm64', 'gnu'), '@isolane/worker-linux-arm64-gnu');
  assert.equal(platformPackage('darwin', 'arm64'), '@isolane/worker-darwin-arm64');
  assert.equal(platformPackage('darwin', 'x64'), '@isolane/worker-darwin-x64');
  assert.equal(platformPackage('linux', 'x64', 'musl'), undefined);
  assert.equal(platformPackage('win32', 'x64'), undefined);
});
