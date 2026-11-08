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
  for (let tries = 0; tries < 200; tries++) {
    if (child.exitCode !== null) throw new Error(`Analyzer exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(750) });
      if (res.ok && (await res.json()).ok) return;
    } catch {
      // Server stack not ready.
    }
    await sleep(100);
  }
  throw new Error('Analyzer did not start within 20 seconds');
}

test('analyzer serves localhost API and blocks cross-origin requests', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server-v10fast.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      AI_GATEWAY_URL: '',
      AI_GATEWAY_TOKEN: '',
      OPENAI_API_KEY: '',
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(baseUrl, child);
    const good = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: baseUrl },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(good.status, 200);

    const forbidden = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://attacker.example' },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(forbidden.status, 403);

    const forbiddenPort = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${port + 10}` },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(forbiddenPort.status, 403);

    const invalidAi = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(invalidAi.status, 400);
  } finally {
    child.kill();
  }
});
