import * as THREE from 'three';
import { GLTFLoader }    from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import renderMathInElement from 'katex/dist/contrib/auto-render';
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
const sideViewBtn     = document.getElementById('side-view');
const zScaleSlider    = /** @type {HTMLInputElement}  */ (document.getElementById('z-scale'));
const zScaleValue     = document.getElementById('z-scale-value');
const wireframeToggle  = /** @type {HTMLInputElement}  */ (document.getElementById('wireframe-toggle'));
const gridToggle       = /** @type {HTMLInputElement}  */ (document.getElementById('grid-toggle'));
const gridSpacingRow   = document.getElementById('grid-spacing-row');
const gridSpacingSelect = /** @type {HTMLSelectElement} */ (document.getElementById('grid-spacing'));
const colorMapSelect   = /** @type {HTMLSelectElement} */ (document.getElementById('color-map'));
const boundariesToggle = /** @type {HTMLInputElement} */ (document.getElementById('boundaries-toggle'));
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1e);

const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.08;
controls.zoomToCursor   = true;
controls.screenSpacePanning = false;
controls.enabled = false;  // disabled until terrain loads

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
};

// ── TWD97 Grid shader uniforms ───────────────────────────────────────────────────
// Shared with onBeforeCompile — mutate .value in-place to update without recompile.
const gridUniforms = {
  uGridSpacing: { value: 5000.0 },           // metres between grid lines
  uGridOpacity: { value: 0.0 },              // 0 = hidden
  uGridOffset:  { value: new THREE.Vector2(0, 0) },  // (x_center, y_center) from GLB extras
};

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
let introStartTime = /** @type {number|null} */ (null);
let introComplete = false;
const INTRO_MS = 3000;

// Boundary overlay state
/** @type {THREE.Group|null} */
let boundaryGroup = null;
const BOUNDARY_LIFT = 50; // metres above terrain max (in geometry Y-space)

// LOD state
/** @type {Map<string, THREE.BufferGeometry>} */
const lodCache = new Map();
let activeLodUrl = '/taipei_100m.glb';
let lodPending = false;
let lodFrameCount = 0;

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

function cameraReset() {
  const info = getTerrainInfo();
  if (!info) return;
  const { center, diag } = info;
  controls.target.copy(center);
  // NE of center, looking SW at ~38° elevation angle
  camera.position.set(
    center.x + diag * 0.45,
    center.y + diag * 0.45,
    center.z + diag * 0.45
  );
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

function cameraSide() {
  const info = getTerrainInfo();
  if (!info) return;
  const { center, size } = info;
  controls.target.copy(center);
  camera.position.set(center.x, center.y + size.y * 0.5, center.z + Math.max(size.x, size.z) * 0.8);
  controls.update();
}

resetCameraBtn.addEventListener('click', cameraReset);
topViewBtn.addEventListener('click', cameraTop);
sideViewBtn.addEventListener('click', cameraSide);

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'r' || e.key === 'R') cameraReset();
  if (e.key === 't' || e.key === 'T') cameraTop();
  if (e.key === 'Escape' && !mathModal.hidden) mathModal.hidden = true;
});

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
// Pass 1: find global Y range across all chunks so the colour scale is consistent.
// Pass 2: write per-vertex colour into each chunk geometry.
function applyVertexColors(meshes, mapName) {
  let yMin = Infinity, yMax = -Infinity;
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  const fn    = COLOR_MAPS[mapName] ?? COLOR_MAPS.terrain;
  const range = (yMax - yMin) || 1;

  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const buf = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) - yMin) / range;
      const [r, g, b] = fn(Math.max(0, Math.min(1, t)));
      buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(buf, 3));
  }

  if (terrainMat) {
    terrainMat.vertexColors = true;
    terrainMat.needsUpdate  = true;
  }

  const glbZScale = glbMeta.z_scale ?? 1;
  legendMin.textContent = `${Math.round(yMin / glbZScale)} m`;
  legendMax.textContent = `${Math.round(yMax / glbZScale)} m`;
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
  updateBoundaryY();
});

wireframeToggle.addEventListener('change', () => {
  if (terrainMat) { terrainMat.wireframe = wireframeToggle.checked; terrainMat.needsUpdate = true; }
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
});

// ── LOD levels (altitude thresholds in GLB Y-units = metres at z_scale=1) ────────
// camera.position.y − terrainBBox.min.y gives height above lowest terrain point.
//   > 8000 m above terrain → 100 m mesh (wide overview)
//   3000–8000 m            → 40 m mesh  (regional zoom)
//   < 3000 m               → 20 m mesh  (detail zoom)
const LOD_LEVELS = [
  { url: '/taipei_20m.glb',  label: '20 m',  maxAlt: 3000     },
  { url: '/taipei_40m.glb',  label: '40 m',  maxAlt: 8000     },
  { url: '/taipei_100m.glb', label: '100 m', maxAlt: Infinity },
];
const GLB_URL = '/taipei_100m.glb';

