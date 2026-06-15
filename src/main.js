import * as THREE from 'three';
import { GLTFLoader }    from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import renderMathInElement from 'katex/dist/contrib/auto-render';
import createStats from './stats.js';
import 'katex/dist/katex.min.css';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript.js';
import 'prism-themes/themes/prism-nord.css';
import './style.css';

// ── DOM refs ────────────────────────────────────────────────────────────────────
const canvas          = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const panelToggleBtn  = document.getElementById('panel-toggle');
const controlPanel    = document.getElementById('control-panel');
const resetCameraBtn  = document.getElementById('reset-camera');
const topViewBtn      = document.getElementById('top-view');
const zScaleSlider    = /** @type {HTMLInputElement}  */ (document.getElementById('z-scale'));
const zScaleValue     = document.getElementById('z-scale-value');
const wireframeToggle  = /** @type {HTMLInputElement}  */ (document.getElementById('wireframe-toggle'));
const gridToggle       = /** @type {HTMLInputElement}  */ (document.getElementById('grid-toggle'));
const gridSpacingRow   = document.getElementById('grid-spacing-row');
const gridSpacingSelect = /** @type {HTMLSelectElement} */ (document.getElementById('grid-spacing'));
const colorMapSelect   = /** @type {HTMLSelectElement} */ (document.getElementById('color-map'));
const roadsToggle          = /** @type {HTMLInputElement} */ (document.getElementById('roads-toggle'));
const roadsSub             = /** @type {HTMLElement} */ (document.getElementById('roads-sub'));
const roadsHighwayToggle   = /** @type {HTMLInputElement} */ (document.getElementById('roads-highway'));
const roadsExpresswayToggle= /** @type {HTMLInputElement} */ (document.getElementById('roads-expressway'));
const roadsProvincialToggle= /** @type {HTMLInputElement} */ (document.getElementById('roads-provincial'));
const boundariesToggle     = /** @type {HTMLInputElement} */ (document.getElementById('boundaries-toggle'));
const hillshadeToggle      = /** @type {HTMLInputElement} */ (document.getElementById('hillshade-toggle'));
const lodBadge         = document.getElementById('lod-badge');
const coordHud        = document.getElementById('coord-hud');
const legendMin       = document.getElementById('legend-min');
const legendMax       = document.getElementById('legend-max');
const legendBar       = document.getElementById('legend-bar');
const opHint          = document.getElementById('operation-hint');
const loadingOverlay  = document.getElementById('loading-overlay');
const progressFill    = document.getElementById('progress-fill');
const loadingDetail   = document.getElementById('loading-detail');
const openMathBtn     = document.getElementById('open-math');
const closeMathBtn    = document.getElementById('close-math');
const mathModal       = document.getElementById('math-modal');
const mathContent     = document.getElementById('math-content');
const langToggle      = document.getElementById('language-toggle');

// ── Three.js core ────────────────────────────────────────────────────────────────
// logarithmicDepthBuffer: the camera spans near=1 .. far=1e6 (full island), which
// wrecks depth precision. stencil: the 100 m base stays visible as a backdrop and is
// masked (stencil != 1) wherever a tile drew, so gaps while tiles stream show the 100 m
// surface instead of black — no overlap, no flicker.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, stencil: true });

// Performance HUD (MS / MB) pinned to the viewport's top-left.
const stats = createStats();
document.body.appendChild(stats.dom);
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1e);

// Far plane spans the full main island (~400 km N–S) for the merged overview.
const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.08;
controls.zoomToCursor   = true;
controls.screenSpacePanning = false;
controls.mouseButtons = {
  LEFT:   THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.ROTATE,
  RIGHT:  THREE.MOUSE.DOLLY,
};
controls.enabled = false;  // disabled until terrain loads
// Track user input, not camera position — OrbitControls damping fires 'change' every frame
// after the user lets go, which would keep cameraMoving true for 1–2 s and block 20 m loading.
renderer.domElement.addEventListener('pointerdown', () => {
  cameraMoving = true;
  clearTimeout(movingTimer);
});
renderer.domElement.addEventListener('pointerup', () => {
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => { cameraMoving = false; }, 300);
});
renderer.domElement.addEventListener('wheel', () => {
  cameraMoving = true;
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => { cameraMoving = false; }, 500);
});

// ── Lighting (from NW at 45°; X=East, Y=Up, Z=South in GLB) ────────────────────
const dirLight = new THREE.DirectionalLight(0xfff5e8, 1.8);
dirLight.position.set(-1, 1.2, -1);
scene.add(dirLight);
scene.add(new THREE.AmbientLight(0x3a4060, 0.7));

// ── Elevation color maps ─────────────────────────────────────────────────────────
/** @type {Record<string, (t: number) => [number,number,number]>} */
const COLOR_MAPS = {
  terrain: (t) => {
    // Guidelines: 0–200m green, 200–600m brown, 600–1500m mountain, 1500m+ gray
    const stops = [
      [0,    0x4a/255, 0x7c/255, 0x59/255],
      [0.15, 0x8b/255, 0x69/255, 0x14/255],
      [0.45, 0x6b/255, 0x42/255, 0x26/255],
      [1.0,  0xc8/255, 0xc8/255, 0xc8/255],
    ];
    for (let i = 1; i < stops.length; i++) {
      const [t0, r0, g0, b0] = stops[i - 1];
      const [t1, r1, g1, b1] = stops[i];
      if (t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return [r0 + (r1-r0)*f, g0 + (g1-g0)*f, b0 + (b1-b0)*f];
      }
    }
    return [0xc8/255, 0xc8/255, 0xc8/255];
  },
  grayscale: (t) => [t, t, t],
  rainbow: (t) => {
    const r = Math.max(0, Math.min(1, Math.abs(t * 4 - 2.5) - 0.5));
    const g = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 2)));
    const b = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 1)));
    return [r, g, b];
  },
  // t = 0 (flat 0°) → 1 (vertical cliff 90°)
  slope: (t) => {
    const stops = [
      [0.00, 1.00, 1.00, 1.00],
      [0.25, 0.75, 0.95, 0.45],
      [0.55, 0.95, 0.78, 0.10],
      [0.80, 0.90, 0.30, 0.05],
      [1.00, 0.70, 0.05, 0.05],
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const f = (t - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
        return [
          stops[i-1][1] + (stops[i][1] - stops[i-1][1]) * f,
          stops[i-1][2] + (stops[i][2] - stops[i-1][2]) * f,
          stops[i-1][3] + (stops[i][3] - stops[i-1][3]) * f,
        ];
      }
    }
    return [0.70, 0.05, 0.05];
  },
  // t = 0/1 (North) → 0.25 (East) → 0.5 (South) → 0.75 (West) → back to North
  aspect: (t) => {
    const stops = [
      [0.00, 0.20, 0.40, 0.80],
      [0.25, 0.95, 0.85, 0.15],
      [0.50, 0.85, 0.15, 0.15],
      [0.75, 0.15, 0.70, 0.30],
      [1.00, 0.20, 0.40, 0.80],
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const f = (t - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
        return [
          stops[i-1][1] + (stops[i][1] - stops[i-1][1]) * f,
          stops[i-1][2] + (stops[i][2] - stops[i-1][2]) * f,
          stops[i-1][3] + (stops[i][3] - stops[i-1][3]) * f,
        ];
      }
    }
    return [0.20, 0.40, 0.80];
  },
};

// ── TWD97 Grid shader uniforms ───────────────────────────────────────────────────
// Shared with onBeforeCompile — mutate .value in-place to update without recompile.
const gridUniforms = {
  uGridSpacing: { value: 5000.0 },           // metres between grid lines
  uGridOpacity: { value: 0.0 },              // 0 = hidden
  uGridOffset:  { value: new THREE.Vector2(0, 0) },  // (x_center, y_center) from GLB extras
};

// ── Sun / hillshade uniforms ─────────────────────────────────────────────────────
// uSunDirView is recomputed each frame from sunDirWorld via camera.matrixWorldInverse
// so hillshade stays correct as the camera orbits.
const sunUniforms = {
  uHillshade:  { value: 0.0 },
  uSunDirView: { value: new THREE.Vector3() },
};
// World-space sun direction; matches dirLight.position by default (NW sun at 45°)
let sunDirWorld = new THREE.Vector3(-1, 1.2, -1).normalize();

