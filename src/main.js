import * as THREE from 'three';
import { GLTFLoader }    from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 }                from 'three/examples/jsm/lines/Line2.js';
import { LineSegments2 }        from 'three/examples/jsm/lines/LineSegments2.js';
import { LineGeometry }         from 'three/examples/jsm/lines/LineGeometry.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial }         from 'three/examples/jsm/lines/LineMaterial.js';
import { RGBELoader }          from 'three/examples/jsm/loaders/RGBELoader.js';
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
const timeSlider      = /** @type {HTMLInputElement}  */ (document.getElementById('time-of-day'));
const timeValue       = document.getElementById('time-value');
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
const shaderToggle         = /** @type {HTMLInputElement} */ (document.getElementById('shader-toggle'));
const buildingsToggle      = /** @type {HTMLInputElement} */ (document.getElementById('buildings-toggle'));
const riversToggle         = /** @type {HTMLInputElement} */ (document.getElementById('rivers-toggle'));
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
const debugToggleBtn  = document.getElementById('debug-toggle');
const measureToggleBtn = document.getElementById('measure-toggle');
const measureReadout   = document.getElementById('measure-readout');
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
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ── HDR skybox ───────────────────────────────────────────────────────────────
// Loaded once; applied as scene.background in Edge theme via applyTheme.
// Kept as equirectangular mapping (not PMREM) — we only want it as a backdrop,
// not as IBL, so the existing dirLight + hemisphere keep full control of shading.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
/** @type {THREE.Texture|null} */
let hdrBackground = null;
new RGBELoader().load(import.meta.env.BASE_URL + 'env/sky_1k.hdr', (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  hdrBackground = tex;
  pmrem.dispose();
  if (currentColorMap === 'edge') scene.background = hdrBackground;
});

// Draggable debug HUD (MS / MB / three.js render-info). Hidden until the Debug button.
const stats = createStats();
document.body.appendChild(stats.dom);
debugToggleBtn.addEventListener('click', () => {
  stats.setVisible(!stats.visible);
  debugToggleBtn.setAttribute('aria-pressed', String(stats.visible));
  debugToggleBtn.classList.toggle('active', stats.visible);
});
renderer.setPixelRatio(window.devicePixelRatio);

// CSS2D overlay for billboarded region-name labels (admin boundaries). Renders crisp
// DOM text positioned at projected 3D points — layered above the canvas, below the UI
// (z-index < the panel/bars), and click-through so it never intercepts pointer events.
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.id = 'label-layer';
labelRenderer.domElement.style.cssText =
  'position:fixed;top:0;left:0;pointer-events:none;z-index:5';
document.body.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
// Two looks, switched by colour map (see applyTheme): the default dark backdrop, and the
// Mirror's Edge bright cool-white sky where distant geometry fades into fog.
const DARK_BG   = new THREE.Color(0x1a1a1e);
const SKY_COLOR = new THREE.Color(0x8ec5ee); // current sky (also fog/horizon); set by setSunFromHour
const SKY_DAY   = new THREE.Color(0x8ec5ee); // midday blue
const SKY_DUSK  = new THREE.Color(0x3a3550); // dim, slightly warm-purple at dawn/dusk
// Linear fog for the ME hazy horizon. near/far are retuned per-frame by altitude: tight
// at city scale (atmospheric haze), pushed far at island overview (stays clear).
const meFog = new THREE.Fog(SKY_COLOR, 8000, 50000);
scene.background = DARK_BG;

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

// ── Lighting (sun direction driven by the time-of-day slider; X=East, Y=Up, Z=South) ──
// Warm-white key sun + a hemisphere fill (cool-white sky, muted blue ground) so lit
// faces read near-white while shadowed/downward faces pick up the blue ambient —
// the Mirror's Edge "white clay + blue shadow" look.
const dirLight = new THREE.DirectionalLight(0xfff5e8, 1.8);
dirLight.position.set(-1, 1.2, -1);
const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x6f8fb5, 0.9);
scene.add(dirLight);
scene.add(hemi);


// ── Sun disc + halo sprites (Edge theme only) ────────────────────────────────
// Two-layer sprite stack: tight bright disc + wide soft halo. Both use canvas
// radial-gradient textures and additive blending so they glow against the sky.
// Positioned at camera + sunDirWorld * SUN_DIST each frame → tracks the camera
// like a skydome element. Hidden when below the horizon or outside Edge theme.
/**
 * @param {string} inner  CSS color for gradient center stop
 * @param {string} outer  CSS color for gradient edge stop
 * @returns {THREE.CanvasTexture}
 */
function makeSunTex(inner, outer) {
  const sz = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = sz;
  const ctx = cv.getContext('2d');
  const h = sz / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0,    inner);
  g.addColorStop(0.18, inner);
  g.addColorStop(0.42, outer);
  g.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, sz, sz);
  return new THREE.CanvasTexture(cv);
}

const SUN_DIST = 500000; // world metres — beyond all terrain

const sunDiscMat = new THREE.SpriteMaterial({
  map: makeSunTex('rgba(255,255,220,1)', 'rgba(255,200,80,0.55)'),
  transparent: true,
  depthWrite:  false,
  blending:    THREE.AdditiveBlending,
});
const sunDisc = new THREE.Sprite(sunDiscMat);
sunDisc.scale.setScalar(16000);
sunDisc.visible = false;
scene.add(sunDisc);

const sunHaloMat = new THREE.SpriteMaterial({
  map: makeSunTex('rgba(255,160,50,0.30)', 'rgba(255,80,10,0)'),
  transparent: true,
  depthWrite:  false,
  blending:    THREE.AdditiveBlending,
});
const sunHalo = new THREE.Sprite(sunHaloMat);
sunHalo.scale.setScalar(55000);
sunHalo.visible = false;
scene.add(sunHalo);

// Shadows: the directional light + its orthographic shadow camera FOLLOW the orbit
// target each frame, sized to the building view (a few km) — full-island shadow maps
// would be useless resolution. SHADOW_DIST is how far back the light sits.
const SHADOW_R    = 3000;   // half-extent of the shadow frustum (world m)
const SHADOW_DIST = 12000;  // light distance from target along the sun direction
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 100;
dirLight.shadow.camera.far  = SHADOW_DIST * 2;
dirLight.shadow.camera.left   = -SHADOW_R;
dirLight.shadow.camera.right  =  SHADOW_R;
dirLight.shadow.camera.top    =  SHADOW_R;
dirLight.shadow.camera.bottom = -SHADOW_R;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight.target);

