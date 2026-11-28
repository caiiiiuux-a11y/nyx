import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalCredentialStore } from './local-credential-store.mjs';

test('a saved route key survives reopening and cannot be transplanted to another route', {
  skip: process.platform !== 'win32'
}, t => {
  const directory = mkdtempSync(join(tmpdir(), 'haven-test-route-key-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const store = createLocalCredentialStore(directory);
  const folder = join(directory, 'provider-keys');
  const endpoint = 'https://first.example.invalid/v1';
  const otherEndpoint = 'https://second.example.invalid/v1';
  const syntheticKey = 'unit-test-credential-A';
  assert.ok(store.available);
  assert.equal(store.read('one', endpoint), null);
  store.write('one', endpoint, syntheticKey);
  const [first] = readdirSync(folder);
  const ciphertext = readFileSync(join(folder, first));
  assert.ok(!ciphertext.includes(syntheticKey));
  const reopened = createLocalCredentialStore(directory);
  assert.equal(reopened.read('one', endpoint), syntheticKey);
  assert.equal(reopened.read('one', otherEndpoint), null);
  assert.equal(reopened.read('two', endpoint), null);

  reopened.write('one', otherEndpoint, 'unit-test-credential-B');
  const second = readdirSync(folder).find(file => file !== first);
  writeFileSync(join(folder, second), ciphertext);
  assert.equal(reopened.read('one', otherEndpoint), null);
  reopened.write('one', endpoint, 'unit-test-credential-C');
  assert.equal(store.read('one', endpoint), 'unit-test-credential-C');
  reopened.remove('one', endpoint);
  assert.equal(store.read('one', endpoint), null);
});