// ── State ────────────────────────────────────────────────────────────────────────
/** @type {THREE.Mesh[]} */
let terrainMeshes = [];
/** @type {THREE.Group|null} */
let terrainGroup = null;
/** @type {THREE.MeshStandardMaterial|null} */
let terrainMat = null;
/** @type {THREE.Box3|null} */
let terrainBBox = null;
/** @type {Record<string,number>} */
let glbMeta = {};
let userZScale = 1.0;
let currentColorMap = 'terrain';
let panelOpen = window.innerWidth >= 1280;
let modalLang = 'en';
let hintTimer = null;
let introComplete = false;

// Boundary overlay state
/** @type {THREE.Group|null} */
let boundaryGroup = null;
const BOUNDARY_LIFT = 50; // metres above terrain max (in geometry Y-space)

// LOD state
/** @type {Map<string, THREE.BufferGeometry>} raw geometry cache (avoids re-fetching) */
const lodCache = new Map();
/**
 * Built-group cache: stores the fully-chunked + vertex-coloured TerrainGroup per URL
 * so repeated LOD switches are an O(1) scene-graph swap, not a re-chunk.
 * @type {Map<string, { group: THREE.Group, meshes: THREE.Mesh[], bbox: THREE.Box3, colorMap: string }>}
 */
const lodGroupCache = new Map();
let activeLodUrl = '';
let lodPending = false;
let lodFrameCount = 0;

// ── Detail-tile streaming (option C: 20 m tiles over the 100 m base) ───────────────
// Global elevation range from the base mesh — detail tiles colour against the SAME
// range so their palette matches the overview seamlessly.
let baseYMin = 0;
let baseYMax = 1;
/** @type {THREE.MeshStandardMaterial|null} shared material for base + detail tiles */
let tileMat = null;
const detailGroup   = new THREE.Group(); // 20 m tiles
const baseTileGroup = new THREE.Group(); // 100 m tiles
/** @type {{center:number[], tileSize:number, tiles:{key:string,url:string,cx:number,cz:number}[]}|null} */
let tileIndex = null;
/** @type {Map<string, THREE.Mesh>} resident 20 m tiles, keyed by tile id */
const detailTiles  = new Map();
/** @type {Map<string, THREE.Mesh>} resident 100 m tiles, keyed by tile id */
const baseTiles    = new Map();
const detailLoading = new Set();
const baseLoading   = new Set();
let detailFrameCount = 0;
// Tiled LOD state machine with hysteresis to prevent rapid toggling at the threshold.
// Buffer zone [FAR_ALT_ENTER, FAR_ALT_EXIT] maintains the current state unchanged.
const FAR_ALT_EXIT  = 22000; // rising above this while in tile mode → switch to monolithic
const FAR_ALT_ENTER = 18000; // descending below this while in monolithic mode → pre-warm tiles
const DETAIL_DIST   = 18000; // camera-still: within this of camera → upgrade to 20 m tile
const DETAIL_EVICT  = 24000;
const LOD_HYST      = 4000;  // keep a 20 m tile until this far past DETAIL_DIST (anti-thrash)
const DETAIL_MAX    = 160;   // resident 20 m cap
const BASE_MAX      = 320;   // resident 100 m cap
const MAX_CONCURRENT = 8;
// true = monolithic hidden, tile mode active. false = monolithic visible (high-alt or pre-warming).
let tilesModeActive = false;
let cameraMoving    = false;
let movingTimer     = null;
// Reused per-frame for frustum-based tile selection (no per-call allocation).
const _detFrustum = new THREE.Frustum();
const _detProj    = new THREE.Matrix4();
const _detSphere  = new THREE.Sphere();

// ── Panel toggle ─────────────────────────────────────────────────────────────────
function setPanelOpen(open) {
  panelOpen = open;
  controlPanel.dataset.open = open ? '1' : '0';
  panelToggleBtn.textContent = open ? '✕' : '☰';
  panelToggleBtn.setAttribute('aria-expanded', String(open));
}
setPanelOpen(panelOpen);
panelToggleBtn.addEventListener('click', () => setPanelOpen(!panelOpen));

// ── Resize ───────────────────────────────────────────────────────────────────────
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ── Camera helpers ───────────────────────────────────────────────────────────────
function getTerrainInfo() {
  if (!terrainBBox) return null;
  const center = new THREE.Vector3();
  const size   = new THREE.Vector3();
  terrainBBox.getCenter(center);
  terrainBBox.getSize(size);
  const diag = Math.sqrt(size.x ** 2 + size.z ** 2);
  return { center, size, diag };
}

// Reset to the initial Taipei viewpoint (north up).
// GLB local: x = TWD97_E - x_center, z = -(TWD97_N - y_center)
function cameraReset() {
  if (!terrainBBox) return;
  const taipeiX = 305000 - (glbMeta.x_center ?? 0);
  const taipeiZ = -(2773000 - (glbMeta.y_center ?? 0));
  const floorY  = terrainBBox.min.y;
  controls.target.set(taipeiX, floorY, taipeiZ);
  // Due-south (+Z) of target so the view direction is -Z (north up).
  camera.position.set(taipeiX, floorY + 22000, taipeiZ + 22000);
  controls.update();
}

function cameraTop() {
  const info = getTerrainInfo();
  if (!info) return;
  const { center, size } = info;
  controls.target.copy(center);
  camera.position.set(center.x, center.y + Math.max(size.x, size.z) * 0.85, center.z + 0.1);
  controls.update();
}

resetCameraBtn.addEventListener('click', cameraReset);
topViewBtn.addEventListener('click', cameraTop);

// ── Fly keys ─────────────────────────────────────────────────────────────────────
const keysDown = new Set();

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keysDown.add(e.key.toLowerCase());
  if (e.key === 'r' || e.key === 'R') cameraReset();
  if (e.key === 't' || e.key === 'T') cameraTop();
  if (e.key === 'Escape' && !mathModal.hidden) mathModal.hidden = true;
});

document.addEventListener('keyup',  (e) => keysDown.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keysDown.clear());

// ── Raycaster ────────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

function toNDC(e) {
  const rect = canvas.getBoundingClientRect();
  mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
}

canvas.addEventListener('dblclick', (e) => {
  if (terrainMeshes.length === 0) return;
  toNDC(e);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(terrainMeshes);
  if (hits.length > 0) {
    controls.target.copy(hits[0].point);
    controls.update();
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (terrainMeshes.length === 0) return;
  toNDC(e);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(terrainMeshes);
  if (hits.length > 0) {
    const { x, y, z } = hits[0].point;
    const glbZScale = glbMeta.z_scale ?? 1;
    const xCenter   = glbMeta.x_center ?? 0;
    const yCenter   = glbMeta.y_center ?? 0;
    const elev = (y / (glbZScale * userZScale)).toFixed(1);
    const fmt  = (n) => Math.round(n).toLocaleString('en');
    coordHud.textContent = xCenter
      ? `TWD97  E: ${fmt(x + xCenter)} m  N: ${fmt(-z + yCenter)} m  ▲ ${elev} m`
      : `E: ${fmt(x)} m  N: ${fmt(-z)} m  ▲ ${elev} m`;
  } else {
    coordHud.textContent = 'E: —  N: —  ▲ —';
  }
  nudgeHint();
});

// ── Operation hint autohide ──────────────────────────────────────────────────────
function nudgeHint() {
  opHint.style.opacity = '1';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { opHint.style.opacity = '0'; }, 3000);
}
setTimeout(() => { opHint.style.opacity = '0'; }, 5000);
opHint.addEventListener('click', nudgeHint);