// ── Elevation color maps ─────────────────────────────────────────────────────────
/** @type {Record<string, (t: number) => [number,number,number]>} */
const COLOR_MAPS = {
  // Mirror's Edge look: a clean near-white surface (faint cool tint low → pure white
  // high). Form comes from hillshade + cast shadows, not the palette — keeps terrain
  // and the white building massing cohesively bright.
  'edge': (t) => {
    const stops = [
      [0.00, 0.70, 0.80, 0.92],
      [0.45, 0.86, 0.91, 0.97],
      [1.00, 1.00, 1.00, 1.00],
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
    return [1, 1, 1];
  },
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
  uHillshade:   { value: 0.0 },
  uSunDirView:  { value: new THREE.Vector3() },
  uShadowColor: { value: new THREE.Vector3(0.25, 0.25, 0.25) }, // neutral until Edge theme
};
// World-space sun direction; matches dirLight.position by default (NW sun at 45°)
let sunDirWorld = new THREE.Vector3(-1, 1.2, -1).normalize();

// ── Measure / bounding-box highlight uniforms ────────────────────────────────────
// Injected into buildingMat (see onBeforeCompile below). Bounds are world-space XZ
// (GLB X = E - xCenter, GLB Z = -(N - yCenter)); fragments inside tint red. Mutate
// .value in-place — no recompile, no per-frame work while the box is static.
const measureUniforms = {
  uMeasureActive: { value: 0.0 },                    // 0 = off, 1 = highlight
  uMeasureMin:    { value: new THREE.Vector2(0, 0) }, // (minX, minZ) world metres
  uMeasureMax:    { value: new THREE.Vector2(0, 0) }, // (maxX, maxZ) world metres
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
let currentColorMap = 'edge';
let panelOpen = window.innerWidth >= 1280;
let modalLang = 'en';
let hintTimer = null;
let introComplete = false;

// Boundary overlay state
/** @type {THREE.Group|null} */
let boundaryGroup = null;
const BOUNDARY_LIFT = 50; // small lift above the draped terrain surface (clears z-fighting; sits above roads' 20 m)

// Region-name labels (CSS2D pins). Built from boundaries.json names; gated by view
// distance + frustum + a nearest-N cap so labels emerge near what you're looking at
// instead of plastering all 379 districts at once.
/** @type {THREE.Group|null} */
let labelGroup = null;
/** @type {THREE.Group|null} */
let poleGroup = null; // child of labelGroup; one downward unit-pole per label, scaled to the floor
/** @type {Array<{obj: CSS2DObject, el: HTMLElement, pole: THREE.Line, wx: number, wz: number, d2: number}>} */
const regionLabels = [];
// Labels show at ALL altitudes (incl. low-level flight). The look-around radius scales
// with view distance so density stays sensible: a tight cluster of names up close, a
// broad sweep when zoomed out. Nearest-to-target + frustum still cap how many appear.
const LABEL_RADIUS_MIN =  4000; // radius floor (low altitude → only the nearest districts)
const LABEL_RADIUS_MAX = 60000; // radius ceiling (high altitude → broad labelling)
const LABEL_RADIUS_K   =   1.4; // radius ≈ view distance × this, clamped to the band above
const LABEL_MAX_COUNT  =    16; // cap simultaneous labels (nearest-to-target win)
const LABEL_HEIGHT_FRAC =  0.85; // name rides at this fraction of camera altitude above the floor
const _labelFrustum = new THREE.Frustum();
const _labelProjM   = new THREE.Matrix4();
const _labelPt      = new THREE.Vector3();
const _camDir       = new THREE.Vector3();

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

// ── Building streaming (white massing + box LOD) ───────────────────────────────────
// Two representations per 5 km tile (same keys/cx/cz): massing (source geometry) and
// box (per-building AABB). Altitude gates visibility; per-tile distance picks the LOD.
const BUILDING_FAR    = 12000; // alt (m above terrain) above this → unload all buildings
const BUILDING_DETAIL = 4000;  // tile within this of camera → massing, else box
const buildingGroup = new THREE.Group();
// Rivers: flat blue water-surface tiles (river_tiles/), streamed by updateRivers().
// Single representation (no LOD) — water is flat, far cheaper than buildings.
const RIVER_FAR = 80000; // alt (m above terrain) above this → unload all river tiles
const riverGroup = new THREE.Group();
/** @type {{tileSize:number, tiles:{key:string,cx:number,cz:number}[]}|null} */
let riverIndex = null;
/** @type {Map<string, THREE.Mesh>} */ const riverTiles = new Map();
const riverLoading = new Set();
// Mirror's Edge water — light blue, slight sheen; receives building/terrain shadows.
const riverMat = new THREE.MeshStandardMaterial({
  color: 0x4a90d9, roughness: 0.25, metalness: 0.0, side: THREE.DoubleSide,
});
/** @type {{tileSize:number, tiles:{key:string,cx:number,cz:number}[]}|null} */
let buildingIndex = null;
/** @type {Map<string, THREE.Mesh>} */ const buildingMassing = new Map();
/** @type {Map<string, THREE.Mesh>} */ const buildingBoxes   = new Map();
const massingLoading = new Set();
const boxLoading     = new Set();
let buildingFrameCount = 0;
// Plain white material — the existing directional light gives clean faceted shading
// (Mirror's Edge look); no TWD97 grid overlay (unlike terrainMat).
// FrontSide (not DoubleSide): adjacent buildings share wall planes back-to-back; with
// double-sided faces both render at the same depth → z-fighting. Back-face culling shows
// only the outward face. Winding is outward for both box and massing geometry.
const buildingMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.92, metalness: 0.0, side: THREE.FrontSide,
});
// Inject a world-space bbox highlight: fragments whose XZ falls inside the measured
// box are tinted red. Per-fragment (≈ per-building) across every tile from one shared
// material — no per-mesh material swapping or geometry splitting needed.
buildingMat.onBeforeCompile = (shader) => {
  shader.vertexShader = 'varying vec3 vWorldPosB;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\nvWorldPosB = (modelMatrix * vec4(transformed, 1.0)).xyz;'
  );
  shader.fragmentShader = [
    'varying vec3 vWorldPosB;',
    'uniform float uMeasureActive;',
    'uniform vec2  uMeasureMin;',
    'uniform vec2  uMeasureMax;',
    shader.fragmentShader,
  ].join('\n');
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    `{
  if (uMeasureActive > 0.5 &&
      vWorldPosB.x >= uMeasureMin.x && vWorldPosB.x <= uMeasureMax.x &&
      vWorldPosB.z >= uMeasureMin.y && vWorldPosB.z <= uMeasureMax.y) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.90, 0.12, 0.10), 0.78);
  }
}
#include <dithering_fragment>`
  );
  Object.assign(shader.uniforms, measureUniforms);
};
buildingMat.customProgramCacheKey = () => 'building-measure-v1';

// ── Panel toggle ─────────────────────────────────────────────────────────────────
function setPanelOpen(open) {
  panelOpen = open;
  controlPanel.dataset.open = open ? '1' : '0';
  panelToggleBtn.textContent = open ? '›' : '‹'; // › collapse (panel slides right) / ‹ expand
  panelToggleBtn.setAttribute('aria-expanded', String(open));
}
setPanelOpen(panelOpen);
panelToggleBtn.addEventListener('click', () => setPanelOpen(!panelOpen));

