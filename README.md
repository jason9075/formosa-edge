# Formosa's Edge — Taiwan 3D Terrain

An interactive 3D terrain viewer for Taiwan's **main island** (19 counties merged into one map),
built with Three.js and Vite. Raw elevation data is converted from government photogrammetry tiles
to binary GLB meshes in a fully offline Python pipeline, then rendered in-browser with a 100 m
overview base, **on-demand 20 m detail-tile streaming**, frustum culling, a TWD97 coordinate grid
overlay, administrative boundary lines, and a road network overlay.

> **Scope:** Outlying islands (Penghu / Kinmen / Lienchiang) are excluded — they sit hundreds of km
> offshore and would explode the merged mesh bounding box with empty-sea vertices. See
> [Known Data Gaps](#known-data-gaps) for a real hole in the source DTM over the Xueshan high peaks.

---

## Live Data Sources

| Dataset | Format | CRS | Source |
|---------|--------|-----|--------|
| Taiwan 20 m DTM (2025 edition) | GRD / HDR tiles | TWD97 TM2 (EPSG:3826), TWVD2001 vertical | [data.gov.tw/dataset/176927](https://data.gov.tw/dataset/176927) |
| Township / district boundaries | Shapefile (polygon) | GCS TWD97 geographic (degrees) | [data.gov.tw/dataset/7441](https://data.gov.tw/dataset/7441) |
| National / provincial road centrelines (incl. expressways) | Shapefile (polyline) | TWD97 TM2 (EPSG:3826) | [data.gov.tw/dataset/73232](https://data.gov.tw/dataset/73232) |
| Taipei City 3D buildings | KMZ (COLLADA models) | WGS84 lon/lat → TWD97 | [github.com/sheethub/tpe3d](https://github.com/sheethub/tpe3d) |
| River channels (河川河道) | Shapefile (polygon) | TWD97 TM2 (EPSG:3826) | [data.gov.tw/dataset/25781](https://data.gov.tw/dataset/25781) |

---

## Architecture

```
scripts/dtm_sources.csv ──fetch_dtm.py──▶ raw/<county>/*.grd   (19 main-island counties)
                                                  │
              ┌───────────────────────────────────┼───────────────────────────────┐
              │                                   │                                 │
        dtm_to_glb.py (rglob, merge)        tile_dtm.py (slice 20 m)        shp_to_json.py / road_to_json.py
              │                                   │                                 │
   output/taiwan_100m.glb (base)        output/tiles/*.glb + index.json    output/boundaries.json / roads.json
              │                                   │                                 │
              └──────────────── just compress-glb / just tile (Draco) ─────────────┘
                                                  │
                                  just stage → public/   (dev serves output/ directly)
                                                  │
                                        Vite dev / build server
                                                  │
                            src/main.js (Three.js: base + detail-tile streamer)
```

---

## Implemented Mechanisms

### 1. DTM → GLB Conversion (`dtm_to_glb.py`)

Each source tile is a plain-text GRD file with `(X, Y, Z)` triplets on a 20 m grid (TWD97 Easting,
Northing, TWVD2001 elevation). The pipeline:

1. **Grid assembly** — `.hdr`/`.grd` tiles are found recursively (`rglob`), so pointing the script
   at `raw/` merges **all 19 counties** into one shared-centre grid. Cells with any `NaN` corner are
   skipped (holes instead of bogus triangles), and unreferenced no-data/sea vertices are compacted
   out before serialisation (~half the grid for an island).
2. **Decimation** — the `--step N` flag retains every Nth grid row/column. The merged island ships
   at 100 m (`--step 5`); a full 20 m island mesh is **not web-viable** (~90 M vertices), so 20 m
   detail is streamed per-tile instead (see [Detail-Tile Streaming](#8-detail-tile-streaming)).
3. **Normal estimation** — per-vertex surface normals are computed via central differences on the
   elevation grid:

   ```
   n = normalize(−∂Z/∂x,  1,  −∂Z/∂y)
   ```

4. **Coordinate mapping to GLB Y-up space:**

   ```
   GLB X =  Easting  − E₀
   GLB Y =  Elevation × z_scale
   GLB Z = −(Northing − N₀)
   ```

   The centroid `(E₀, N₀)` and `z_scale` are embedded in the file's `extras` object so the viewer
   can reconstruct TWD97 coordinates at runtime.

5. **GLB serialisation** — a minimal hand-written glTF 2.0 binary (no external library):
   one JSON chunk (descriptors + extras) followed by one BIN chunk
   (`POSITION | NORMAL | INDICES`).

---

### 2. Level of Detail (LOD)

The merged island ships as a **single always-loaded 100 m base mesh**, with 20 m detail streamed
on top by camera proximity (see §8). The original altitude-switched multi-mesh LOD machinery
(`lodCache` / `lodGroupCache` / `switchLod`) is retained and still drives single-region builds
(`just convert-county <slug>`), but the merged map uses one base level:

| Mesh | Raw size | Draco size | Role |
|------|----------|------------|------|
| `taiwan_100m.glb` | 166 MB | **7.2 MB** | monolithic far-overview (3.6 M verts; chunk-culled) |
| `output/tiles/*.glb` | — | ~116 KB ea. | 20 m detail, streamed near (1581 tiles, ~184 MB) |
| `output/base_tiles/*.glb` | — | ~10 KB ea. | 100 m, streamed mid-range (1580 tiles, ~17 MB) |

All GLBs are Draco-compressed (~95 % reduction). The LOD check runs once every 60 render frames
(after the intro animation completes). Two caches eliminate redundant work:

- **Geometry cache** (`lodCache`) — raw `BufferGeometry` per URL, avoids re-fetching.
- **Group cache** (`lodGroupCache`) — fully chunked + vertex-coloured `THREE.Group` per URL.
  Switching back to a previously visited LOD is an O(1) scene-graph swap with no re-chunking,
  eliminating the stutter that would otherwise occur on repeated altitude changes.

---

### 3. Chunk-based Frustum Culling

A single terrain mesh gives Three.js no sub-mesh granularity — the whole mesh is either
visible or not. To fix this, each loaded geometry is split into an 8 × 8 grid of independent
sub-meshes:

1. Every triangle is assigned to a bucket by its centroid XZ position.
2. Each bucket is re-indexed into its own `BufferGeometry`.
3. `computeBoundingSphere()` is called per chunk so Three.js can cull individual chunks
   against the camera frustum each frame — no extra code needed.
4. All 64 chunks share one `MeshStandardMaterial`, so the shader is compiled once.

When zoomed into a small valley, up to ~90 % of chunks are culled, significantly reducing
GPU load at 20 m resolution.

---

### 4. TWD97 Coordinate Grid Overlay

The grid is rendered entirely in the fragment shader injected via `MeshStandardMaterial.onBeforeCompile`.
No extra geometry is created.

- A `vWorldPos` varying is added in the vertex shader to pass world-space XZ to the fragment shader.
- The fragment shader reconstructs TWD97 coordinates by reversing the GLB mapping:

  ```glsl
  vec2 twd97 = vec2(vWorldPos.x + uGridOffset.x,
                   -vWorldPos.z + uGridOffset.y);
  ```

- Grid lines are drawn with `smoothstep` anti-aliasing; line width is 0.4 % of the grid spacing
  so it scales correctly at any zoom level.
- Configurable spacings: 1 km / 2 km / 5 km / 10 km (runtime uniform, no recompile).

---

### 5. Vertex Color Elevation Mapping

Color is applied in two passes to guarantee a consistent scale across all 64 chunks:

1. **Pass 1** — scan every chunk to find the global `yMin` / `yMax`.
2. **Pass 2** — write per-vertex RGB into each chunk's geometry, normalising elevation
   to `[0, 1]` with the global range.

Three built-in color maps are available (selectable at runtime):

| Map | Description |
|-----|-------------|
| `terrain` | Low-land green → hill brown → mountain grey (4-stop linear) |
| `grayscale` | Uniform luminance ramp |
| `rainbow` | Full HSV sweep for maximum contrast |

The legend bar in the bottom bar is redrawn dynamically using a 32-stop CSS gradient
whenever the color map or terrain changes.

---

### 6. Admin Boundary Overlay (`shp_to_json.py`)

The 內政部 township shapefile is delivered in geographic TWD97 (degrees). The pipeline:

1. Reads ring coordinates with `pyshp`.
2. Reprojects from `EPSG:4326` (≈ GCS_TWD97) to `EPSG:3826` (TM2 metres) via `pyproj`.
3. Filters rings to only those whose bounding box intersects the terrain extent
   (plus a 2 km margin).
4. Applies the same coordinate mapping as the GLB:

   ```python
   x = Easting  - x_center
   z = -(Northing - y_center)
   ```

5. With `--dtm`, bakes a per-vertex terrain height from a `TerrainSampler` (`E = x + x_center`,
   `N = y_center − z` inverts the mapping to look up the DTM) so the lines **drape on the terrain**
   exactly like the baked roads — same offline philosophy, no runtime raycasting.
6. Writes `output/boundaries.json` — rings of `[x, y, z]` (or `[x, z]` without `--dtm`) plus a
   parallel `names` array (district name per ring; multipolygon parts repeat the name).

In Three.js, each ring becomes a closed `Line2` (fat line). The baked Y drapes it on the surface;
the boundary `Group` only needs a small lift + the live Z-scale (mirrors `updateRoadY`):

```js
boundaryGroup.position.y = BOUNDARY_LIFT; // 50 m, clears z-fighting; sits above roads' 20 m
boundaryGroup.scale.y    = userZScale;
```

Lines are depth-tested, so ridges occlude boundaries behind them at low angles — the natural,
draped look (the same trade-off as roads).

**Region-name labels.** When the layer is on, district names appear as billboarded CSS2D pins
(`CSS2DRenderer`): the white name floats at the top of a thin WebGL pole that drops to the terrain
floor. Each name anchors at the centroid of its district's largest ring (shoelace formula, merged
by name across multipolygon parts). Visibility is gated by a view-distance-scaled radius + frustum
+ a nearest-N cap so labels emerge around the look-at point instead of flooding all 379 districts.
The name height tracks the camera's altitude **and pitch** (level → near camera height; looking
down → toward the ground) so it always stays in view; opacity fades via a CSS transition.

---

### 7. Road Overlay (`road_to_json.py`)

The road shapefile is already in TWD97 TM2 (EPSG:3826) — no reprojection is needed.

**Classification by `ROADCLASS1` attribute:**

| Code | Class | Colour |
|------|-------|--------|
| `H*` | National freeway | Orange-red |
| `1E` | Expressway | Gold |
| `1U`, `1W` | Provincial road | Teal |

**Pipeline:**

1. Reads polyline geometries with `pyshp`.
2. Filters segments to the terrain bounding box (+ 1 km margin).
3. Simplifies each polyline (Douglas-Peucker, 1 m via `shapely`) and applies the GLB XZ mapping:

   ```python
   x = Easting  - x_center
   z = -(Northing - y_center)
   ```

4. **Bakes Y per vertex** by sampling the terrain (`--dtm`, a 40 m `TerrainSampler` over the
   whole island), so `y = raw elevation (m)`. This is the key optimisation: the viewer never
   re-clamps roads onto streaming tiles at runtime.
5. Emits per-class arrays of **3-D polyline strips** (`[[x0,y0,z0,x1,y1,z1,…], …]` — no edge-pair
   vertex duplication), coords rounded to 1 m integers. Writes `output/roads.json` (~3.9 MB).

In Three.js each class expands to one `LineSegments2` fat line (one draw call per class). Because
Y is baked, **there is no runtime height sampling or rebake** — roads simply load at the correct
elevation. Z-Scale still works because the baked Y is the *unscaled* elevation and the group
scales it live:

```js
// world_Y = ROAD_LIFT + userZScale × baked_elevation
roadGroup.position.y = ROAD_LIFT;   // constant world offset (lift above terrain)
roadGroup.scale.y    = userZScale;  // co-scales the baked elevation with terrain
```

---

### 8. Tiled LOD Streaming

A full-island 20 m mesh is impractical as one file, so terrain is delivered as **two levels of
streamable tiles** plus the monolithic mesh for the far overview (`tile_dtm.py` → `just tile`):

1. **Global grid** — one 20 m grid + normals are built for the whole island, then sliced into
   5 km tiles with a **+1 cell overlap** so adjacent same-level tiles share their boundary
   samples (no cracks, continuous shading). `--step 5` decimates a level to 100 m.
2. **Two levels, same grid/keys** — `output/tiles/` (20 m detail) and `output/base_tiles/`
   (100 m, ~10 KB each) use identical `tx_ty` keys, both baked against `taiwan_100m.glb`'s centre
   so they align. `output/tiles/index.json` lists each tile's id, URL and local-space centre.
3. **Skirts** — every tile gets a vertical curtain (`--skirt 120`) dropped along its boundary,
   emitted in both windings. At a 20 m↔100 m boundary the edge vertex densities differ
   (T-junction); the skirts hide the resulting hairline cracks without filling the gap with a
   second surface.
4. **Runtime** (`updateTiles` in `src/main.js`):
   - The monolithic `taiwan_100m.glb` is **always visible as a backdrop**. **Far**
     (camera > `FAR_ALT` 20 km above terrain) → tiles unloaded, backdrop shows everywhere.
   - **Near** → exactly **one tile per visible cell** is streamed: 20 m within `DETAIL_DIST`
     (18 km) of the camera, else 100 m out to `BASE_DIST` (70 km). Frustum-based, nearest-first
     (≤ 8 concurrent; caps 160 detail / 320 base; evicted past 24 / 85 km or over cap; `LOD_HYST`
     prevents thrash at the 20/100 boundary).
5. **Stencil-masked backdrop — no overlap, no black gaps.** Tiles render first and **write
   `stencil = 1`**; the backdrop tests **`stencil != 1`**, so it is suppressed wherever a tile
   drew (no z-fighting / no concave-valley poke-through) but still fills any cell whose tile has
   not streamed in yet — so panning shows the coarse 100 m surface in gaps, never black. In
   three.js `stencilWrite = true` is the master switch that *enables* the stencil test (setting it
   `false` disables it). Off-screen residents are frustum-culled by Three.js; a log depth buffer
   keeps precision across the near=1..far=1e6 span.

> **Deploy note:** during local iteration `just dev` serves tiles straight from `output/` via Vite
> middleware (no staging). For the GitHub Pages build there is no Python/staging step — the workflow
> only runs `npm run build`, which copies `public/` verbatim into `dist/`. So **every runtime asset
> must be committed under `public/`**; `just stage` copies the `output/` products there. All tiles
> (20 m ~200 MB + 100 m base ~17 MB + buildings ~23 MB + rivers ~4 MB) are committed — ~259 MB total,
> within GitHub's 100 MB-per-file (largest is ~7 MB) and Pages' 1 GB-per-site limits. The trade-off
> is a heavier repo / slower clone from the ~4 000 binary tile files.

---

## Known Data Gaps

The 2025 **per-county ("分幅") 20 m DTM** has a genuine ~12 × 13 km void over the Xueshan / Shei-Pa
high peaks (centred ≈ TWD97 E 257 480, N 2 711 390, on the Hsinchu / Miaoli / Taichung border) —
**no source tile covers that block at all** (typical of aerial photogrammetry under persistent
cloud over the highest summits). It renders as a square hole in both the 100 m base and the 20 m
tiles. This is faithful to the source and is **left as-is**; to fill it later, either interpolate
the `NaN` region in `dtm_to_glb.py` or splice in the separate "不分幅_全台" combined dataset.

---

## Development Setup

This project uses [Nix flakes](https://nixos.wiki/wiki/Flakes) for reproducible environments
and [`just`](https://just.systems/) for task automation.

```sh
# Enter the dev shell (or use direnv)
nix develop

# Install npm dependencies
just install

# Fetch raw DTM tiles for all 19 main-island counties from the TGOS catalogue
just fetch

# Generate the merged 100 m island base (one-time; raw tiles required)
just convert-100m   # → output/taiwan_100m.glb (166 MB raw → 7.2 MB Draco)
just compress-glb   # Draco-compress all GLBs in output/

# Slice the merged island into streamable tiles (20 m + 100 m, skirts, + Draco)
just tile           # → output/tiles/ (~184 MB) + output/base_tiles/ (~17 MB) + index.json

# Generate overlay JSONs (use output/taiwan_100m.glb as reference)
just convert-boundaries
just convert-roads

# Start Vite dev server → http://localhost:8080
# (serves output/ — including tiles/ — and public/ transparently; no staging for dev)
just dev
```

### Production / GitHub Pages

```sh
just stage    # copies output/*.glb + output/*.json + tile dirs → public/
git add public/   # commit the deploy assets (see deploy note in §8)
just build    # Vite production build → dist/ (CI runs this on push to main)
```

`public/` is the **single committed source of deploy assets** — backdrop GLB, overlays, and all
tile directories (`tiles/`, `base_tiles/`, `building_tiles/`, `building_boxes/`, `river_tiles/`,
each with its `index.json`). `dist/` is generated by CI and stays in `.gitignore`. `output/` is
gitignored local scratch (never tracked). Push to `main` triggers the Pages deploy workflow.

> The GitHub Pages deployment base is `/formosa-edge/` — configured in `vite.config.js`.
> `import.meta.env.BASE_URL` is injected by Vite at build time so all asset URLs are correct
> in both dev (`/`) and production (`/formosa-edge/`) without any manual path management.

---

## Controls

| Input | Action |
|-------|--------|
| Left-drag | Orbit (rotate around target) |
| Right-drag / Middle-drag | Pan |
| Scroll | Zoom |
| Double-click terrain | Set new orbit target |
| `W` / `S` | Fly forward / backward (XZ plane) |
| `A` / `D` | Strafe left / right |
| `Q` / `E` | Move down / up (Y axis) |
| `Shift` + WASD/QE | 5× speed boost |
| `R` | Reset camera |
| `T` | Top-down view |
| `Esc` | Close math modal |

---

## Project Layout

```
.
├── dtm_to_glb.py        # DTM tiles → merged GLB mesh (Python; rglob merge + compaction)
├── tile_dtm.py          # Merged island → 20 m / 100 m streamable tiles + index.json
├── buildings_to_glb.py  # Building footprints → massing/box tiles; exports TerrainSampler
├── rivers_to_glb.py     # River polygons → flat water-surface tiles (clamped to terrain)
├── shp_to_json.py       # Township boundaries → JSON rings + names (--dtm bakes draped Y)
├── road_to_json.py      # Road centrelines → JSON polyline strips (--dtm bakes Y)
├── scripts/
│   ├── fetch_dtm.py     # Download/extract all main-island counties (curl, --main-island)
│   ├── dtm_sources.csv  # TGOS 2025 20 m DTM catalogue (per-county zip URLs)
│   └── fix-noexec.cjs   # Build shim (Node --require) for the noexec dev store
├── flake.nix            # Nix dev shell (Node 22, Python 3.13 + numpy/pyshp/pyproj/shapely/earcut)
├── Justfile             # Task runner (fetch, convert-*, tile, buildings, rivers, compress, stage, dev, build)
├── vite.config.js       # Vite config + output/ dev middleware (serves *.glb / *.json)
├── index.html           # App shell
├── src/
│   ├── main.js          # Three.js scene, tile streamer, shaders, overlays, region-name labels
│   ├── stats.js         # Dependency-free FPS / MS / MB + three.js render-info HUD (draggable)
│   └── style.css        # Light frosted-glass UI styles (Mirror's Edge "Edge" theme)
├── public/              # Web-ready deploy assets — the single committed source for GitHub Pages
│   ├── draco/           # Draco WASM decoder (from three.js)
│   ├── taiwan_100m.glb  # Draco-compressed 100 m island base (always-visible backdrop)
│   ├── boundaries.json  # Township boundary rings (draped [x,y,z]) + district names
│   ├── roads.json       # Road centreline polyline strips (baked Y)
│   ├── tiles/           # 20 m detail tiles + index.json (~200 MB; streamed near camera)
│   ├── base_tiles/      # 100 m tiles (keyed off tiles/index.json; mid-range fallback)
│   ├── building_tiles/  # Building massing tiles + index.json
│   ├── building_boxes/  # Building AABB-box LOD tiles + index.json
│   └── river_tiles/     # Flat water-surface tiles + index.json
├── raw/<county>/        # Source DTM tiles per county (not committed)
├── raw/road/            # Road shapefile (not committed)
├── raw/river/           # River shapefile (not committed)
├── line/                # Boundary shapefile (not committed)
└── output/              # Local build products (gitignored; `just stage` copies → public/)
```

---

## License

Source code: MIT.
Terrain data: [CC BY 4.0](https://data.gov.tw/dataset/176927) — 國土測繪中心, 內政部.
Boundary data: [CC BY 4.0](https://data.gov.tw/dataset/7441) — 內政部國土管理署.
Road data: [CC BY 4.0](https://data.gov.tw/dataset/73232) — 內政部國土管理署.
3D building data: [tpe3d](https://github.com/sheethub/tpe3d) — 臺北市政府都市發展局 (台北市開放資料).
