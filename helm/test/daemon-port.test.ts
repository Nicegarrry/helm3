import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DAEMON_PORT, defaultDaemonPort } from '../src/daemon-port.js';

test('daemon port defaults to the shared port and permits test injection', () => {
  assert.equal(DEFAULT_DAEMON_PORT, 4747);
  assert.equal(defaultDaemonPort({}), DEFAULT_DAEMON_PORT);
  assert.equal(defaultDaemonPort({ HELM_DEFAULT_PORT: '4751' }), 4751);
  assert.equal(defaultDaemonPort({ HELM_DEFAULT_PORT: 'invalid' }), DEFAULT_DAEMON_PORT);
});