function setLodBadge(text, loading = false) {
  lodBadge.textContent = text;
  lodBadge.dataset.loading = loading ? '1' : '0';
}

function targetLodUrl() {
  if (!terrainBBox) return '/taipei_100m.glb';
  const alt = camera.position.y - terrainBBox.min.y;
  for (const lvl of LOD_LEVELS) {
    if (alt <= lvl.maxAlt) return lvl.url;
  }
  return '/taipei_100m.glb';
}

async function switchLod(url) {
  if (lodPending || url === activeLodUrl || !terrainGroup) return;
  lodPending = true;

  const lvl = LOD_LEVELS.find(l => l.url === url);
  setLodBadge(`↑ ${lvl?.label}…`, true);

  try {
    let geom = lodCache.get(url);
    if (!geom) {
      geom = await new Promise((resolve, reject) => {
        new GLTFLoader().load(
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
    terrainGroup.scale.y = userZScale;
    scene.remove(oldGroup);
    scene.add(terrainGroup);
    applyVertexColors(terrainMeshes, currentColorMap);
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
fetch('/boundaries.json')
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

// ── Load terrain ─────────────────────────────────────────────────────────────────
const loader = new GLTFLoader();

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

        // Inject grid uniforms + calculation into fragment shader
        shader.fragmentShader = [
          'varying vec3 vWorldPos;',
          'uniform float uGridSpacing;',
          'uniform float uGridOpacity;',
          'uniform vec2  uGridOffset;',
          shader.fragmentShader,
        ].join('\n');

        // Append grid overlay just before the final dithering step
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `{
  // Reconstruct TWD97 XY from GLB XZ (X=E-xc, Z=-(N-yc))
  vec2 twd97 = vec2(vWorldPos.x + uGridOffset.x, -vWorldPos.z + uGridOffset.y);
  // Distance to nearest grid line in each axis
  vec2 gmod = mod(twd97, uGridSpacing);
  float d = min(min(gmod.x, uGridSpacing - gmod.x),
                min(gmod.y, uGridSpacing - gmod.y));
  float lineW = uGridSpacing * 0.004;  // line width = 0.4% of spacing
  float ga = (1.0 - smoothstep(0.0, lineW, d)) * uGridOpacity;
  // White-ish grid line over terrain colour
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.95, 0.95, 1.0), ga);
}
#include <dithering_fragment>`
        );

        // Bind the shared uniform objects so mutations propagate each frame
        Object.assign(shader.uniforms, gridUniforms);
      };

      // Unique cache key prevents Three.js merging this with an unmodified material
      terrainMat.customProgramCacheKey = () => 'terrain-grid-v1';

      // Split into 8×8 chunks; each has its own bounding sphere for frustum culling
      const fullGeom = firstMesh.geometry;
      lodCache.set(GLB_URL, fullGeom);
      buildTerrainGroup(fullGeom);
      applyVertexColors(terrainMeshes, currentColorMap);
      if (userZScale !== 1) terrainGroup.scale.y = userZScale;

      scene.add(terrainGroup);
      updateBoundaryY();
      setLodBadge('100 m');

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

// ── Intro orbit animation ────────────────────────────────────────────────────────
function tickIntro(t) {
  const info = getTerrainInfo();
  if (!info) return;

  if (introStartTime === null) {
    introStartTime = t;
    controls.enabled = false;
  }

  const progress = Math.min((t - introStartTime) / INTRO_MS, 1);
  const { center, diag } = info;

  // Start facing NE, sweep 90° CCW
  const angle = -Math.PI * 0.25 + progress * Math.PI * 0.5;
  camera.position.set(
    center.x + Math.sin(angle) * diag * 0.55,
    center.y + diag * 0.44,
    center.z + Math.cos(angle) * diag * 0.55
  );
  camera.lookAt(center);
  controls.target.copy(center);

  if (progress >= 1) {
    introComplete = true;
    controls.enabled = true;
    controls.update();
  }
}

// ── Render loop ──────────────────────────────────────────────────────────────────
(function animate(t) {
  requestAnimationFrame(animate);

  if (terrainGroup && !introComplete) {
    tickIntro(t);
  }

  controls.update();

  // LOD check once per ~60 frames; skip during intro orbit to avoid racing the first load
  if (++lodFrameCount % 60 === 0 && terrainBBox && introComplete) {
    const target = targetLodUrl();
    if (target !== activeLodUrl) switchLod(target);
  }

  renderer.render(scene, camera);
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
