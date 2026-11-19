import { samplePlayers, sourceToThree } from './replay-3d-math.js';

// The native S2V OpenGL/.NET renderer cannot run inside the browser.
// S2V is used to export the geometry; Three.js displays it with existing demo samples.
let current = null;
let enginePromise = null;

function safeMap(value) {
  const map = String(value || '').replace(/\\/g, '/').split('/').pop().replace(/\.(bsp|vpk)$/i, '');
  return /^de_[a-z0-9_]+$/i.test(map) ? map.toLowerCase() : '';
}
function key(p) { return String(p.steamid || p.name || ''); }

function dispose(s) {
  if (!s) return;
  s.resizeObserver?.disconnect();
  s.controls?.dispose();
  if (s.scene) {
    s.scene.traverse(obj => {
      obj.geometry?.dispose?.();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (!mat) continue;
        for (const value of Object.values(mat)) {
          if (value?.isTexture) value.dispose();
        }
        mat.dispose?.();
      }
    });
  }
  s.renderer?.dispose();
  s.renderer?.forceContextLoss();
  s.renderer?.domElement?.remove();
}

function setupReplay(detail) {
  const previousActive = Boolean(current?.active);
  dispose(current);
  const viewer = document.querySelector('#v10LiteViewer');
  const wrap = viewer?.querySelector('.v10-lite-canvas-wrap');
  const controls = viewer?.querySelector('.v10-lite-controls');
  if (!wrap || !controls || !detail?.replay?.frames?.length) { current = null; return; }

  const stage = document.createElement('div');
  stage.className = 'replay-3d-stage';
  stage.hidden = true;
  stage.innerHTML =
    '<div class="replay-3d-canvas"></div>' +
    '<div class="replay-3d-hud">' +
      '<select class="replay-3d-player" aria-label="Игрок для камеры"></select>' +
      '<button class="replay-3d-follow" type="button">Следить: выкл.</button>' +
      '<button class="replay-3d-reset" type="button">К игроку</button>' +
      '<span class="replay-3d-legend">CT — синий · T — жёлтый</span>' +
    '</div>' +
    '<div class="replay-3d-status" role="status">3D-карта готовится…</div>';
  wrap.insertAdjacentElement('afterend', stage);

  const switcher = document.createElement('button');
  switcher.className = 'ghost-btn';
  switcher.type = 'button';
  switcher.textContent = '◈ 3D';
  switcher.setAttribute('aria-pressed', 'false');
  controls.prepend(switcher);

  const s = {
    stage, wrap, switcher, detail, active: false, follow: false, time: -Number(detail.replay.beforeSec || 4),
    map: safeMap(detail.map), selected: String(detail.episode?.player || ''), actors: new Map(),
    renderer: null, scene: null, camera: null, controls: null, grid: null, trace: null,
    mapStatus: 'Без 3D-геометрии карты · сетка', resizeObserver: null, T: null,
  };
  current = s;

  const names = new Set(detail.replay.frames.flatMap(f => (f.players || []).map(p => p.name)).filter(Boolean));
  const select = stage.querySelector('.replay-3d-player');
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name; option.textContent = name; select.appendChild(option);
  }
  if (!names.has(s.selected)) s.selected = names.values().next().value || '';
  select.value = s.selected;
  select.addEventListener('change', () => {
    s.selected = select.value;
    centerCamera(s);
    applyFrame(s);
  });
  stage.querySelector('.replay-3d-follow').addEventListener('click', event => {
    s.follow = !s.follow;
    event.currentTarget.textContent = s.follow ? 'Следить: вкл.' : 'Следить: выкл.';
    if (s.follow) centerCamera(s);
  });
  stage.querySelector('.replay-3d-reset').addEventListener('click', () => centerCamera(s, true));
  switcher.addEventListener('click', async () => {
    if (s.active) {
      s.active = false;
      s.stage.hidden = true;
      s.wrap.hidden = false;
      switcher.textContent = '◈ 3D';
      switcher.setAttribute('aria-pressed', 'false');
      return;
    }
    s.active = true;
    s.stage.hidden = false;
    s.wrap.hidden = true;
    switcher.textContent = '▣ 2D';
    switcher.setAttribute('aria-pressed', 'true');
    if (!s.renderer) await initialize(s);
    resize(s);
    applyFrame(s);
  });
  if (previousActive) switcher.click();
}

function setStatus(s, message) {
  if (s !== current) return;
  const status = s.stage.querySelector('.replay-3d-status');
  if (status) status.textContent = message;
}

