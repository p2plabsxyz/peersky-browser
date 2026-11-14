const test = require('node:test');
const assert = require('node:assert');
const { HyperSDKManager } = require('../src/hypersdk');

test('HyperSDKManager initializes successfully without segmentation fault', async () => {
  const manager = new HyperSDKManager();
  const sdk = await manager.initialize({ storage: './test-storage' });
  
  assert.strictEqual(manager.initialized, true);
  assert.strictEqual(sdk.storage, './test-storage');
  assert.strictEqual(sdk.active, true);

  await sdk.close();
  assert.strictEqual(manager.initialized, false);
});
