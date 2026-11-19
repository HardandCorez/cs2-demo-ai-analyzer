// Pure replay transforms. Source 2 positions are Z-up; Three.js scenes are Y-up.
export function sourceToThree(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.z) || 0,
    z: -(Number(point?.y) || 0),
  };
}

export function samplePlayers(frames, time) {
  if (!Array.isArray(frames) || !frames.length) return [];
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(frames[mid].t) < time) lo = mid + 1;
    else hi = mid;
  }
  const later = frames[lo];
  const earlier = lo > 0 && Number(later.t) > time ? frames[lo - 1] : later;
  if (earlier === later) return earlier.players || [];

  const dt = Number(later.t) - Number(earlier.t);
  const alpha = dt > 0 ? Math.max(0, Math.min(1, (time - Number(earlier.t)) / dt)) : 0;
  const id = (p) => String(p.steamid || p.name || '');
  const future = new Map((later.players || []).map(p => [id(p), p]));
  return (earlier.players || []).map(p => {
    const q = future.get(id(p));
    if (!q || p.alive !== q.alive) return p;
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
    if (!Number.isFinite(dx + dy + dz) || Math.hypot(dx, dy, dz) > 600) return p; // don't animate teleports
    const yaw1 = Number(p.yaw), yaw2 = Number(q.yaw);
    const yaw = p.yaw != null && q.yaw != null && Number.isFinite(yaw1 + yaw2)
      ? yaw1 + ((((yaw2 - yaw1) % 360) + 540) % 360 - 180) * alpha
      : p.yaw;
    return { ...p, x: p.x + dx * alpha, y: p.y + dy * alpha, z: p.z + dz * alpha, yaw };
  });
}
