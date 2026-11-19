import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceToThree, samplePlayers } from '../public/replay-3d-math.js';

test('Source coordinates map to Three.js Y-up consistently', () => {
  assert.deepEqual(sourceToThree({ x: 20, y: 30, z: 40 }), { x: 20, y: 40, z: -30 });
});

test('Interpolates position and shortest yaw arc between sparse demo samples', () => {
  const frames = [
    { t: -1, players: [{ name: 'CT', x: 0, y: 10, z: 20, yaw: 350, alive: true }] },
    { t: 1, players: [{ name: 'CT', x: 20, y: 30, z: 40, yaw: 10, alive: true }] },
  ];
  const [p] = samplePlayers(frames, 0);
  assert.deepEqual([p.x, p.y, p.z], [10, 20, 30]);
  assert.equal(((p.yaw % 360) + 360) % 360, 0);
});

test('Does not interpolate teleports or alive-state changes', () => {
  const frames = [
    { t: 0, players: [{ name: 'T', x: 0, y: 0, z: 0, alive: true }] },
    { t: 1, players: [{ name: 'T', x: 1000, y: 0, z: 0, alive: true }] },
  ];
  assert.equal(samplePlayers(frames, 0.5)[0].x, 0);
  frames[1].players[0].x = 20;
  frames[1].players[0].alive = false;
  assert.equal(samplePlayers(frames, 0.5)[0].x, 0);
});
