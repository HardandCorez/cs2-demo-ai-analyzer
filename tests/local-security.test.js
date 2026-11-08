import test from 'node:test';
import assert from 'node:assert/strict';
import { requireLoopbackHost } from '../src/local-security.js';

function check(host, origin) {
  let allowed = false;
  let rejectedStatus = null;
  const req = { headers: { host, ...(origin === undefined ? {} : { origin }) } };
  const res = {
    status(code) { rejectedStatus = code; return this; },
    json() { return this; },
  };
  requireLoopbackHost(req, res, () => { allowed = true; });
  return { allowed, rejectedStatus };
}

test('local requests from browser are allowed', () => {
  assert.equal(check('localhost:3000', 'http://localhost:3000').allowed, true);
  assert.equal(check('127.0.0.1:3000', 'http://127.0.0.1:5173').allowed, true);
  assert.equal(check('[::1]:3000', 'http://[::1]:3000').allowed, true);
  assert.equal(check('127.0.0.1:3001').allowed, true);
});

test('DNS rebinding and external cross-origin requests are rejected', () => {
  assert.equal(check('attacker.example:3000').rejectedStatus, 403);
  assert.equal(check('localhost:3000', 'https://attacker.example').rejectedStatus, 403);
  assert.equal(check('127.0.0.1:3000', 'null').rejectedStatus, 403);
  assert.equal(check('').rejectedStatus, 403);
});