async function getEngine() {
  if (!enginePromise) {
    enginePromise = Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/loaders/GLTFLoader.js'),
    ]).catch(err => { enginePromise = null; throw err; });
  }
  return enginePromise;
}

async function initialize(s) {
  setStatus(s, 'Загружаем Three.js…');
  try {
    const [T, orbitModule, loaderModule] = await getEngine();
    if (s !== current) return;
    s.T = T;
    s.scene = new T.Scene();
    s.scene.background = new T.Color(0x090f19);
    s.scene.add(new T.HemisphereLight(0xeaf2ff, 0x273b52, 2));
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(300, 650, 240);
    s.scene.add(sun);
    s.camera = new T.PerspectiveCamera(65, 1, 2, 100000);
    s.renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    s.renderer.outputColorSpace = T.SRGBColorSpace;
    s.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    s.stage.querySelector('.replay-3d-canvas').appendChild(s.renderer.domElement);
    s.controls = new orbitModule.OrbitControls(s.camera, s.renderer.domElement);
    s.controls.enableDamping = false;
    s.controls.minDistance = 30;
    s.controls.maxDistance = 6500;
    s.controls.addEventListener('change', () => render(s));
    s.grid = new T.GridHelper(4000, 80, 0x48637b, 0x203348);
    s.scene.add(s.grid);
    centerCamera(s, true);
    s.resizeObserver = new ResizeObserver(() => resize(s));
    s.resizeObserver.observe(s.stage.querySelector('.replay-3d-canvas'));
    resize(s);
    applyFrame(s);
    // Do not block the viewer while attempting optional S2V exports.
    void loadMap(s, loaderModule.GLTFLoader);
  } catch (error) {
    if (s !== current) return;
    s.active = false;
    s.wrap.hidden = false; s.stage.hidden = true;
    s.switcher.textContent = '◈ 3D';
    s.switcher.setAttribute('aria-pressed', 'false');
    setStatus(s, '3D недоступен: ' + (error?.message || error));
    console.error('[3D Replay]', error);
    window.alert('Не удалось запустить 3D Replay. Проверь доступность WebGL и Three.js: ' + (error?.message || error));
  }
}

function actorLabel(T, name) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(4,10,20,.80)';
  ctx.fillRect(0, 0, 512, 96);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(name || '?').slice(0, 24), 256, 48);
  const texture = new T.CanvasTexture(canvas);
  const sprite = new T.Sprite(new T.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.position.y = 91;
  sprite.scale.set(120, 23, 1);
  return sprite;
}

function makeActor(s, player) {
  const T = s.T;
  const group = new T.Group();
  const tint = Number(player.teamNumber) === 3 ? 0x65baff : 0xf1c75b;
  const material = new T.MeshStandardMaterial({ color: tint, transparent: true });
  const torso = new T.Mesh(new T.CylinderGeometry(8, 12, 42, 9), material);
  torso.position.y = 29; group.add(torso);
  const head = new T.Mesh(new T.SphereGeometry(9, 10, 8), material);
  head.position.y = 59; group.add(head);
  const arrow = new T.Mesh(new T.ConeGeometry(5, 16, 8), new T.MeshBasicMaterial({ color: 0xffffff }));
  arrow.rotation.z = -Math.PI / 2; arrow.position.set(20, 53, 0); group.add(arrow);
  const ring = new T.Mesh(
    new T.TorusGeometry(18, 1.8, 4, 32),
    new T.MeshBasicMaterial({ color: player.name === s.detail.episode?.player ? 0xff6675 : 0xfff6b7 }),
  );
  ring.rotation.x = Math.PI / 2; ring.position.y = 2; group.add(ring);
  group.add(actorLabel(T, player.name));
  s.scene.add(group);
  return { group, material };
}

function centerCamera(s, resetDistance = false) {
  if (!s.camera || !s.controls) return;
  const players = samplePlayers(s.detail.replay.frames, s.time);
  const focus = players.find(p => p.name === s.selected) || players[0];
  if (!focus) return;
  const T = s.T;
  const pos = sourceToThree(focus);
  const target = new T.Vector3(pos.x, pos.y + 42, pos.z);
  if (resetDistance) {
    s.camera.position.copy(target).add(new T.Vector3(320, 250, 320));
  } else {
    s.camera.position.add(target.clone().sub(s.controls.target));
  }
  s.controls.target.copy(target);
  s.controls.update();
}