// ── Vertex colour application ────────────────────────────────────────────────────
// Elevation maps (terrain/grayscale/rainbow): 2-pass — global yMin/yMax → per-vertex colour.
// Slope/Aspect: single-pass using the normal attribute (no elevation normalization).
function applyVertexColors(meshes, mapName) {
  const isSlope  = mapName === 'slope';
  const isAspect = mapName === 'aspect';

  // Pass 1: global Y range (elevation-based maps only)
  let yMin = Infinity, yMax = -Infinity;
  if (!isSlope && !isAspect) {
    for (const mesh of meshes) {
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
  }

  const fn    = COLOR_MAPS[mapName] ?? COLOR_MAPS.terrain;
  const range = (yMax - yMin) || 1;

  // Remember the base range so detail tiles colour against the same scale.
  if (!isSlope && !isAspect) { baseYMin = yMin; baseYMax = yMax; }

  // Pass 2: per-vertex colour
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const nor = mesh.geometry.attributes.normal;
    const buf = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      let t;
      if (isSlope) {
        // slope angle from vertical: acos(normalY) / 90°
        const ny = Math.max(-1, Math.min(1, nor.getY(i)));
        t = Math.acos(ny) / (Math.PI / 2);
      } else if (isAspect) {
        // compass direction the slope faces: atan2 in XZ plane
        // N=-Z, E=+X → atan2(nx, -nz): N=0, E=π/2, S=π, W=-π/2
        const nx = nor.getX(i), nz = nor.getZ(i);
        t = (Math.atan2(nx, -nz) + Math.PI) / (2 * Math.PI);
      } else {
        t = (pos.getY(i) - yMin) / range;
      }
      const [r, g, b] = fn(Math.max(0, Math.min(1, t)));
      buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(buf, 3));
  }

  if (terrainMat) {
    terrainMat.vertexColors = true;
    terrainMat.needsUpdate  = true;
  }

  if (isSlope) {
    legendMin.textContent = '0°';
    legendMax.textContent = '90°';
  } else if (isAspect) {
    legendMin.textContent = 'N';
    legendMax.textContent = 'N ↺';
  } else {
    const glbZScale = glbMeta.z_scale ?? 1;
    legendMin.textContent = `${Math.round(yMin / glbZScale)} m`;
    legendMax.textContent = `${Math.round(yMax / glbZScale)} m`;
  }
  rebuildLegendBar(mapName);
}

