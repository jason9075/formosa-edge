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
/** @type {THREE.Mesh|null} */
let terrainMesh = null;
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
  if (!terrainMesh) return;
  toNDC(e);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(terrainMesh);
  if (hits.length > 0) {
    controls.target.copy(hits[0].point);
    controls.update();
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!terrainMesh) return;
  toNDC(e);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(terrainMesh);
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
function applyVertexColors(mesh, mapName) {
  const pos   = mesh.geometry.attributes.position;
  const count = pos.count;
  const buf   = new Float32Array(count * 3);

  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  const fn    = COLOR_MAPS[mapName] ?? COLOR_MAPS.terrain;
  const range = (yMax - yMin) || 1;
  for (let i = 0; i < count; i++) {
    const t    = (pos.getY(i) - yMin) / range;
    const [r, g, b] = fn(Math.max(0, Math.min(1, t)));
    buf[i * 3]     = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }

  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(buf, 3));
  mesh.material.vertexColors = true;
  mesh.material.needsUpdate  = true;

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
  if (terrainMesh) terrainMesh.scale.y = userZScale;
});

wireframeToggle.addEventListener('change', () => {
  if (terrainMesh) terrainMesh.material.wireframe = wireframeToggle.checked;
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
  if (terrainMesh) applyVertexColors(terrainMesh, currentColorMap);
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
  if (lodPending || url === activeLodUrl || !terrainMesh) return;
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

    terrainMesh.geometry = geom;
    applyVertexColors(terrainMesh, currentColorMap);
    geom.computeBoundingBox();
    terrainBBox = geom.boundingBox.clone();

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

      gltf.scene.traverse((node) => {
        if (node.isMesh && !terrainMesh) terrainMesh = node;
      });

      if (!terrainMesh) {
        loadingDetail.textContent = 'Error: no mesh found in GLB.';
        return;
      }

      const mat = new THREE.MeshStandardMaterial({
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.FrontSide,
      });

      // Inject TWD97 grid overlay into the standard material's fragment shader.
      // Grid lines are computed from world-space XZ, which maps 1:1 to TWD97 metres
      // (GLB X = E - xCenter, GLB Z = -(N - yCenter)), so we undo the offset in-shader.
      mat.onBeforeCompile = (shader) => {
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
      mat.customProgramCacheKey = () => 'terrain-grid-v1';

      terrainMesh.material = mat;
      applyVertexColors(terrainMesh, currentColorMap);

      terrainMesh.geometry.computeBoundingBox();
      terrainBBox = terrainMesh.geometry.boundingBox.clone();

      // Seed LOD cache with the initial geometry so the first switchLod is instant
      lodCache.set(GLB_URL, terrainMesh.geometry);
      setLodBadge('100 m');

      scene.add(gltf.scene);

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

  if (terrainMesh && !introComplete) {
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