// ── Resize ───────────────────────────────────────────────────────────────────────
// Fat-line (Line2/LineSegments2) materials need the viewport resolution to size
// their pixel-space linewidth; keep a registry so resize() refreshes them all.
/** @type {LineMaterial[]} */
const fatLineMaterials = [];
function makeFatLineMaterial(color, linewidth, opacity) {
  const m = new LineMaterial({ color, linewidth, transparent: true, opacity });
  m.resolution.set(window.innerWidth, window.innerHeight);
  fatLineMaterials.push(m);
  return m;
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  for (const m of fatLineMaterials) m.resolution.set(window.innerWidth, window.innerHeight);
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
  camera.position.set(taipeiX, floorY + 4000, taipeiZ + 8000);
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
  // Only swallow keys while typing in a TEXT field. Checkboxes / sliders / selects keep
  // focus after a click, but must not block WASD/QE flight — they take no text input.
  const t = e.target;
  if (t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLInputElement &&
       /^(text|search|email|number|password|url|tel)$/.test(t.type))) return;
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
  // Grab cursor + outline when hovering a draggable marker (skip mid-drag — that's 'grabbing').
  if (measureState === 'active' && !draggingMarker) {
    const hovered = raycaster.intersectObjects(measureGroup.children, false)[0]?.object ?? null;
    canvas.style.cursor = hovered ? 'grab' : '';
    for (const mk of measureGroup.children) mk.userData.outline.visible = (mk === hovered);
  }
  nudgeHint();
});

// ── Bounding-box measure tool ──────────────────────────────────────────────────────
// State: 'idle' → 'first' (placing pt 1) → 'second' (placing pt 2) → 'active' (box shown,
// buildings highlighted). The measure button advances idle→first and, from any other
// state, cancels back to idle. Markers are picked by raycasting the terrain (same as the
// coordinate HUD), so the points carry world-space metres directly.

/**
 * Inverse Transverse-Mercator (TWD97 / TM2 → WGS84). Main-island zone only:
 * central meridian 121°E, k0 = 0.9999, false easting 250 000 m, GRS80 ellipsoid.
 * Outlying islands (119°E zone) are excluded from this map, so 121° is always correct.
 * @param {number} E TWD97 easting (m) @param {number} N TWD97 northing (m)
 * @returns {{lat:number, lon:number}} degrees
 */
function twd97ToWgs84(E, N) {
  const a = 6378137.0, f = 1 / 298.257222101;
  const k0 = 0.9999, lon0 = 121 * Math.PI / 180, FE = 250000, FN = 0;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const M = (N - FN) / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const fp = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinf = Math.sin(fp), cosf = Math.cos(fp), tanf = Math.tan(fp);
  const C1 = ep2 * cosf * cosf;
  const T1 = tanf * tanf;
  const N1 = a / Math.sqrt(1 - e2 * sinf * sinf);
  const R1 = a * (1 - e2) / (1 - e2 * sinf * sinf) ** 1.5;
  const D = (E - FE) / (N1 * k0);
  const lat = fp - (N1 * tanf / R1) * (D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D
    - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / cosf;
  return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI };
}

/** @type {'idle'|'first'|'second'|'active'} */
let measureState = 'idle';
/** @type {THREE.Vector3[]} world-space picked points */
const measurePoints = [];
const measureGroup = new THREE.Group();
scene.add(measureGroup);
// Bright-yellow square pyramid — strong emissive so it stays vivid in any lighting.
const markerMat = new THREE.MeshStandardMaterial({
  color: 0xffee00, metalness: 0.2, roughness: 0.4,
  emissive: 0xffd400, emissiveIntensity: 0.45,
});
// Unit pyramid (apex at the local origin, pointing down; base rises +Y). Shared across
// markers; per-frame scaling in the animate loop keeps a near-constant on-screen size.
const markerGeom = new THREE.ConeGeometry(0.45, 1, 4);
markerGeom.rotateX(Math.PI);     // apex points down (−Y)
markerGeom.translate(0, 0.5, 0); // apex at origin → marker grows upward from the picked point

// Hover outline: a crisp fat-line edge cage. Constant pixel width at any zoom (screen-space
// linewidth) and uniform thickness — unlike the inverted-hull, which thinned toward the apex.
// Self-contained: no post-processing pass to disturb the stencil / log-depth / gizmo setup.
const markerEdges = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(markerGeom));
const outlineMat = makeFatLineMaterial(0xffffff, 2.5, 1.0);
outlineMat.depthTest = false; // draw the cage on top as a selection highlight

/** Build a yellow pyramid marker anchored at a world-space point (spins + floats in animate). */
function makeMarker(point) {
  const m = new THREE.Mesh(markerGeom, markerMat);
  m.position.copy(point);
  const outline = new LineSegments2(markerEdges, outlineMat); // child → inherits scale/rotation/float
  outline.visible = false;     // shown only while hovered/dragged
  outline.renderOrder = 5;     // over the marker + scene
  m.add(outline);
  m.userData.outline = outline;
  return m;
}

function fmtLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${ns} ${Math.abs(lon).toFixed(5)}°${ew}`;
}

function setMeasureReadout(text) {
  if (text == null) { measureReadout.hidden = true; measureReadout.textContent = ''; }
  else { measureReadout.textContent = text; measureReadout.hidden = false; }
}

/** Compute the bbox from the two picked points; update the shader highlight + header. */
function finishMeasure() {
  const [p1, p2] = measurePoints;
  const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x);
  const minZ = Math.min(p1.z, p2.z), maxZ = Math.max(p1.z, p2.z);

  // Drive the building highlight (world-space XZ).
  measureUniforms.uMeasureMin.value.set(minX, minZ);
  measureUniforms.uMeasureMax.value.set(maxX, maxZ);
  measureUniforms.uMeasureActive.value = 1.0;

  // World XZ → TWD97 (E = x + xCenter, N = -z + yCenter) → WGS84.
  const xC = glbMeta.x_center ?? 0, yC = glbMeta.y_center ?? 0;
  const Emin = minX + xC, Emax = maxX + xC;
  const Nmin = -maxZ + yC, Nmax = -minZ + yC; // -z, so min z → max N
  const sw = twd97ToWgs84(Emin, Nmin); // south-west corner (min lat, min lon)
  const ne = twd97ToWgs84(Emax, Nmax); // north-east corner (max lat, max lon)
  const wKm = ((Emax - Emin) / 1000).toFixed(2);
  const hKm = ((Nmax - Nmin) / 1000).toFixed(2);
  setMeasureReadout(`SW ${fmtLatLon(sw.lat, sw.lon)}  ·  NE ${fmtLatLon(ne.lat, ne.lon)}  ·  ${wKm}×${hKm} km`);
}

/** Reset the tool to idle: drop markers, clear highlight, hide the readout. */
function clearMeasure() {
  measureState = 'idle';
  measurePoints.length = 0;
  // Markers share markerGeom (reused for the lifetime of the page) — remove only.
  for (const c of [...measureGroup.children]) measureGroup.remove(c);
  // Restore interaction state in case the tool was cancelled mid-drag.
  draggingMarker = null;
  controls.enabled = true;
  canvas.style.cursor = '';
  measureUniforms.uMeasureActive.value = 0.0;
  setMeasureReadout(null);
  measureToggleBtn.classList.remove('active');
  measureToggleBtn.setAttribute('aria-pressed', 'false');
}

measureToggleBtn.addEventListener('click', () => {
  if (measureState === 'idle') {
    measureState = 'first';
    measureToggleBtn.classList.add('active');
    measureToggleBtn.setAttribute('aria-pressed', 'true');
    setMeasureReadout('Click the terrain to set point 1 of 2');
  } else {
    clearMeasure(); // any active state → cancel everything
  }
});

// Distinguish a genuine click from a pan-drag: track the pointer-down position and
// ignore the click if it moved more than a few pixels (OrbitControls fires a click
// at the end of a left-drag pan).
let measureDownX = 0, measureDownY = 0;
/** @type {THREE.Mesh|null} marker currently being dragged */
let draggingMarker = null;

canvas.addEventListener('pointerdown', (e) => {
  measureDownX = e.clientX;
  measureDownY = e.clientY;
  // Grab a marker to drag it horizontally across the terrain (active state only).
  if (measureState === 'active' && measureGroup.children.length > 0) {
    toNDC(e);
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObjects(measureGroup.children, false)[0];
    if (hit) {
      draggingMarker = hit.object;
      draggingMarker.userData.outline.visible = true;
      controls.enabled = false; // suppress OrbitControls pan while dragging
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!draggingMarker) return;
  if (terrainMeshes.length === 0) return;
  toNDC(e);
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObjects(terrainMeshes)[0];
  if (!hit) return;
  draggingMarker.userData.point.copy(hit.point); // mutates the measurePoints entry too
  finishMeasure(); // live bbox / readout / highlight update (animate re-applies float/spin)
});

function endMarkerDrag(e) {
  if (!draggingMarker) return;
  draggingMarker = null;
  controls.enabled = true;
  canvas.style.cursor = '';
  if (e) { try { canvas.releasePointerCapture(e.pointerId); } catch { /* already lost */ } }
}
canvas.addEventListener('pointerup', endMarkerDrag);
canvas.addEventListener('pointercancel', endMarkerDrag);

canvas.addEventListener('click', (e) => {
  if (measureState !== 'first' && measureState !== 'second') return;
  if (Math.hypot(e.clientX - measureDownX, e.clientY - measureDownY) > 5) return;
  if (terrainMeshes.length === 0) return;
  toNDC(e);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(terrainMeshes);
  if (hits.length === 0) return;

  const pt = hits[0].point.clone();
  measurePoints.push(pt);
  const marker = makeMarker(pt);
  marker.userData.point = pt; // same Vector3 as in measurePoints — drag mutates both
  measureGroup.add(marker);

  if (measureState === 'first') {
    measureState = 'second';
    setMeasureReadout('Click the terrain to set point 2 of 2');
  } else {
    measureState = 'active';
    finishMeasure();
  }
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
  buildingGroup.scale.y = userZScale;
  riverGroup.scale.y = userZScale;
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
  applyTheme(currentColorMap);
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
      m.receiveShadow = true; // catch building shadows cast onto the terrain
      m.userData.cx = tile.cx;
      m.userData.cz = tile.cz;
      // Dispose the 100 m tile BEFORE adding the 20 m tile to avoid one-frame Z-fighting.
      // Keeping 100 m visible while 20 m loaded prevents the black gap that would occur if
      // 100 m were disposed eagerly (before the async load finished).
      if (isDetail && baseTiles.has(tile.key)) disposeTile(baseTiles, baseTileGroup, tile.key);
      group.add(m);
      map.set(tile.key, m);
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

// ── Building streaming ─────────────────────────────────────────────────────────────
/** @param {Map<string,THREE.Mesh>} map @param {string} key */
function disposeBuilding(map, key) {
  const m = map.get(key);
  if (!m) return;
  buildingGroup.remove(m);
  m.geometry.dispose();
  map.delete(key);
}

/**
 * Load one building tile at the given LOD. 'massing' = source geometry, 'box' = AABB.
 * @param {{key:string,cx:number,cz:number}} tile @param {'massing'|'box'} lod
 */
function loadBuilding(tile, lod) {
  const isMassing = lod === 'massing';
  const map     = isMassing ? buildingMassing : buildingBoxes;
  const loading = isMassing ? massingLoading  : boxLoading;
  const dir     = isMassing ? 'building_tiles' : 'building_boxes';
  loading.add(tile.key);
  loader.load(
    `${import.meta.env.BASE_URL}${dir}/${tile.key}.glb`,
    (gltf) => {
      loading.delete(tile.key);
      let mesh = null;
      gltf.scene.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
      if (!mesh) return;
      const m = new THREE.Mesh(mesh.geometry, buildingMat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.cx = tile.cx;
      m.userData.cz = tile.cz;
      buildingGroup.add(m);
      map.set(tile.key, m);
      // Drop the other LOD only now that this one is on screen — never leave a gap
      // where the tile has neither (the "disappears while panning" bug).
      if (isMassing) disposeBuilding(buildingBoxes, tile.key);
      else           disposeBuilding(buildingMassing, tile.key);
    },
    undefined,
    () => { loading.delete(tile.key); },
  );
}

/**
 * Stream building tiles. Altitude gates visibility (far → all unloaded); per-tile
 * camera distance picks the LOD: near → massing, else → box (the "simple squares").
 */
function updateBuildings() {
  if (!buildingIndex || !terrainBBox) return;

  const alt = camera.position.y - terrainBBox.min.y;
  // Hidden via the Buildings toggle, or too high: unload everything and stop streaming.
  if (!buildingsToggle.checked || alt > BUILDING_FAR) {
    for (const k of [...buildingMassing.keys()]) disposeBuilding(buildingMassing, k);
    for (const k of [...buildingBoxes.keys()])   disposeBuilding(buildingBoxes, k);
    return;
  }

  const cxw = camera.position.x;
  const czw = camera.position.z;
  _detProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _detFrustum.setFromProjectionMatrix(_detProj);

  const sy = buildingGroup.scale.y;
  const midY = (terrainBBox.min.y + terrainBBox.max.y) * 0.5 * sy;
  const tileR = (buildingIndex.tileSize ?? 5000) * 0.75;

  const visibleKeys = new Set();
  for (const t of buildingIndex.tiles) {
    _detSphere.center.set(t.cx, midY, t.cz);
    _detSphere.radius = tileR;
    if (!_detFrustum.intersectsSphere(_detSphere)) continue;
    visibleKeys.add(t.key);

    // LOD with hysteresis: keep an existing massing tile until clearly past the
    // threshold so panning across the boundary doesn't thrash. The opposite LOD is
    // disposed in loadBuilding's callback (after the new one is on screen), not here.
    const d = Math.hypot(t.cx - cxw, t.cz - czw);
    const hasMassing = buildingMassing.has(t.key);
    const wantMassing = d < BUILDING_DETAIL || (hasMassing && d < BUILDING_DETAIL + LOD_HYST);
    if (wantMassing) {
      if (!hasMassing && !massingLoading.has(t.key)) loadBuilding(t, 'massing');
    } else {
      if (!buildingBoxes.has(t.key) && !boxLoading.has(t.key)) loadBuilding(t, 'box');
    }
  }

  // Evict tiles that left the frustum.
  for (const k of [...buildingMassing.keys()]) if (!visibleKeys.has(k)) disposeBuilding(buildingMassing, k);
  for (const k of [...buildingBoxes.keys()])   if (!visibleKeys.has(k)) disposeBuilding(buildingBoxes, k);
}

// ── River streaming ────────────────────────────────────────────────────────────────
function disposeRiver(key) {
  const m = riverTiles.get(key);
  if (!m) return;
  riverGroup.remove(m);
  m.geometry.dispose();
  riverTiles.delete(key);
}

/** @param {{key:string,cx:number,cz:number}} tile */
function loadRiver(tile) {
  riverLoading.add(tile.key);
  loader.load(
    `${import.meta.env.BASE_URL}river_tiles/${tile.key}.glb`,
    (gltf) => {
      riverLoading.delete(tile.key);
      let mesh = null;
      gltf.scene.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
      if (!mesh) return;
      const m = new THREE.Mesh(mesh.geometry, riverMat);
      m.receiveShadow = true; // water catches building/terrain shadows
      riverGroup.add(m);
      riverTiles.set(tile.key, m);
    },
    undefined,
    () => { riverLoading.delete(tile.key); },
  );
}

/** Stream flat water tiles — frustum-culled, altitude-gated. Single LOD. */
function updateRivers() {
  if (!riverIndex || !terrainBBox) return;

  const alt = camera.position.y - terrainBBox.min.y;
  if (!riversToggle.checked || alt > RIVER_FAR) {
    for (const k of [...riverTiles.keys()]) disposeRiver(k);
    return;
  }

  _detProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _detFrustum.setFromProjectionMatrix(_detProj);

  const sy = riverGroup.scale.y;
  const midY = (terrainBBox.min.y + terrainBBox.max.y) * 0.5 * sy;
  const tileR = (riverIndex.tileSize ?? 5000) * 0.75;

  const visibleKeys = new Set();
  for (const t of riverIndex.tiles) {
    _detSphere.center.set(t.cx, midY, t.cz);
    _detSphere.radius = tileR;
    if (!_detFrustum.intersectsSphere(_detSphere)) continue;
    visibleKeys.add(t.key);
    if (!riverTiles.has(t.key) && !riverLoading.has(t.key)) loadRiver(t);
  }

  for (const k of [...riverTiles.keys()]) if (!visibleKeys.has(k)) disposeRiver(k);
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

// ── Sun position (time-of-day) ─────────────────────────────────────────────────────
/**
 * Set the world sun direction from a clock hour. Daylight arc 6→18: sun rises in the
 * east, peaks high in the southern sky at noon, sets in the west. Outside that it sits
 * just below the horizon (dim). Also fades light intensity near dawn/dusk.
 * GLB axes: X=East, Y=Up, Z=South.
 * @param {number} hour 0–24
 */
function setSunFromHour(hour) {
  const dayFrac = (hour - 6) / 12;          // 0 at 06:00 → 1 at 18:00
  const a = dayFrac * Math.PI;              // 0 → π across the day
  const el = Math.sin(a);                   // elevation factor: 0 horizon → 1 noon
  const east = Math.cos(a);                 // +1 east (AM) → −1 west (PM)
  const up = Math.max(0.04, el);            // keep just above horizon for grazing light
  const south = 0.35 * el + 0.15;           // sun biased into the southern sky (Taiwan)
  sunDirWorld.set(east, up, south).normalize();

  // Dim toward dawn/dusk; keep a soft blue fill at all times.
  const day = Math.max(0, el);
  dirLight.intensity = 0.25 + 2.0 * day;
  hemi.intensity     = 0.55 + 0.45 * day;

  // Sky + fog brightness follows the sun: midday blue → dim warm-purple at dawn/dusk.
  // Mutating SKY_COLOR in place updates the live background (set by reference in the
  // Edge theme); fog.color is a separate copy, so update both. No effect on other themes.
  SKY_COLOR.copy(SKY_DUSK).lerp(SKY_DAY, day);
  meFog.color.copy(SKY_COLOR);

  // HDR background brightness: noon = full (1.0), horizon = dim (0.10), night = near-black (0.03).
  // scene.backgroundIntensity only affects the background texture, not geometry lighting.
  scene.backgroundIntensity = el <= 0 ? 0.03 : (0.10 + 0.90 * day);

  // Sun disc: colour orange at horizon → near-white at noon; halo stronger at dawn/dusk.
  const edgeActive = scene.fog !== null;
  const aboveHorizon = el > -0.05; // small margin so disc lingers just as sun sets
  sunDisc.visible = edgeActive && aboveHorizon;
  sunHalo.visible = sunDisc.visible;
  if (sunDisc.visible) {
    sunDiscMat.color.setRGB(1, 0.68 + 0.32 * day, 0.28 + 0.62 * day);
    sunHaloMat.color.setRGB(1, 0.48 + 0.30 * day, 0.08 + 0.30 * day);
    sunHaloMat.opacity = 0.85 - 0.55 * day;  // halo strongest at dawn/dusk
  }
}

/**
 * Apply the scene look for a colour map. Only 'mirrors-edge' gets the bright white sky
 * + fog + blue hemisphere fill; every other map keeps the original dark backdrop, no
 * fog, and a neutral dark ambient.
 * @param {string} map
 */
function applyTheme(map) {
  const me = map === 'edge';
  // Edge theme: use HDR skybox if loaded, fall back to SKY_COLOR until it arrives.
  scene.background = me ? (hdrBackground ?? SKY_COLOR) : DARK_BG;
  scene.fog = me ? meFog : null;
  // Re-evaluate sun visibility when theme changes (setSunFromHour checks scene.fog).
  const sunAbove = sunDirWorld.y > -0.05;
  sunDisc.visible = me && sunAbove;
  sunHalo.visible = sunDisc.visible;
  if (me) {
    hemi.color.set(0xeaf2ff);
    hemi.groundColor.set(0x1a2a6c);
    // Deep indigo-blue shadows for the Edge look (game-style cool shadow tint).
    sunUniforms.uShadowColor.value.set(0.08, 0.13, 0.38);
  } else {
    hemi.color.set(0x3a4060);      // matches the original uniform dark-blue ambient
    hemi.groundColor.set(0x3a4060);
    sunUniforms.uShadowColor.value.set(0.25, 0.25, 0.25); // neutral grey floor
  }
}

// ── Road overlay ─────────────────────────────────────────────────────────────────
/** @type {THREE.Group|null} */
let roadGroup = null;
/** @type {Map<string, LineSegments2>} */
const roadLayers = new Map();
// Roads float ROAD_LIFT world-metres above terrain; scale.y tracks userZScale.
const ROAD_LIFT = 20;

function updateRoadY() {
  if (!roadGroup) return;
  roadGroup.position.y = ROAD_LIFT;
  roadGroup.scale.y = userZScale;
}

/**
 * Build a THREE.Group with one fat-line mesh per road class.
 * roads.json stores 3D polyline strips per class ([[x,y,z,x,y,z,...], ...]) with Y baked
 * offline against the terrain (road_to_json.py --dtm), so there is no runtime height
 * sampling or re-clamping; Z-Scale still scales Y live via roadGroup.scale.y.
 * @param {{ highway: number[][], expressway: number[][], provincial: number[][] }} data
 * @returns {THREE.Group}
 */
function buildRoadGroup(data) {
  const group = new THREE.Group();
  roadLayers.clear();
  const classes = [
    { key: 'highway',    color: 0xff5522, width: 3.0, opacity: 0.95 },
    { key: 'expressway', color: 0xffcc00, width: 3.0, opacity: 0.95 }, // gold
    { key: 'provincial', color: 0x66ccaa, width: 3.0, opacity: 0.90 },
  ];
  for (const { key, color, width, opacity } of classes) {
    const strips = data[key];
    if (!strips || strips.length === 0) continue;
    // Expand each [x,y,z,...] strip into LineSegments edge pairs (6 numbers/edge).
    const positions = [];
    for (const s of strips) {
      for (let i = 0; i + 5 < s.length; i += 3) {
        positions.push(s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5]);
      }
    }
    if (positions.length < 6) continue;
    const geom = new LineSegmentsGeometry();
    geom.setPositions(positions);
    const line = new LineSegments2(geom, makeFatLineMaterial(color, width, opacity));
    line.frustumCulled = false; // island-wide bounds; cheap, avoids mis-cull
    roadLayers.set(key, line);
    group.add(line);
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
const boundaryMat = makeFatLineMaterial(0xffffff, 4.5, 0.9); // white, thicker than roads

/**
 * Lift boundary group so it hovers just above the highest terrain point in world space.
 * terrainBBox.max.y is in geometry space; terrainGroup.scale.y = userZScale stretches it.
 */
function updateBoundaryY() {
  // Boundary rings carry per-vertex terrain height baked offline (shp_to_json.py --dtm),
  // so they drape on the terrain like roads: a small lift to clear z-fighting + the live
  // Z-Scale. (Older 2D boundaries.json has Y=0 → this lays it flat at BOUNDARY_LIFT.)
  if (boundaryGroup) {
    boundaryGroup.position.y = BOUNDARY_LIFT;
    boundaryGroup.scale.y = userZScale;
  }
  updateLabelHeight();
}

/**
 * Region-name height tracking, accounting for both camera altitude AND pitch so the names
 * stay in view however the camera is angled:
 *   • Looking level  → names ride near the camera altitude (LABEL_HEIGHT_FRAC), following it.
 *   • Looking down   → names drop toward the terrain floor, the spot the camera is aimed at,
 *                      so they don't slide off the top of the screen.
 * The pitch weight is the camera forward vector's downward component (0 = level, 1 = straight
 * down). The pole always runs from the name down to the floor, shortening as the name drops.
 * Called every frame for smooth tracking; cheap.
 */
function updateLabelHeight() {
  if (!labelGroup || !terrainBBox) return;
  const floorY = terrainBBox.min.y * userZScale;
  camera.getWorldDirection(_camDir);
  const pitch = Math.min(1, Math.max(0, -_camDir.y)); // 0 = level, 1 = looking straight down
  const high  = floorY + (camera.position.y - floorY) * LABEL_HEIGHT_FRAC; // level: follow camera
  const low   = floorY + 100;                                              // down: sit near ground
  const y = high + (low - high) * pitch;
  labelGroup.position.y = y;
  if (poleGroup) poleGroup.scale.y = Math.max(1, y - floorY); // keep the pole base at the floor
}

/**
 * Signed-area centroid of a closed ring via the shoelace formula. Returns
 * `[cx, cz, area]` (area magnitude used to pick the largest part of a multipolygon).
 * Falls back to the vertex mean for degenerate (near-zero-area) rings.
 *
 *   A   = ½ Σ (xᵢ·zᵢ₊₁ − xᵢ₊₁·zᵢ)
 *   Cx  = 1/(6A) Σ (xᵢ + xᵢ₊₁)(xᵢ·zᵢ₊₁ − xᵢ₊₁·zᵢ)
 *
 * @param {Array<[number, number]>} ring
 * @returns {[number, number, number]}
 */
function ringCentroid(ring) {
  const zi = ring[0].length - 1; // z is the last component: index 1 (2D) or 2 (3D, Y baked)
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const x0 = ring[i][0],          z0 = ring[i][zi];
    const x1 = ring[(i + 1) % n][0], z1 = ring[(i + 1) % n][zi];
    const cross = x0 * z1 - x1 * z0;
    a  += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sz = 0;
    for (const p of ring) { sx += p[0]; sz += p[zi]; }
    return [sx / ring.length, sz / ring.length, 0];
  }
  return [cx / (6 * a), cz / (6 * a), Math.abs(a)];
}

/**
 * Build one CSS2D pin label per district. Districts spanning several rings
 * (multipolygon, e.g. 蘭嶼鄉) are merged by name; the label anchors at the centroid
 * of the district's largest-area ring. Each pin is a billboarded element: the white
 * region name above a thin gradient "stem" line that points down at the anchor.
 *
 * @param {Array<Array<[number, number]>>} rings
 * @param {string[]} names  parallel to rings
 * @returns {THREE.Group}
 */
function buildLabelGroup(rings, names) {
  // Per name, keep the centroid of the largest-area ring seen so far.
  const best = new Map(); // name → {cx, cz, area}
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    const name = names[i];
    if (!name || !ring || ring.length < 3) continue;
    const [cx, cz, area] = ringCentroid(ring);
    const prev = best.get(name);
    if (!prev || area > prev.area) best.set(name, { cx, cz, area });
  }

  const group = new THREE.Group();
  poleGroup = new THREE.Group(); // unit-down poles; scaled to the floor in updateBoundaryY
  group.add(poleGroup);

  for (const [name, { cx, cz }] of best) {
    const el = document.createElement('div');
    el.className = 'region-label';
    // CSS2DRenderer centres `el` on the anchor (pole top); .region-pin lifts the name
    // just above it so the name floats at the top of the pole — see style.css.
    el.innerHTML = `<div class="region-pin"><span class="region-name">${name}</span></div>`;
    const obj = new CSS2DObject(el);
    obj.position.set(cx, 0, cz);
    obj.visible = false;        // gated on by updateRegionLabels()
    obj.center.set(0.5, 0.5);   // anchor element centre on the point

    // 3D pole: a unit segment from the boundary plane straight down (y: 0 → −1). The
    // parent poleGroup's y-scale stretches it to the terrain floor (updateBoundaryY).
    // depthTest off + high renderOrder keeps it visible over terrain, like the label.
    const poleGeom = new THREE.BufferGeometry();
    poleGeom.setAttribute('position', new THREE.Float32BufferAttribute(
      [cx, 0, cz, cx, -1, cz], 3));
    const poleMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    });
    const pole = new THREE.Line(poleGeom, poleMat);
    pole.renderOrder = 998;
    pole.frustumCulled = false;
    pole.visible = false;
    poleGroup.add(pole);

    group.add(obj);
    regionLabels.push({ obj, el, pole, wx: cx, wz: cz, d2: 0 });
  }
  return group;
}

/** Smoothstep easing on [edge0, edge1] → [0, 1]. */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Per-frame visibility + opacity for region labels. Labels emerge once the camera is
 * a comfortable distance from its look-at target (a global fade envelope), then only
 * the nearest-N in-frustum districts within LABEL_RADIUS of the target are shown — so
 * the names appear around whatever you're looking at without cluttering the whole map.
 * Smoothness comes from a CSS opacity transition (see .region-label in style.css).
 */
function updateRegionLabels() {
  if (!labelGroup) return;
  const hide = (m) => {
    if (m.obj.visible) { m.obj.visible = false; m.el.style.opacity = '0'; }
    if (m.pole.visible) { m.pole.visible = false; m.pole.material.opacity = 0; }
  };
  if (!boundariesToggle.checked) { for (const m of regionLabels) hide(m); return; }

  // Look-around radius scales with view distance (clamped) so labels stay readable at
  // every altitude — a tight cluster up close, a broad sweep when zoomed out.
  const viewDist = camera.position.distanceTo(controls.target);
  const radius = Math.min(LABEL_RADIUS_MAX, Math.max(LABEL_RADIUS_MIN, viewDist * LABEL_RADIUS_K));
  const r2 = radius * radius;

  _labelProjM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _labelFrustum.setFromProjectionMatrix(_labelProjM);
  const tx = controls.target.x, tz = controls.target.z;
  const planeY = labelGroup.position.y;

  // Gather candidates: within radius of the look-at target AND inside the frustum.
  const candidates = [];
  for (const m of regionLabels) {
    const dx = m.wx - tx, dz = m.wz - tz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) { hide(m); continue; }
    _labelPt.set(m.wx, planeY, m.wz);
    if (!_labelFrustum.containsPoint(_labelPt)) { hide(m); continue; }
    m.d2 = d2;
    candidates.push(m);
  }
  candidates.sort((a, b) => a.d2 - b.d2);

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    if (i >= LABEL_MAX_COUNT) { hide(m); continue; }
    // Radial fade near the outer radius so labels dissolve rather than pop at the edge.
    const opacity = 1 - smoothstep(radius * 0.7, radius, Math.sqrt(m.d2));
    m.obj.visible = true;
    m.el.style.opacity = opacity.toFixed(3);
    m.pole.visible = true;
    m.pole.material.opacity = opacity * 0.8; // pole a touch fainter than the name
  }
}

/**
 * Build a THREE.Group of closed fat-line loops from the rings array in boundaries.json.
 * Each vertex is [x, z] (2D, flat) or [x, y, z] (3D, terrain height baked offline). The
 * baked Y drapes the ring on the terrain; the group is lifted + Z-scaled via updateBoundaryY().
 *
 * @param {Array<Array<number[]>>} rings
 * @returns {THREE.Group}
 */
function buildBoundaryGroup(rings) {
  const group = new THREE.Group();
  for (const ring of rings) {
    if (ring.length < 2) continue;
    const n = ring.length;
    const is3D = ring[0].length >= 3; // [x,y,z] (draped) vs [x,z] (flat)
    const positions = new Float32Array((n + 1) * 3); // +1 repeats the first vertex (Line2 has no LineLoop)
    for (let i = 0; i <= n; i++) {
      const v = ring[i % n];
      positions[i * 3]     = v[0];
      positions[i * 3 + 1] = is3D ? v[1] : 0;
      positions[i * 3 + 2] = is3D ? v[2] : v[1];
    }
    const geom = new LineGeometry();
    geom.setPositions(positions);
    const line = new Line2(geom, boundaryMat);
    line.frustumCulled = false;
    group.add(line);
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
    labelGroup = buildLabelGroup(data.rings ?? [], data.names ?? []);
    scene.add(labelGroup);
    updateBoundaryY();
    scene.add(boundaryGroup);
  })
  .catch(() => {
    console.info('[boundaries] Not found — run: just convert-boundaries');
  });

boundariesToggle.addEventListener('change', () => {
  if (boundaryGroup) boundaryGroup.visible = boundariesToggle.checked;
  if (!boundariesToggle.checked) updateRegionLabels(); // hide labels immediately
});

// One "Shader" switch: terrain hillshade + cast shadows (terrain & buildings).
// Toggling dirLight.castShadow changes the shadow-caster count, so three.js
// recompiles the affected materials automatically (no manual needsUpdate).
function applyShader() {
  const on = shaderToggle.checked;
  sunUniforms.uHillshade.value = on ? 1.0 : 0.0;
  dirLight.castShadow = on;
}
shaderToggle.addEventListener('change', applyShader);
applyShader(); // sync from the default-checked state

buildingsToggle.addEventListener('change', () => {
  buildingGroup.visible = buildingsToggle.checked;
});

riversToggle.addEventListener('change', () => {
  riverGroup.visible = riversToggle.checked;
  if (!riversToggle.checked) updateRivers(); // unload tiles to free memory
});

timeSlider.addEventListener('input', () => {
  const hour = parseFloat(timeSlider.value);
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  timeValue.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  setSunFromHour(hour);
});
setSunFromHour(parseFloat(timeSlider.value)); // initialise sun from the default slider value
colorMapSelect.value = currentColorMap;       // force Edge default (defeat browser form restore)
applyTheme(currentColorMap);                  // apply the default colour map's scene look


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
          'uniform vec3  uShadowColor;',
          shader.fragmentShader,
        ].join('\n');

        // Hillshade → then grid → then dithering
        // `normal` is the view-space surface normal set by normal_fragment_begin.
        // `uSunDirView` is sunDirWorld transformed to view space each frame.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `{
  // Hillshade: Lambert factor → blend between shadow colour and full brightness.
  // uShadowColor drives the shadow tone: deep blue in Edge theme, neutral grey otherwise.
  float hs = max(0.0, dot(normal, uSunDirView));
  vec3 light = uShadowColor + (1.0 - uShadowColor) * hs;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * light, uHillshade);
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
      applyVertexColors(terrainMeshes, currentColorMap);
      lodGroupCache.set(GLB_URL, {
        group:    terrainGroup,
        meshes:   terrainMeshes,
        bbox:     terrainBBox,
        colorMap: currentColorMap,
      });
      if (userZScale !== 1) terrainGroup.scale.y = userZScale;

      scene.add(terrainGroup);
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
        .then((d) => { if (d && d.tiles) tileIndex = d; })
        .catch(() => { console.info('[tiles] tiles/index.json not found — run: just tile'); });

      // Building tiles: white massing + box LOD, streamed by updateBuildings().
      buildingGroup.scale.y = userZScale;
      scene.add(buildingGroup);
      fetch(import.meta.env.BASE_URL + 'building_tiles/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && d.tiles) buildingIndex = d; })
        .catch(() => { console.info('[buildings] building_tiles/index.json not found — run: just buildings'); });

      // River water tiles: flat blue surface clamped to terrain, streamed by updateRivers().
      riverGroup.scale.y = userZScale;
      riverGroup.visible = riversToggle.checked;
      scene.add(riverGroup);
      fetch(import.meta.env.BASE_URL + 'river_tiles/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && d.tiles) riverIndex = d; })
        .catch(() => { console.info('[rivers] river_tiles/index.json not found — run: just rivers'); });

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
  const vSpeed = speed * 0.35; // Q/E vertical move is gentler than WASD pan
  if (keysDown.has('q')) _flyDelta.y -= vSpeed;
  if (keysDown.has('e')) _flyDelta.y += vSpeed;

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

  // Keep the directional light + its shadow frustum centred on the orbit target so
  // shadows render at usable resolution around wherever the user is looking.
  dirLight.target.position.copy(controls.target);
  dirLight.position.copy(controls.target).addScaledVector(sunDirWorld, SHADOW_DIST);

  // Sun disc + halo track the camera like a skydome element.
  if (sunDisc.visible) {
    sunDisc.position.copy(camera.position).addScaledVector(sunDirWorld, SUN_DIST);
    sunHalo.position.copy(sunDisc.position);
  }

  // Retune fog by altitude (changing near/far is just uniforms — no material recompile).
  // City scale → tight haze into the white horizon; island overview → pushed away so the
  // whole map stays clear. Only active in the Mirror's Edge theme (scene.fog set).
  if (scene.fog && terrainBBox) {
    const alt = camera.position.y - terrainBBox.min.y;
    if (alt < 20000) { scene.fog.near = 18000;  scene.fog.far = 110000; }
    else             { scene.fog.near = 300000; scene.fog.far = 1200000; }
  }


  controls.update();

  // Region names descend with the camera once it dips below the boundary plane (cheap;
  // every frame so it tracks smoothly during low-level flight).
  if (labelGroup && boundariesToggle.checked) updateLabelHeight();

  // LOD check once per ~60 frames; skip during intro orbit to avoid racing the first load
  if (++lodFrameCount % 60 === 0 && terrainBBox && introComplete) {
    const target = targetLodUrl();
    if (target !== activeLodUrl) switchLod(target);
  }

  // Tiled-LOD streaming: more frequent than LOD (camera focus moves continuously)
  if (++detailFrameCount % 15 === 0 && introComplete) updateTiles();
  if (++buildingFrameCount % 20 === 0 && introComplete) {
    updateBuildings();
    updateRivers();
    updateRegionLabels(); // CSS transition smooths the fade between these coarse ticks
  }

  // Measure markers: constant on-screen size (~6% of viewport height), a slow spin, and a
  // gentle float above the anchor. Anchor (userData.point) stays the measured ground truth;
  // the visual bob/spin never touches the bbox. Float magnitude scales with marker size.
  if (measureGroup.children.length > 0) {
    const k = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * 0.06;
    const children = measureGroup.children;
    for (let i = 0; i < children.length; i++) {
      const m = children[i];
      const base = m.userData.point;
      // ~constant screen size, but never smaller than 50 m tall up close (unit height = 1 → s = metres).
      const s = Math.max(camera.position.distanceTo(base) * k, 50);
      m.scale.setScalar(s);
      m.rotation.y = t * 0.0006; // slow spin
      const bob = Math.sin(t * 0.002 + i * Math.PI) * 0.2 * s; // out-of-phase float per marker
      m.position.set(base.x, base.y + 0.45 * s + bob, base.z);
    }
  }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera); // CSS2D region-name pins over the main scene
  stats.end(renderer); // before renderGizmo so renderer.info reflects the main scene
  renderGizmo();
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

<h3>Debug HUD (🐞)</h3>
<p>The 🐞 button toggles a draggable performance overlay:</p>
<ul>
<li><code>FPS</code> — frames rendered per second (capped by the display refresh; 60 is typical).</li>
<li><code>MS</code> — milliseconds of work per frame; under ~16.7 ms sustains 60 FPS.</li>
<li><code>MB</code> — JS heap memory in use (Chromium only).</li>
<li><code>tris</code> — triangles drawn this frame; climbs as detail tiles &amp; buildings stream in.</li>
<li><code>draws</code> — draw calls per frame (≈ one per visible tile/overlay; fewer is cheaper).</li>
<li><code>geo</code> — GPU geometries allocated; should rise &amp; fall with streaming, never grow unbounded (leak check).</li>
<li><code>tex</code> — GPU textures (≈ 0 here — surfaces are flat-coloured, untextured).</li>
<li><code>prog</code> — cached compiled shader programs; a small constant. A climbing count means shader recompiles (jank).</li>
</ul>
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

<h3>除錯 HUD（🐞）</h3>
<p>點 🐞 按鈕開關可拖動的效能浮層，各欄位意義：</p>
<ul>
<li><code>FPS</code> — 每秒算繪幀數（受螢幕更新率上限，通常 60）。</li>
<li><code>MS</code> — 每幀耗時（毫秒）；低於約 16.7 ms 才能維持 60 FPS。</li>
<li><code>MB</code> — 使用中的 JS heap 記憶體（僅 Chromium 支援）。</li>
<li><code>tris</code> — 本幀繪製的三角形數；細節圖磚與建築串流進來時上升。</li>
<li><code>draws</code> — 每幀 draw call 數（每個可見圖磚/疊層約一個，越少越省）。</li>
<li><code>geo</code> — GPU 上配置的幾何數；應隨串流上下，不應無限增長（抓記憶體洩漏）。</li>
<li><code>tex</code> — GPU 貼圖數（本專案趨近 0，表面為純色無貼圖）。</li>
<li><code>prog</code> — 已快取的已編譯 shader program 數；應為小常數。持續攀升代表 shader 重編（卡頓來源）。</li>
</ul>
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