function rebuildLegendBar(mapName) {
  const fn    = COLOR_MAPS[mapName] ?? COLOR_MAPS.terrain;
  const steps = 32;
  const stops = Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    const [r, g, b] = fn(t);
    return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)}) ${(t*100).toFixed(1)}%`;
  });
  legendBar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
}

// ── Control panel events ─────────────────────────────────────────────────────────
zScaleSlider.addEventListener('input', () => {
  userZScale = parseFloat(zScaleSlider.value);
  zScaleValue.textContent = `${userZScale.toFixed(1)}×`;
  if (terrainGroup) terrainGroup.scale.y = userZScale;
  detailGroup.scale.y = userZScale;
  baseTileGroup.scale.y = userZScale;
  updateRoadY();
  updateBoundaryY();
});

wireframeToggle.addEventListener('change', () => {
  // Apply to both the backdrop material and the tile material (the visible surface near in).
  for (const mat of [terrainMat, tileMat]) {
    if (mat) { mat.wireframe = wireframeToggle.checked; mat.needsUpdate = true; }
  }
});

gridToggle.addEventListener('change', () => {
  gridUniforms.uGridOpacity.value = gridToggle.checked ? 0.65 : 0.0;
  gridSpacingRow.hidden = !gridToggle.checked;
});

gridSpacingSelect.addEventListener('change', () => {
  gridUniforms.uGridSpacing.value = parseFloat(gridSpacingSelect.value);
});

colorMapSelect.addEventListener('change', () => {
  currentColorMap = colorMapSelect.value;
  if (terrainMeshes.length > 0) applyVertexColors(terrainMeshes, currentColorMap);
  // Recolour resident tiles against the (possibly updated) base range.
  for (const m of detailTiles.values()) colorTileGeometry(m.geometry, currentColorMap);
  for (const m of baseTiles.values())   colorTileGeometry(m.geometry, currentColorMap);
  // Keep the group cache in sync so the active LOD restores correct colors on re-visit
  const entry = lodGroupCache.get(activeLodUrl);
  if (entry) entry.colorMap = currentColorMap;
});

// ── LOD levels (altitude thresholds in GLB Y-units = metres at z_scale=1) ────────
// camera.position.y − terrainBBox.min.y gives height above lowest terrain point.
//   > 8000 m above terrain → 100 m mesh (wide overview)
//   3000–8000 m            → 40 m mesh  (regional zoom)
//   < 3000 m               → 20 m mesh  (detail zoom)
const BASE = import.meta.env.BASE_URL;
// Merged main-island terrain. A full 20 m island mesh is not web-viable
// (~90 M verts), so the overview ships at 100 m; finer LODs can be added here
// once produced (e.g. taiwan_40m.glb).
const LOD_LEVELS = [
  { url: BASE + 'taiwan_100m.glb', label: '100 m', maxAlt: Infinity },
];
const GLB_URL = BASE + 'taiwan_100m.glb';

function setLodBadge(text, loading = false) {
  lodBadge.textContent = text;
  lodBadge.dataset.loading = loading ? '1' : '0';
}

function targetLodUrl() {
  if (!terrainBBox) return GLB_URL;
  const alt = camera.position.y - terrainBBox.min.y;
  for (const lvl of LOD_LEVELS) {
    if (alt <= lvl.maxAlt) return lvl.url;
  }
  return GLB_URL;
}

async function switchLod(url) {
  if (lodPending || url === activeLodUrl || !terrainGroup) return;
  lodPending = true;

  const lvl = LOD_LEVELS.find(l => l.url === url);
  const cached = lodGroupCache.get(url);

  // Cached path: scene swap only — no re-chunk, no re-colour (unless map changed)
  if (cached) {
    if (cached.colorMap !== currentColorMap) {
      applyVertexColors(cached.meshes, currentColorMap);
      cached.colorMap = currentColorMap;
    }
    const oldGroup = terrainGroup;
    terrainGroup  = cached.group;
    terrainMeshes = cached.meshes;
    terrainBBox   = cached.bbox;
    terrainGroup.scale.y = userZScale;
    scene.remove(oldGroup);
    scene.add(terrainGroup);
    updateRoadY();
    updateBoundaryY();
    activeLodUrl = url;
    setLodBadge(lvl?.label ?? url, false);
    lodPending = false;
    return;
  }

  // First visit: fetch → chunk → colour → cache
  setLodBadge(`↑ ${lvl?.label}…`, true);
  try {
    let geom = lodCache.get(url);
    if (!geom) {
      geom = await new Promise((resolve, reject) => {
        loader.load(
          url,
          (gltf) => {
            let m = null;
            gltf.scene.traverse(n => { if (n.isMesh && !m) m = n; });
            if (!m) { reject(new Error('no mesh in ' + url)); return; }
            const extras = gltf.parser.json?.extras ?? {};
            if (extras.x_center) {
              glbMeta = extras;
              gridUniforms.uGridOffset.value.set(extras.x_center, extras.y_center ?? 0);
            }
            resolve(m.geometry);
          },
          undefined,
          reject,
        );
      });
      lodCache.set(url, geom);
    }

    const oldGroup = terrainGroup;
    buildTerrainGroup(geom);
    applyVertexColors(terrainMeshes, currentColorMap);
    lodGroupCache.set(url, {
      group:    terrainGroup,
      meshes:   terrainMeshes,
      bbox:     terrainBBox,
      colorMap: currentColorMap,
    });
    terrainGroup.scale.y = userZScale;
    scene.remove(oldGroup);
    scene.add(terrainGroup);
    updateRoadY();
    updateBoundaryY();

    activeLodUrl = url;
    setLodBadge(lvl?.label ?? url, false);
  } catch (err) {
    console.warn('LOD switch failed:', err);
    const cur = LOD_LEVELS.find(l => l.url === activeLodUrl);
    setLodBadge(cur?.label ?? '?', false);
  } finally {
    lodPending = false;
  }
}

// ── Detail-tile streaming ─────────────────────────────────────────────────────────
/**
 * Colour a tile geometry in-place using the active map and the BASE elevation
 * range (so a flat tile doesn't span the whole palette). Mirrors pass 2 of
 * applyVertexColors but with a fixed range instead of a per-mesh one.
 * @param {THREE.BufferGeometry} geom
 * @param {string} mapName
 */
function colorTileGeometry(geom, mapName) {
  const isSlope  = mapName === 'slope';
  const isAspect = mapName === 'aspect';
  const fn    = COLOR_MAPS[mapName] ?? COLOR_MAPS.terrain;
  const range = (baseYMax - baseYMin) || 1;
  const pos = geom.attributes.position;
  const nor = geom.attributes.normal;
  const buf = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    let t;
    if (isSlope) {
      const ny = Math.max(-1, Math.min(1, nor.getY(i)));
      t = Math.acos(ny) / (Math.PI / 2);
    } else if (isAspect) {
      const nx = nor.getX(i), nz = nor.getZ(i);
      t = (Math.atan2(nx, -nz) + Math.PI) / (2 * Math.PI);
    } else {
      t = (pos.getY(i) - baseYMin) / range;
    }
    const [r, g, b] = fn(Math.max(0, Math.min(1, t)));
    buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(buf, 3));
}

/** Show "100 m overview" or "20 m ×N · 100 m ×M" in the LOD badge. */
function setDetailBadge() {
  const n = detailTiles.size + baseTiles.size;
  setLodBadge(n === 0 ? '100 m overview' : `20 m ×${detailTiles.size} · 100 m ×${baseTiles.size}`, false);
}

/** @param {Map<string,THREE.Mesh>} map @param {THREE.Group} group @param {string} key */
function disposeTile(map, group, key) {
  const m = map.get(key);
  if (!m) return;
  group.remove(m);
  m.geometry.dispose();
  map.delete(key);
  if (map === detailTiles && detailTileGrids.delete(key)) scheduleRoadRebake();
}

/**
 * Load one tile at the given level. 'detail' = 20 m (tiles/), 'base' = 100 m (base_tiles/).
 * @param {{key:string,url:string,cx:number,cz:number}} tile
 * @param {'detail'|'base'} level
 */
function loadTile(tile, level) {
  const isDetail = level === 'detail';
  const map      = isDetail ? detailTiles  : baseTiles;
  const loading  = isDetail ? detailLoading : baseLoading;
  const group    = isDetail ? detailGroup  : baseTileGroup;
  const url      = import.meta.env.BASE_URL + (isDetail ? tile.url : `base_tiles/${tile.key}.glb`);
  loading.add(tile.key);
  loader.load(
    url,
    (gltf) => {
      loading.delete(tile.key);
      let mesh = null;
      gltf.scene.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
      if (!mesh || !tileMat) return;
      colorTileGeometry(mesh.geometry, currentColorMap);
      const m = new THREE.Mesh(mesh.geometry, tileMat);
      m.userData.cx = tile.cx;
      m.userData.cz = tile.cz;
      // Dispose the 100 m tile BEFORE adding the 20 m tile to avoid one-frame Z-fighting.
      // Keeping 100 m visible while 20 m loaded prevents the black gap that would occur if
      // 100 m were disposed eagerly (before the async load finished).
      if (isDetail && baseTiles.has(tile.key)) disposeTile(baseTiles, baseTileGroup, tile.key);
      group.add(m);
      map.set(tile.key, m);
      // Build per-tile 20 m height grid and schedule road elevation rebake.
      if (isDetail) {
        detailTileGrids.set(tile.key, buildDetailTileGrid(mesh.geometry));
        scheduleRoadRebake();
      }
      setDetailBadge();
    },
    undefined,
    () => { loading.delete(tile.key); },
  );
}

/** Drop the farthest residents in `map` when over `cap`. */
function capTiles(map, group, cap, cxw, czw) {
  if (map.size <= cap) return;
  const over = map.size - cap;  // capture before disposing (map.size shrinks below)
  const byDist = [...map.entries()]
    .map(([k, m]) => ({ k, d: Math.hypot(m.userData.cx - cxw, m.userData.cz - czw) }))
    .sort((a, b) => b.d - a.d);
  for (let i = 0; i < over; i++) disposeTile(map, group, byDist[i].k);
}

/**
 * State-machine tiled LOD with hysteresis:
 *   High (alt > FAR_ALT_EXIT)  → monolithic only, tiles disposed.
 *   Buffer zone                → freeze current state (no transition).
 *   Low (alt < FAR_ALT_ENTER)  → tile mode. Pre-warm: load 100 m tiles while keeping
 *                                monolithic visible; switch when all frustum cells covered.
 *   Moving camera              → all frustum tiles use 100 m (avoid 20 m churn).
 *   Still camera               → near < DETAIL_DIST → 20 m, far → 100 m.
 */
function updateTiles() {
  if (!tileIndex || !terrainBBox || !tileMat) return;

  const alt = camera.position.y - terrainBBox.min.y;

  // ── High-altitude exit ───────────────────────────────────────────────────────────
  if (tilesModeActive && alt > FAR_ALT_EXIT) {
    if (terrainGroup) terrainGroup.visible = true;
    for (const k of [...detailTiles.keys()]) disposeTile(detailTiles, detailGroup, k);
    for (const k of [...baseTiles.keys()])   disposeTile(baseTiles, baseTileGroup, k);
    tilesModeActive = false;
    setDetailBadge();
    return;
  }

  // ── Monolithic mode: stay until below FAR_ALT_ENTER ─────────────────────────────
  if (!tilesModeActive && alt >= FAR_ALT_ENTER) {
    // Pure high-altitude: flush any stale tiles (e.g. if tileIndex was populated while high)
    if (alt > FAR_ALT_EXIT) {
      for (const k of [...detailTiles.keys()]) disposeTile(detailTiles, detailGroup, k);
      for (const k of [...baseTiles.keys()])   disposeTile(baseTiles, baseTileGroup, k);
      setDetailBadge();
    }
    return;
  }

  // ── Low-altitude: compute frustum-visible cells ──────────────────────────────────
  const cxw = camera.position.x;
  const czw = camera.position.z;
  _detProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _detFrustum.setFromProjectionMatrix(_detProj);

  const sy      = detailGroup.scale.y;
  const midY    = (terrainBBox.min.y + terrainBBox.max.y) * 0.5 * sy;
  const tileR   = (tileIndex.tileSize ?? 5000) * 0.75;
  const sphereR = Math.max(tileR, (terrainBBox.max.y - terrainBBox.min.y) * sy * 0.5);

  /** @type {{t: object, d: number}[]} */
  const visible = [];
  for (const t of tileIndex.tiles) {
    _detSphere.center.set(t.cx, midY, t.cz);
    _detSphere.radius = sphereR;
    if (!_detFrustum.intersectsSphere(_detSphere)) continue;
    visible.push({ t, d: Math.hypot(t.cx - cxw, t.cz - czw) });
  }
  visible.sort((a, b) => a.d - b.d);

  // ── Pre-warm: load 100 m base tiles before hiding monolithic ─────────────────────
  if (!tilesModeActive) {
    for (const { t } of visible) {
      if (baseTiles.has(t.key) || baseLoading.has(t.key)) continue;
      if (baseLoading.size >= MAX_CONCURRENT) break;
      if (baseTiles.size + baseLoading.size >= BASE_MAX) break;
      loadTile(t, 'base');
    }
    // Switch only once every visible cell has a loaded base tile
    if (visible.length > 0 && visible.every(({ t }) => baseTiles.has(t.key))) {
      if (terrainGroup) terrainGroup.visible = false;
      tilesModeActive = true;
    }
    setDetailBadge();
    return;
  }

  // ── Tile mode: evictions ─────────────────────────────────────────────────────────
  // 20 m: distance-based eviction
  for (const [k, m] of detailTiles) {
    if (Math.hypot(m.userData.cx - cxw, m.userData.cz - czw) > DETAIL_EVICT) {
      disposeTile(detailTiles, detailGroup, k);
    }
  }
  // 100 m: frustum-based eviction (out-of-frustum tiles freed; camera pan reloads them)
  const visibleKeys = new Set(visible.map(({ t }) => t.key));
  for (const k of [...baseTiles.keys()]) {
    if (!visibleKeys.has(k)) disposeTile(baseTiles, baseTileGroup, k);
  }
  capTiles(detailTiles, detailGroup, DETAIL_MAX, cxw, czw);
  capTiles(baseTiles, baseTileGroup, BASE_MAX, cxw, czw);

  // ── Tile mode: loading ───────────────────────────────────────────────────────────
  if (cameraMoving) {
    // Moving: only load near 100 m tiles (within DETAIL_DIST); far tiles not worth the churn.
    // Skip cells that already have a 20 m tile (loaded or loading) — no need for a 100 m fallback.
    for (const { t, d } of visible) {
      if (d >= DETAIL_DIST) break;  // visible is sorted nearest-first
      if (baseTiles.has(t.key) || baseLoading.has(t.key)) continue;
      if (detailTiles.has(t.key) || detailLoading.has(t.key)) continue;
      if (detailLoading.size + baseLoading.size >= MAX_CONCURRENT) break;
      if (baseTiles.size + baseLoading.size >= BASE_MAX) break;
      loadTile(t, 'base');
    }
  } else {
    // Still: near → 20 m, far → 100 m.
    // Do NOT dispose 100 m here — loadTile's callback disposes it once 20 m is ready,
    // so 100 m stays visible as a placeholder during the async load (no black gap).
    for (const { t, d } of visible) {
      const hasDetail = detailTiles.has(t.key);
      const wantsDetail = d < DETAIL_DIST || (hasDetail && d < DETAIL_DIST + LOD_HYST);
      if (wantsDetail) {
        if (!hasDetail && !detailLoading.has(t.key)) {
          if (detailLoading.size < MAX_CONCURRENT && detailTiles.size + detailLoading.size < DETAIL_MAX) {
            loadTile(t, 'detail');
          }
        }
      } else {
        if (hasDetail && d > DETAIL_EVICT) disposeTile(detailTiles, detailGroup, t.key);
        if (!baseTiles.has(t.key) && !baseLoading.has(t.key)) {
          if (detailLoading.size + baseLoading.size < MAX_CONCURRENT && baseTiles.size + baseLoading.size < BASE_MAX) {
            loadTile(t, 'base');
          }
        }
      }
    }
  }

  setDetailBadge();
}

// ── Terrain chunking ─────────────────────────────────────────────────────────────
// Split a single BufferGeometry into CHUNK_R × CHUNK_C sub-meshes so Three.js
// frustum culling can discard off-screen chunks individually.
const CHUNK_R = 8;
const CHUNK_C = 8;

/**
 * @param {THREE.BufferGeometry} geometry
 * @returns {(THREE.BufferGeometry|null)[]}
 */
function chunkGeometry(geometry) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const idxArr = geometry.index.array;

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const W = (bbox.max.x - bbox.min.x) || 1;
  const D = (bbox.max.z - bbox.min.z) || 1;
  const cW = W / CHUNK_C;
  const cD = D / CHUNK_R;

  // Assign each triangle to a chunk bucket by centroid
  const buckets = Array.from({ length: CHUNK_R * CHUNK_C }, () => /** @type {number[]} */ ([]));
  for (let t = 0; t < idxArr.length; t += 3) {
    const i0 = idxArr[t], i1 = idxArr[t + 1], i2 = idxArr[t + 2];
    const cx = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3;
    const cz = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;
    const ci = Math.min(Math.floor((cx - bbox.min.x) / cW), CHUNK_C - 1);
    const ri = Math.min(Math.floor((cz - bbox.min.z) / cD), CHUNK_R - 1);
    buckets[ri * CHUNK_C + ci].push(i0, i1, i2);
  }

  return buckets.map((triIdx) => {
    if (triIdx.length === 0) return null;
    const unique = [...new Set(triIdx)];
    const vertMap = new Map(unique.map((v, i) => [v, i]));
    const n = unique.length;
    const newPos = new Float32Array(n * 3);
    const newNor = new Float32Array(n * 3);
    unique.forEach((ov, ni) => {
      newPos[ni*3]   = pos.getX(ov); newPos[ni*3+1] = pos.getY(ov); newPos[ni*3+2] = pos.getZ(ov);
      newNor[ni*3]   = nor.getX(ov); newNor[ni*3+1] = nor.getY(ov); newNor[ni*3+2] = nor.getZ(ov);
    });
    const newIdx = new Uint32Array(triIdx.length);
    triIdx.forEach((ov, i) => { newIdx[i] = vertMap.get(ov); });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    g.setAttribute('normal',   new THREE.BufferAttribute(newNor, 3));
    g.setIndex(new THREE.BufferAttribute(newIdx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
}

/** Rebuild terrainGroup / terrainMeshes from a (possibly new) geometry. */
function buildTerrainGroup(geometry) {
  const chunks = chunkGeometry(geometry);
  const group  = new THREE.Group();
  const meshes = [];
  for (const cg of chunks) {
    if (!cg) continue;
    const m = new THREE.Mesh(cg, terrainMat);
    group.add(m);
    meshes.push(m);
  }
  terrainGroup  = group;
  terrainMeshes = meshes;
  terrainBBox   = new THREE.Box3();
  for (const m of meshes) terrainBBox.union(m.geometry.boundingBox);
}

// ── Sun position ─────────────────────────────────────────────────────────────────
/**
 * Simplified astronomical sun position for Taiwan (≈25°N, equinox declination).
 * @param {number} hour - solar time (0–24)
 * @returns {{ alt: number, az: number, above: boolean }}
 */
// ── Terrain height grid (for road elevation lookup) ──────────────────────────────
/** @type {Map<string, number>|null} built once from first terrain load */
let terrainHeightGrid = null;
const HEIGHT_SNAP  = 100; // metres — coarsest (100 m) GLB grid
const DETAIL_SNAP  = 20;  // metres — 20 m tile grid resolution

// Per-tile mini height-maps built as 20 m tiles load; keyed by tile key.
/** @type {Map<string, Map<string, number>>} */
const detailTileGrids = new Map();

// Spatial index: `${gridI},${gridJ}` → tile key. Built when tileIndex loads.
// Grid indices are relative to the minimum tile center to avoid floating-point
// misalignment when centers are not at exact multiples of tileSize.
/** @type {Map<string, string>|null} */
let tileSpatialIndex  = null;
let tileSpatialSnap   = 5000; // tileSize from index.json
let tileSpatialOrigin = { x: 0, z: 0 }; // minimum (cx, cz)

/** Debounce handle for re-baking road elevations after detail tiles change. */
let roadRebakeTimer = null;
function scheduleRoadRebake() {
  clearTimeout(roadRebakeTimer);
  roadRebakeTimer = setTimeout(applyRoadElevations, 400);
}

/** Build the tile spatial index once tileIndex is available. */
function buildTileSpatialIndex() {
  tileSpatialSnap = tileIndex.tileSize ?? 5000;
  // Normalise relative to the minimum centre so that Math.round works correctly
  // even when tile centres are not at exact multiples of tileSize.
  let minCx = Infinity, minCz = Infinity;
  for (const t of tileIndex.tiles) {
    if (t.cx < minCx) minCx = t.cx;
    if (t.cz < minCz) minCz = t.cz;
  }
  tileSpatialOrigin = { x: minCx, z: minCz };
  tileSpatialIndex  = new Map();
  for (const t of tileIndex.tiles) {
    const gx = Math.round((t.cx - minCx) / tileSpatialSnap);
    const gz = Math.round((t.cz - minCz) / tileSpatialSnap);
    tileSpatialIndex.set(`${gx},${gz}`, t.key);
  }
}

/**
 * Build a 20 m resolution height-map for one detail tile geometry.
 * @param {THREE.BufferGeometry} geometry
 * @returns {Map<string, number>}
 */
function buildDetailTileGrid(geometry) {
  const grid = new Map();
  const pos  = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const gx  = Math.round(pos.getX(i) / DETAIL_SNAP);
    const gz  = Math.round(pos.getZ(i) / DETAIL_SNAP);
    const key = `${gx},${gz}`;
    const y   = pos.getY(i);
    const cur = grid.get(key);
    if (cur === undefined || y > cur) grid.set(key, y);
  }
  return grid;
}

function buildTerrainHeightGrid() {
  terrainHeightGrid = new Map();
  terrainGroup.traverse((obj) => {
    if (!obj.isMesh) return;
    const pos = obj.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const gx = Math.round(pos.getX(i) / HEIGHT_SNAP);
      const gz = Math.round(pos.getZ(i) / HEIGHT_SNAP);
      const key = `${gx},${gz}`;
      const y = pos.getY(i);
      const cur = terrainHeightGrid.get(key);
      if (cur === undefined || y > cur) terrainHeightGrid.set(key, y);
    }
  });
}

/**
 * Terrain elevation at (x, z) in GLB local space.
 * Prefers 20 m detail tile data when the tile is loaded; falls back to 100 m grid.
 * Takes the max of the 4 surrounding grid corners so roads never sink between samples.
 * @param {number} x @param {number} z @returns {number}
 */
function sampleTerrainHeight(x, z) {
  // 20 m detail tile lookup — O(1) via spatial index
  if (tileSpatialIndex) {
    const sgx = Math.round((x - tileSpatialOrigin.x) / tileSpatialSnap);
    const sgz = Math.round((z - tileSpatialOrigin.z) / tileSpatialSnap);
    const tileKey = tileSpatialIndex.get(`${sgx},${sgz}`);
    if (tileKey) {
      const grid = detailTileGrids.get(tileKey);
      if (grid) {
        const dgx = x / DETAIL_SNAP;
        const dgz = z / DETAIL_SNAP;
        const x0 = Math.floor(dgx), x1 = x0 + 1;
        const z0 = Math.floor(dgz), z1 = z0 + 1;
        let maxY;
        for (const cx of [x0, x1]) {
          for (const cz of [z0, z1]) {
            const y = grid.get(`${cx},${cz}`);
            if (y !== undefined && (maxY === undefined || y > maxY)) maxY = y;
          }
        }
        if (maxY !== undefined) return maxY;
      }
    }
  }

  // 100 m fallback
  if (!terrainHeightGrid || !terrainBBox) return terrainBBox?.min.y ?? 0;
  const gx = x / HEIGHT_SNAP;
  const gz = z / HEIGHT_SNAP;
  const x0 = Math.floor(gx), x1 = x0 + 1;
  const z0 = Math.floor(gz), z1 = z0 + 1;
  let maxY = terrainBBox.min.y;
  for (const cx of [x0, x1]) {
    for (const cz of [z0, z1]) {
      const y = terrainHeightGrid.get(`${cx},${cz}`);
      if (y !== undefined && y > maxY) maxY = y;
    }
  }
  return maxY;
}

// ── Road overlay ─────────────────────────────────────────────────────────────────
/** @type {THREE.Group|null} */
let roadGroup = null;
/** @type {Map<string, THREE.LineSegments>} */
const roadLayers = new Map();
// Roads float ROAD_LIFT world-metres above terrain; scale.y tracks userZScale.
const ROAD_LIFT = 80;

/**
 * After terrain height grid is ready, bake per-vertex elevation into road buffers.
 * Vertex local-Y = raw terrain elevation; roadGroup.scale.y = userZScale
 * → world_Y = ROAD_LIFT + userZScale × elevation, matching the terrain transform.
 */
function applyRoadElevations() {
  if (!terrainHeightGrid || roadLayers.size === 0) return;
  for (const [, seg] of roadLayers) {
    const pos = seg.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, sampleTerrainHeight(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
  }
}

function updateRoadY() {
  if (!roadGroup) return;
  roadGroup.position.y = ROAD_LIFT;
  roadGroup.scale.y = userZScale;
}

/**
 * Build a THREE.Group with one LineSegments per road class.
 * Input arrays are flat XZ edge pairs: [x0,z0, x1,z1, ...] with Y=0.
 * @param {{ highway: number[], expressway: number[], provincial: number[] }} data
 * @returns {THREE.Group}
 */
function buildRoadGroup(data) {
  const group = new THREE.Group();
  roadLayers.clear();
  const classes = [
    { key: 'highway',    color: 0xff5522, opacity: 0.95 },
    { key: 'expressway', color: 0x88bbff, opacity: 0.90 },
    { key: 'provincial', color: 0x66ccaa, opacity: 0.85 },
  ];
  for (const { key, color, opacity } of classes) {
    const flat = data[key];
    if (!flat || flat.length < 4) continue;
    const edgeCount = flat.length / 4;
    const positions = new Float32Array(edgeCount * 6);
    for (let i = 0; i < edgeCount; i++) {
      const fi = i * 4, pi = i * 6;
      const x0 = flat[fi], z0 = flat[fi+1], x1 = flat[fi+2], z1 = flat[fi+3];
      positions[pi]   = x0; positions[pi+1] = sampleTerrainHeight(x0, z0); positions[pi+2] = z0;
      positions[pi+3] = x1; positions[pi+4] = sampleTerrainHeight(x1, z1); positions[pi+5] = z1;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const seg = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    roadLayers.set(key, seg);
    group.add(seg);
  }
  return group;
}

fetch(BASE + 'roads.json')
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((data) => {
    roadGroup = buildRoadGroup(data);
    roadGroup.visible = roadsToggle.checked;
    updateRoadY();
    scene.add(roadGroup);
  })
  .catch(() => { console.info('[roads] Not found — run: just convert-roads'); });

roadsToggle.addEventListener('change', () => {
  if (roadGroup) roadGroup.visible = roadsToggle.checked;
  roadsSub.hidden = !roadsToggle.checked;
});
/** @param {string} key @param {boolean} v */
function setRoadLayerVisible(key, v) {
  const seg = roadLayers.get(key);
  if (seg) seg.visible = v;
}
roadsHighwayToggle.addEventListener('change', () => setRoadLayerVisible('highway', roadsHighwayToggle.checked));
roadsExpresswayToggle.addEventListener('change', () => setRoadLayerVisible('expressway', roadsExpresswayToggle.checked));
roadsProvincialToggle.addEventListener('change', () => setRoadLayerVisible('provincial', roadsProvincialToggle.checked));

// ── Admin boundary overlay ───────────────────────────────────────────────────────
const boundaryMat = new THREE.LineBasicMaterial({
  color: 0xffe566,
  transparent: true,
  opacity: 0.75,
});

/**
 * Lift boundary group so it hovers just above the highest terrain point in world space.
 * terrainBBox.max.y is in geometry space; terrainGroup.scale.y = userZScale stretches it.
 */
function updateBoundaryY() {
  if (!boundaryGroup || !terrainBBox) return;
  boundaryGroup.position.y = terrainBBox.max.y * userZScale + BOUNDARY_LIFT;
}

/**
 * Build a THREE.Group of LineLoops from the rings array in boundaries.json.
 * Each vertex is [x, z] in Three.js local space; Y is set to 0 and the group
 * is translated via updateBoundaryY().
 *
 * @param {Array<Array<[number, number]>>} rings
 * @returns {THREE.Group}
 */
function buildBoundaryGroup(rings) {
  const group = new THREE.Group();
  for (const ring of rings) {
    if (ring.length < 2) continue;
    const positions = new Float32Array(ring.length * 3);
    for (let i = 0; i < ring.length; i++) {
      positions[i * 3]     = ring[i][0];
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = ring[i][1];
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    group.add(new THREE.LineLoop(geom, boundaryMat));
  }
  return group;
}

// Load boundaries.json produced by `just convert-boundaries`.
// Non-fatal: silently skips if the file doesn't exist yet.
fetch(BASE + 'boundaries.json')
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((data) => {
    boundaryGroup = buildBoundaryGroup(data.rings ?? []);
    boundaryGroup.visible = boundariesToggle.checked;
    updateBoundaryY();
    scene.add(boundaryGroup);
  })
  .catch(() => {
    console.info('[boundaries] Not found — run: just convert-boundaries');
  });

boundariesToggle.addEventListener('change', () => {
  if (boundaryGroup) boundaryGroup.visible = boundariesToggle.checked;
});

hillshadeToggle.addEventListener('change', () => {
  sunUniforms.uHillshade.value = hillshadeToggle.checked ? 1.0 : 0.0;
});


// ── Load terrain ─────────────────────────────────────────────────────────────────
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(import.meta.env.BASE_URL + 'draco/');
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

(function loadTerrain() {
  loadingOverlay.hidden = false;
  progressFill.style.background = '';
  loadingDetail.textContent = `Fetching ${GLB_URL.slice(1)}…`;

  loader.load(
    GLB_URL,
    (gltf) => {
      glbMeta = gltf.parser.json?.extras ?? {};

      // Update grid offset now that we know the TWD97 centroid
      gridUniforms.uGridOffset.value.set(
        glbMeta.x_center ?? 0,
        glbMeta.y_center ?? 0
      );

      let firstMesh = null;
      gltf.scene.traverse((node) => {
        if (node.isMesh && !firstMesh) firstMesh = node;
      });

      if (!firstMesh) {
        loadingDetail.textContent = 'Error: no mesh found in GLB.';
        return;
      }

      terrainMat = new THREE.MeshStandardMaterial({
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.FrontSide,
      });
      // Inject TWD97 grid overlay into the standard material's fragment shader.
      // Grid lines are computed from world-space XZ, which maps 1:1 to TWD97 metres
      // (GLB X = E - xCenter, GLB Z = -(N - yCenter)), so we undo the offset in-shader.
      terrainMat.onBeforeCompile = (shader) => {
        // Pass worldspace position from vertex to fragment
        shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        );

        // Inject all custom uniforms into the fragment shader header
        shader.fragmentShader = [
          'varying vec3 vWorldPos;',
          'uniform float uGridSpacing;',
          'uniform float uGridOpacity;',
          'uniform vec2  uGridOffset;',
          'uniform float uHillshade;',
          'uniform vec3  uSunDirView;',
          shader.fragmentShader,
        ].join('\n');

        // Hillshade → then grid → then dithering
        // `normal` is the view-space surface normal set by normal_fragment_begin.
        // `uSunDirView` is sunDirWorld transformed to view space each frame.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `{
  // Hillshade: Lambert factor in view space, multiplied over terrain colour
  float hs = max(0.0, dot(normal, uSunDirView));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * max(0.25, hs), uHillshade);
}
{
  // TWD97 grid overlay
  vec2 twd97 = vec2(vWorldPos.x + uGridOffset.x, -vWorldPos.z + uGridOffset.y);
  vec2 gmod = mod(twd97, uGridSpacing);
  float d = min(min(gmod.x, uGridSpacing - gmod.x),
                min(gmod.y, uGridSpacing - gmod.y));
  float lineW = uGridSpacing * 0.004;
  float ga = (1.0 - smoothstep(0.0, lineW, d)) * uGridOpacity;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.95, 0.95, 1.0), ga);
}
#include <dithering_fragment>`
        );

        // Bind all shared uniform objects so mutations propagate each frame
        Object.assign(shader.uniforms, gridUniforms, sunUniforms);
      };

      // Unique cache key prevents Three.js merging this with an unmodified material
      terrainMat.customProgramCacheKey = () => 'terrain-grid-v2';

      // Split into 8×8 chunks; each has its own bounding sphere for frustum culling
      const fullGeom = firstMesh.geometry;
      lodCache.set(GLB_URL, fullGeom);
      buildTerrainGroup(fullGeom);
      buildTerrainHeightGrid(); // build once from 100m terrain; roads use this for vertex Y
      applyVertexColors(terrainMeshes, currentColorMap);
      lodGroupCache.set(GLB_URL, {
        group:    terrainGroup,
        meshes:   terrainMeshes,
        bbox:     terrainBBox,
        colorMap: currentColorMap,
      });
      if (userZScale !== 1) terrainGroup.scale.y = userZScale;

      scene.add(terrainGroup);
      applyRoadElevations(); // fix vertex Y if roads loaded before terrain
      updateRoadY();
      updateBoundaryY();
      activeLodUrl = GLB_URL;
      setLodBadge('100 m');

      // Material.copy() in Three.js r163 does NOT copy onBeforeCompile — it only
      // transfers primitive properties. We must copy the hook explicitly so tiles
      // get the same hillshade + grid shader injection as the backdrop.
      // The distinct customProgramCacheKey prevents Three.js from reusing the
      // backdrop's already-compiled program, which would skip the hook entirely.
      tileMat = terrainMat.clone();
      tileMat.onBeforeCompile = terrainMat.onBeforeCompile;
      tileMat.customProgramCacheKey = () => 'terrain-grid-tile-v1';
      detailGroup.scale.y   = userZScale;
      baseTileGroup.scale.y = userZScale;
      scene.add(detailGroup);
      scene.add(baseTileGroup);
      fetch(import.meta.env.BASE_URL + 'tiles/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && d.tiles) { tileIndex = d; buildTileSpatialIndex(); } })
        .catch(() => { console.info('[tiles] tiles/index.json not found — run: just tile'); });

      // ── PoC: load white building massing (region 3357) for alignment check ──
      // TEMPORARY — remove once the building tile pipeline + streaming lands.
      {
        const buildingMat = new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
        });
        loader.load(import.meta.env.BASE_URL + 'buildings_poc.glb', (gltf) => {
          gltf.scene.traverse((n) => { if (n.isMesh) n.material = buildingMat; });
          gltf.scene.scale.y = userZScale;
          scene.add(gltf.scene);
          console.info('[poc] buildings_poc.glb loaded');
        }, undefined, () => console.info('[poc] buildings_poc.glb not found'));
      }

      // Skip intro animation — jump straight to the initial Taipei viewpoint.
      cameraReset();
      controls.enabled = true;
      introComplete    = true;

      progressFill.style.width = '100%';
      setTimeout(() => { loadingOverlay.hidden = true; }, 350);
    },
    (progress) => {
      if (progress.total > 0) {
        const pct = (progress.loaded / progress.total * 100).toFixed(0);
        progressFill.style.width = `${pct}%`;
        const mb    = (progress.loaded / 1048576).toFixed(1);
        const total = (progress.total  / 1048576).toFixed(1);
        loadingDetail.textContent = `${mb} / ${total} MB`;
      }
    },
    (err) => {
      console.error('GLB load failed:', err);
      progressFill.style.background = '#e74c3c';
      loadingDetail.textContent = `Cannot load ${GLB_URL} — run: just convert-100m`;
    }
  );
}());

