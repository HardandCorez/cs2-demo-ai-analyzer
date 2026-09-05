const CATALOG_URL = 'https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/data/available.json';
const CACHE_KEY = 'hardandcore.cs2.radarCatalog.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RADAR_PX = 1024;

let catalogPromise = null;
const imageCache = new Map();

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanMapName(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.(bsp|vpk|dem)$/i, '') || '';
}

function loadCachedCatalog() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data?.maps) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedCatalog(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // localStorage may be unavailable in hardened/private browser modes.
  }
}

export async function loadRadarCatalog() {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const cached = loadCachedCatalog();
    const cacheFresh = cached && Date.now() - Number(cached.savedAt || 0) < CACHE_TTL_MS;
    if (cacheFresh) return { ...cached.data, source: 'cache' };

    try {
      const response = await fetch(CATALOG_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Radar catalog HTTP ${response.status}`);
      const data = await response.json();
      if (!data?.maps || typeof data.maps !== 'object') throw new Error('Radar catalog has invalid schema');
      saveCachedCatalog(data);
      return { ...data, source: 'network' };
    } catch (error) {
      if (cached?.data?.maps) return { ...cached.data, source: 'stale-cache', warning: String(error?.message || error) };
      throw error;
    }
  })();
  return catalogPromise;
}

function layerIdFromPath(mapName, url) {
  const filename = String(url || '').split('/').pop() || '';
  if (filename === `${mapName}_radar_psd.png`) return 'default';
  const prefix = `${mapName}_`;
  const suffix = '_radar_psd.png';
  if (filename.startsWith(prefix) && filename.endsWith(suffix)) {
    return filename.slice(prefix.length, -suffix.length) || 'default';
  }
  return 'default';
}

function layerLabel(id) {
  const labels = {
    default: 'Основной',
    upper: 'Верхний',
    lower: 'Нижний',
    top: 'Верхний',
    bottom: 'Нижний',
  };
  return labels[id] || id.replace(/[_-]+/g, ' ');
}

function altitudeRange(section) {
  if (!section || typeof section !== 'object') return { minZ: null, maxZ: null };
  return {
    minZ: asNumber(section.AltitudeMin ?? section.altitude_min),
    maxZ: asNumber(section.AltitudeMax ?? section.altitude_max),
  };
}

export async function getRadarMeta(rawMapName) {
  const mapName = cleanMapName(rawMapName);
  if (!mapName) return null;
  const catalog = await loadRadarCatalog();
  const entry = catalog.maps?.[mapName];
  const info = entry?.radar_info;
  const radarPaths = Array.isArray(entry?.radar_paths) ? entry.radar_paths.filter(Boolean) : [];
  const posX = asNumber(info?.pos_x);
  const posY = asNumber(info?.pos_y);
  const scale = asNumber(info?.scale);
  if (!entry || !info || !radarPaths.length || posX === null || posY === null || scale === null || scale <= 0) {
    return {
      mapName,
      displayName: entry?.display_name || mapName,
      available: false,
      catalogCount: Number(catalog.count || Object.keys(catalog.maps || {}).length || 0),
      catalogSource: catalog.source,
    };
  }

  const sections = info.verticalsections && typeof info.verticalsections === 'object' ? info.verticalsections : {};
  const layers = radarPaths.map((url) => {
    const id = layerIdFromPath(mapName, url);
    const range = altitudeRange(sections[id] || (id === 'default' ? sections.default : null));
    return { id, label: layerLabel(id), url, ...range };
  });
  layers.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id)));

  return {
    mapName,
    displayName: entry.display_name || mapName,
    available: true,
    posX,
    posY,
    scale,
    rotate: asNumber(info.rotate, 0) || 0,
    zoom: asNumber(info.zoom, 1) || 1,
    layers,
    verticalSections: sections,
    catalogCount: Number(catalog.count || Object.keys(catalog.maps || {}).length || 0),
    catalogSource: catalog.source,
    catalogUrl: CATALOG_URL,
  };
}

export function defaultRadarLayer(meta) {
  return meta?.layers?.find((layer) => layer.id === 'default') || meta?.layers?.[0] || null;
}

export function layerForZ(meta, z) {
  if (!meta?.layers?.length) return null;
  const nz = asNumber(z);
  if (nz === null) return defaultRadarLayer(meta);
  const exact = meta.layers.find((layer) => {
    if (layer.minZ === null && layer.maxZ === null) return false;
    const minOk = layer.minZ === null || nz >= layer.minZ;
    const maxOk = layer.maxZ === null || nz < layer.maxZ;
    return minOk && maxOk;
  });
  return exact || defaultRadarLayer(meta);
}

export function pointBelongsToLayer(meta, point, layerId) {
  if (!layerId || layerId === 'all') return true;
  const layer = meta?.layers?.find((item) => item.id === layerId);
  if (!layer) return true;
  const z = asNumber(point?.z);
  if (z === null || (layer.minZ === null && layer.maxZ === null)) return true;
  return (layer.minZ === null || z >= layer.minZ) && (layer.maxZ === null || z < layer.maxZ);
}

export function worldToRadarFraction(meta, x, y) {
  if (!meta?.available) return null;
  const nx = asNumber(x);
  const ny = asNumber(y);
  if (nx === null || ny === null) return null;
  return {
    fx: (nx - meta.posX) / meta.scale / RADAR_PX,
    fy: (meta.posY - ny) / meta.scale / RADAR_PX,
  };
}

export function loadRadarImage(layer) {
  if (!layer?.url) return Promise.reject(new Error('Radar image URL missing'));
  if (imageCache.has(layer.url)) return imageCache.get(layer.url);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Не удалось загрузить radar image: ${layer.id}`));
    img.src = layer.url;
  });
  imageCache.set(layer.url, promise);
  return promise;
}

export function radarCatalogUrl() {
  return CATALOG_URL;
}
