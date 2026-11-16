import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkStatus } from './network-status.mjs';
test('detects Wi-Fi on Linux and treats ethernet independently', async () => {
  assert.deepEqual(await networkStatus('linux', async () => ({ stdout: 'wifi:connected\nethernet:disconnected\n' })), { connected: true, wifi: true });
  assert.deepEqual(await networkStatus('linux', async () => ({ stdout: 'wifi:disconnected\nethernet:connected\n' })), { connected: true, wifi: false });
});
test('detects Windows physical Wi-Fi medium and macOS Wi-Fi address', async () => {
  assert.equal((await networkStatus('win32', async () => ({ stdout: 'Native802_11\r\n' }))).wifi, true);
  assert.equal((await networkStatus('win32', async () => ({ stdout: '802_3\r\n' }))).wifi, false);
  const calls = [];
  const result = await networkStatus('darwin', async (command, args) => {
    calls.push([command, args]);
    return { stdout: calls.length === 1 ? 'Hardware Port: Wi-Fi\nDevice: en1\n' : '192.0.2.1\n' };
  });
  assert.deepEqual(result, { connected: true, wifi: true });
  assert.deepEqual(calls[1][1], ['getifaddr', 'en1']);
});
test('unknown network and command failure never grant Wi-Fi download permission', async () => {
  assert.equal((await networkStatus('linux', async () => { throw Error('unavailable'); })).wifi, false);
  assert.equal((await networkStatus('darwin', async () => ({ stdout: '' }))).wifi, false);
});