// ── WASD / QE fly movement ───────────────────────────────────────────────────────
// Reuse vectors to avoid GC pressure in the hot path.
const _fwd   = new THREE.Vector3();
const _right  = new THREE.Vector3();
const _flyDelta = new THREE.Vector3();
const _up     = new THREE.Vector3(0, 1, 0);

/**
 * Translate both camera and orbit target by WASD / QE input each frame.
 * Speed scales with camera-to-target distance so movement feels natural at every
 * zoom level. Shift multiplies speed by 5 for rapid traversal.
 *
 * @param {number} dt - seconds since last frame (capped at 50 ms)
 */
function tickFlyKeys(dt) {
  if (!introComplete) return;
  if (!keysDown.has('w') && !keysDown.has('s') &&
      !keysDown.has('a') && !keysDown.has('d') &&
      !keysDown.has('q') && !keysDown.has('e')) return;

  const dist  = camera.position.distanceTo(controls.target);
  const speed = Math.max(5, dist * 0.5) * dt * (keysDown.has('shift') ? 5 : 1);

  // Forward direction projected onto XZ plane (ignore camera tilt)
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  _fwd.normalize();

  _right.crossVectors(_fwd, _up).normalize();

  _flyDelta.set(0, 0, 0);
  if (keysDown.has('w')) _flyDelta.addScaledVector(_fwd,   speed);
  if (keysDown.has('s')) _flyDelta.addScaledVector(_fwd,  -speed);
  if (keysDown.has('a')) _flyDelta.addScaledVector(_right, -speed);
  if (keysDown.has('d')) _flyDelta.addScaledVector(_right,  speed);
  if (keysDown.has('q')) _flyDelta.y -= speed;
  if (keysDown.has('e')) _flyDelta.y += speed;

  camera.position.add(_flyDelta);
  controls.target.add(_flyDelta);
}

