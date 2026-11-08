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

test('same-origin browser and local-to-local server requests are allowed', () => {
  assert.equal(check('localhost:3000', 'http://localhost:3000').allowed, true);
  assert.equal(check('127.0.0.1:3000', 'http://127.0.0.1:3000').allowed, true);
  assert.equal(check('[::1]:3000', 'http://[::1]:3000').allowed, true);
  assert.equal(check('127.0.0.1:3001').allowed, true); // Internal server-side fetch
  assert.equal(check('LOCALHOST:3000', 'http://localhost:3000').allowed, true);
});

test('DNS rebinding and malformed Host values are rejected', () => {
  for (const host of ['attacker.example:3000', 'localhost.evil:3000',
    'localhost:0', 'localhost:99999', 'localhost:3000@attacker.example',
    '127.0.0.1:3000:4000', '', 'localhost :3000']) {
    assert.equal(check(host).rejectedStatus, 403, host);
  }
});

test('external or cross-port browser Origin values are rejected', () => {
  for (const origin of ['https://attacker.example', 'http://127.0.0.1:5173',
    'http://localhost:5173', 'http://localhost:3001',
    'https://localhost:3000', 'null', 'invalid']) {
    assert.equal(check('localhost:3000', origin).rejectedStatus, 403, origin);
  }
  assert.equal(check('127.0.0.1:3000', 'http://127.0.0.1:5173').rejectedStatus, 403);
  assert.equal(check('localhost:3000', 'http://127.0.0.1:3000').rejectedStatus, 403);
});
