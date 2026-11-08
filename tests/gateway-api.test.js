import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let tries = 0; tries < 100; tries++) {
    if (child.exitCode !== null) throw new Error(`Gateway exited before health check: ${child.exitCode}`);
    try {
      const result = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(250) });
      if (result.ok) return;
    } catch {
      // Child still starting.
    }
    await sleep(100);
  }
  throw new Error('Gateway did not start within 10 seconds');
}

test('gateway rejects unauthorized requests and rate limits authenticated clients', { timeout: 20_000 }, async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = 'integration-test-only-not-a-real-secret';
  const child = spawn(process.execPath, ['gateway/src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      AI_GATEWAY_TOKEN: token,
      OPENAI_API_KEY: 'not-a-real-openai-key',
      RATE_LIMIT_PER_MINUTE: '2',
      TRUST_PROXY: '0',
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(baseUrl, child);
    const payload = JSON.stringify({ match: null }); // Rejected before reaching OpenAI.
    const send = (authorization) => fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: payload,
      signal: AbortSignal.timeout(2000),
    });

    const anonymous = await send();
    assert.equal(anonymous.status, 401);

    const wrong = await send('Bearer wrong-token');
    assert.equal(wrong.status, 401);

    const first = await send(`Bearer ${token}`);
    assert.equal(first.status, 400); // Auth passed, payload invalid.

    const second = await send(`Bearer ${token}`);
    assert.equal(second.status, 400);

    const limited = await send(`Bearer ${token}`);
    assert.equal(limited.status, 429);
  } finally {
    child.kill();
  }
});