// ── Compass gizmo (mini 3D scene, ViewHelper-style) ────────────────────────────────
// A separate scene rendered into a corner viewport, viewed from the same orientation
// as the main camera, so the cardinal markers tilt in true 3D perspective as the
// camera pitches/orbits — exactly like an axis gizmo.
const GIZMO_SIZE = 76;           // CSS px (square)
const GIZMO_MARGIN = 14;         // CSS px from viewport edge
// Footer height — keep in sync with CSS --bottom-h so the gizmo sits above the bar.
const BOTTOM_H = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-h')) || 48;
const gizmoScene  = new THREE.Scene();
const gizmoCamera = new THREE.OrthographicCamera(-1.15, 1.15, 1.15, -1.15, 0.1, 100);

(function buildGizmo() {
  // Minimalist compass needle lying in the XZ plane. GLB north is -Z.
  // Slim diamond: north half red, south half light grey.
  const y = 0;
  const W = 0.12; // half-width at the centre
  const mkHalf = (tipZ) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, y, tipZ,  W, y, 0,  -W, y, 0,
    ]), 3));
    g.computeVertexNormals();
    return g;
  };
  gizmoScene.add(new THREE.Mesh(mkHalf(-0.92), new THREE.MeshBasicMaterial({ color: 0xff4444, side: THREE.DoubleSide })));
  gizmoScene.add(new THREE.Mesh(mkHalf( 0.92), new THREE.MeshBasicMaterial({ color: 0xb8bcc4, side: THREE.DoubleSide })));

  // Centre hub
  gizmoScene.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xe4e7ec })
  ));

  // Single small "N" marker above the north tip.
  const px = 64;
  const c  = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff5a5a';
  ctx.fillText('N', px / 2, px / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const nLabel = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  nLabel.scale.setScalar(0.46);
  nLabel.position.set(0, 0, -1.05);
  gizmoScene.add(nLabel);
})();