function updateTrail(s) {
  if (s.trace) {
    s.scene.remove(s.trace);
    s.trace.geometry.dispose();
    s.trace.material.dispose();
    s.trace = null;
  }
  const frames = s.detail.replay.frames.filter(f => Number(f.t) <= s.time);
  const points = frames.map(f => (f.players || []).find(p => p.name === s.selected))
    .filter(Boolean).map(p => sourceToThree(p));
  if (points.length < 2) return;
  const T = s.T;
  s.trace = new T.Line(
    new T.BufferGeometry().setFromPoints(points.map(p => new T.Vector3(p.x, p.y + 5, p.z))),
    new T.LineBasicMaterial({ color: 0x43edac, linewidth: 2 }),
  );
  s.scene.add(s.trace);
}

function applyFrame(s) {
  if (s !== current || !s.active || !s.renderer || !s.scene) return;
  const players = samplePlayers(s.detail.replay.frames, s.time);
  const present = new Set();
  for (const player of players) {
    const id = key(player);
    present.add(id);
    let actor = s.actors.get(id);
    if (!actor) {
      actor = makeActor(s, player);
      s.actors.set(id, actor);
    }
    const pos = sourceToThree(player);
    actor.group.position.set(pos.x, pos.y, pos.z);
    actor.group.rotation.y = Number.isFinite(Number(player.yaw)) && player.yaw != null
      ? Number(player.yaw) * Math.PI / 180 : 0;
    actor.group.visible = true;
    actor.material.opacity = player.alive === false ? 0.28 : 1;
  }
  for (const [id, actor] of s.actors) if (!present.has(id)) actor.group.visible = false;
  const focus = players.find(p => p.name === s.selected) || players[0];
  if (focus && s.grid) {
    const p = sourceToThree(focus);
    s.grid.position.set(p.x, p.y - 2, p.z);
  }
  if (s.follow) centerCamera(s);
  updateTrail(s);
  setStatus(s, (s.map || 'Неизвестная карта') + ' · ' + s.mapStatus +
    ' · t=' + (s.time >= 0 ? '+' : '') + s.time.toFixed(2) + 'с · ' +
    players.length + ' игроков · упрощённые силуэты, не игровая симуляция');
  render(s);
}

function render(s) {
  if (s === current && s.active && s.renderer && s.scene && s.camera) {
    s.renderer.render(s.scene, s.camera);
  }
}
function resize(s) {
  if (!s?.active || !s.renderer || !s.camera) return;
  const holder = s.stage.querySelector('.replay-3d-canvas');
  const width = Math.max(320, Math.floor(holder.clientWidth || 760));
  const height = Math.max(330, Math.floor(holder.clientHeight || 430));
  s.renderer.setSize(width, height, false);
  s.camera.aspect = width / height;
  s.camera.updateProjectionMatrix();
  render(s);
}

async function loadMap(s, Loader) {
  if (!s.map) return;
  const root = '/assets/maps/' + s.map + '/';
  const loader = new Loader();
  // Exported glTF may have external textures: GLTFLoader resolves relative paths.
  for (const name of ['scene.glb', 'scene.gltf']) {
    try {
      const response = await fetch(root + name, { method: 'HEAD' });
      if (!response.ok) continue;
      const model = await loader.loadAsync(root + name);
      if (s !== current) return;
      let config = {};
      try {
        const cfg = await fetch(root + 'transform.json');
        if (cfg.ok) config = await cfg.json();
      } catch {}
      if (s !== current) return;
      const scale = Number(config.scale);
      if (Number.isFinite(scale) && scale > 0 && scale < 1000) model.scene.scale.setScalar(scale);
      const angle = Number(config.rotationYDeg);
      if (Number.isFinite(angle)) model.scene.rotation.y = angle * Math.PI / 180;
      if (Array.isArray(config.offset) && config.offset.length === 3) {
        const v = config.offset.map(Number);
        if (v.every(Number.isFinite)) model.scene.position.set(...v);
      }
      s.scene.add(model.scene);
      s.grid.visible = false;
      s.mapStatus = 'геометрия S2V загружена (' + name + ')';
      applyFrame(s);
      return;
    } catch (error) {
      console.warn('[3D Replay] Failed loading ' + root + name, error);
    }
  }
  s.mapStatus = 'экспорт S2V не найден · сетка';
  applyFrame(s);
}

document.addEventListener('cs2:episode-replay-loaded', event => {
  setupReplay(event.detail || {});
});
document.addEventListener('cs2:episode-replay-time', event => {
  if (!current) return;
  const t = Number(event.detail?.time);
  if (!Number.isFinite(t)) return;
  current.time = t;
  applyFrame(current);
});