/** Render the compass gizmo into the bottom-left corner, matching camera orientation. */
function renderGizmo() {
  // Mirror the main camera orientation EXACTLY by copying its quaternion, then place
  // the gizmo camera back along its own local +Z so it looks at the origin. This avoids
  // the lookAt + up-guess approach, which flipped N/S when viewing straight down.
  gizmoCamera.quaternion.copy(camera.quaternion);
  gizmoCamera.position.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(3);
  gizmoCamera.updateMatrixWorld();

  const dpr = renderer.getPixelRatio();
  const x = GIZMO_MARGIN * dpr;
  const y = (BOTTOM_H + GIZMO_MARGIN) * dpr; // WebGL origin is bottom-left; clear the footer
  const s = GIZMO_SIZE * dpr;

  renderer.setScissorTest(true);
  renderer.setScissor(x, y, s, s);
  renderer.setViewport(x, y, s, s);
  renderer.autoClear = false;
  renderer.clearDepth(); // depth only (scissored) so the gizmo isn't occluded; colour preserved
  renderer.render(gizmoScene, gizmoCamera);
  renderer.autoClear = true;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
}

// ── Render loop ──────────────────────────────────────────────────────────────────
let lastFrameTime = 0;

(function animate(t) {
  requestAnimationFrame(animate);
  stats.begin();

  const dt = Math.min((t - lastFrameTime) / 1000, 0.05);
  lastFrameTime = t;

  tickFlyKeys(dt);

  // Reproject sun world direction to view space each frame (camera may have moved)
  sunUniforms.uSunDirView.value
    .copy(sunDirWorld)
    .transformDirection(camera.matrixWorldInverse);

  controls.update();

  // LOD check once per ~60 frames; skip during intro orbit to avoid racing the first load
  if (++lodFrameCount % 60 === 0 && terrainBBox && introComplete) {
    const target = targetLodUrl();
    if (target !== activeLodUrl) switchLod(target);
  }

  // Tiled-LOD streaming: more frequent than LOD (camera focus moves continuously)
  if (++detailFrameCount % 15 === 0 && introComplete) updateTiles();

  renderer.render(scene, camera);
  renderGizmo();
  stats.end();
}(0));

// ── Modal content ─────────────────────────────────────────────────────────────────
const MODAL_CONTENT = {
  en: `
<p>This viewer renders a Taiwan DTM (Digital Terrain Model) exported as GLB — a
binary glTF 2.0 file built from raw elevation point clouds sampled on a
regular grid.</p>

<h3>From Points to Triangles</h3>
<p>Each source tile stores $(x, y, z)$ triplets: TWD97 Easting, Northing, and
TWVD2001 elevation in metres. Points are snapped to a regular grid with
spacing $s$ (20 m or 40 m). Adjacent grid cells become two triangles each:</p>
<p>$$\\square(i,j)\\;\\to\\;
\\{v_{i,j},\\,v_{i+1,j},\\,v_{i+1,j+1}\\}
\\cup
\\{v_{i,j},\\,v_{i+1,j+1},\\,v_{i,j+1}\\}$$</p>
<p>Cells with at least one no-data corner are skipped, so coastal and boundary
gaps appear as holes rather than incorrect triangles.</p>

<h3>Surface Normals via Central Differences</h3>
<p>Per-vertex normals are estimated from the elevation grid $Z$:</p>
<p>$$\\mathbf{n} = \\operatorname{normalize}\\!\\left(
  -\\frac{\\partial Z}{\\partial x},\\; 1,\\; -\\frac{\\partial Z}{\\partial y}
\\right)$$</p>
<p>with $\\partial Z/\\partial x\\approx(Z_{i,j+1}-Z_{i,j-1})/(2s)$ (central
difference, padded at edges). This provides smooth Phong shading without
computing face normals explicitly.</p>

<h3>Coordinate Mapping: TWD97 → GLB Y-up</h3>
<p>glTF uses a right-hand Y-up coordinate system. The conversion from
TWD97 (EPSG:3826) is:</p>
<p>$$X_{\\text{GLB}} = E - E_0
\\qquad
Y_{\\text{GLB}} = z \\cdot s_z
\\qquad
Z_{\\text{GLB}} = -(N - N_0)$$</p>
<p>where $(E_0,N_0)$ is the point-cloud centroid and $s_z$ is an optional
baked Z-scale factor stored in the file's <code>extras</code>.</p>

<h3>GLB Binary Layout</h3>
<pre><code class="language-js">// 12-byte header: magic = "glTF", version = 2, total_length
// Chunk 0 (JSON): glTF descriptor, padded to 4-byte boundary with 0x20
// Chunk 1 (BIN\0): interleaved buffer
//   [ positions (VEC3 FLOAT) | normals (VEC3 FLOAT) | indices (SCALAR UINT) ]</code></pre>
<p>The mesh is self-contained: one file, no external textures, no streaming
protocol — just structured binary data and a JSON header.</p>
`,
  zhTW: `
<p>本工具將台灣 DTM（數值地形模型）以 GLB 格式渲染。GLB 是 glTF 2.0 二進位格式，
由原始高程點雲在規則格網上採樣後轉換而來。</p>

<h3>從點雲到三角網格</h3>
<p>每個來源圖磁儲存 $(x, y, z)$ 三元組：TWD97 東距、北距，以及
TWVD2001 高程（公尺）。點位吸附到間距 $s$（20 m 或 40 m）的規則格網，
相鄰格網各切為兩個三角形：</p>
<p>$$\\square(i,j)\\;\\to\\;
\\{v_{i,j},\\,v_{i+1,j},\\,v_{i+1,j+1}\\}
\\cup
\\{v_{i,j},\\,v_{i+1,j+1},\\,v_{i,j+1}\\}$$</p>
<p>有任一角為無資料的格網會被略過，海岸線與邊界缺口以「空洞」而非
錯誤三角形呈現。</p>

<h3>中央差分法估算法向量</h3>
<p>使用高程格網 $Z$ 逐頂點估算法向量：</p>
<p>$$\\mathbf{n} = \\operatorname{normalize}\\!\\left(
  -\\frac{\\partial Z}{\\partial x},\\; 1,\\; -\\frac{\\partial Z}{\\partial y}
\\right)$$</p>
<p>其中 $\\partial Z/\\partial x\\approx(Z_{i,j+1}-Z_{i,j-1})/(2s)$
（中央差分，邊界以邊緣值填充）。此方法不需明確計算面法向量即可取得
平滑的 Phong 光照效果。</p>

<h3>座標轉換：TWD97 → GLB Y-up</h3>
<p>glTF 使用右手 Y-up 座標系，從 TWD97（EPSG:3826）的轉換方式：</p>
<p>$$X_{\\text{GLB}} = E - E_0
\\qquad
Y_{\\text{GLB}} = z \\cdot s_z
\\qquad
Z_{\\text{GLB}} = -(N - N_0)$$</p>
<p>其中 $(E_0, N_0)$ 為點雲中心座標，$s_z$ 為烘焙進 <code>extras</code>
的 Z 縮放係數。</p>

<h3>GLB 二進位結構</h3>
<pre><code class="language-js">// 12-byte header：magic = "glTF", version = 2, total_length
// Chunk 0（JSON）：glTF 描述器，以 0x20 補齊至 4-byte 邊界
// Chunk 1（BIN\\0）：交錯式緩衝區
//   [ positions (VEC3 FLOAT) | normals (VEC3 FLOAT) | indices (SCALAR UINT) ]</code></pre>
<p>整個網格自包含於單一檔案中：不需外部貼圖、不需串流協定，
只有結構化二進位資料加上 JSON 描述器。</p>
`,
};

function renderModal() {
  mathContent.innerHTML = MODAL_CONTENT[modalLang];
  renderMathInElement(mathContent, {
    delimiters: [
      { left: '$$', right: '$$', display: true  },
      { left: '$',  right: '$',  display: false },
    ],
    throwOnError: false,
  });
  Prism.highlightAllUnder(mathContent);
}

openMathBtn.addEventListener('click', () => {
  renderModal();
  mathModal.hidden = false;
});
closeMathBtn.addEventListener('click', () => { mathModal.hidden = true; });
mathModal.addEventListener('click', (e) => {
  if (e.target === mathModal) mathModal.hidden = true;
});
langToggle.addEventListener('click', () => {
  modalLang = modalLang === 'en' ? 'zhTW' : 'en';
  renderModal();
});
