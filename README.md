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

5. Writes `output/boundaries.json` — an array of `[x, z]` rings with district names.

In Three.js, each ring becomes a `THREE.LineLoop`. The boundary `Group` is parented directly to
the scene and its Y position is updated whenever the terrain loads or Z-scale changes:

```js
boundaryGroup.position.y = terrainBBox.max.y * userZScale + BOUNDARY_LIFT;
```

This keeps the lines floating 50 m above the highest terrain point regardless of the Z-scale
setting, without requiring per-vertex terrain raycasting.

---

### 7. Road Overlay (`road_to_json.py`)

The road shapefile is already in TWD97 TM2 (EPSG:3826) — no reprojection is needed.

**Classification by `ROADCLASS1` attribute:**

| Code | Class | Colour |
|------|-------|--------|
| `H*` | National freeway | Orange-red |
| `1E` | Expressway | Light blue |
| `1U`, `1W` | Provincial road | Teal |

**Pipeline:**

1. Reads polyline geometries with `pyshp`.
2. Filters segments to the terrain bounding box (+ 1 km margin).
3. Applies the same XZ mapping as the GLB:

   ```python
   x = Easting  - x_center
   z = -(Northing - y_center)
   ```

4. Emits flat edge-pair arrays per class (`[x0,z0,x1,z1, ...]`), yielding ~40 k edges total.
5. Writes `output/roads.json` (~1.2 MB).

In Three.js, each class becomes a single `THREE.LineSegments` (one draw call per class).
Road vertex Y is sampled from a **terrain height grid** built from the 100 m GLB: for each
vertex the maximum elevation among the four surrounding 100 m grid cells is used, so
road lines stay above the terrain surface across the full range of Z-Scale settings.

```js
// world_Y = ROAD_LIFT + userZScale × max_surrounding_elevation
roadGroup.position.y = ROAD_LIFT;   // constant world offset
roadGroup.scale.y    = userZScale;  // co-scales with terrain
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

> **Deploy note:** the 20 m tiles total ~184 MB (the 100 m base tiles add only ~17 MB). They are
> **not** staged into `public/` by default (it would bloat the git repo). `just dev` serves them
> from `output/` via Vite middleware with no staging. For production, choose a strategy (Git LFS,
> an external asset host, or CI generation) before running `just stage`, which copies
> `output/tiles/ → public/tiles/` and `output/base_tiles/ → public/base_tiles/`.

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
just stage    # copies output/*.glb + output/*.json → public/
just build    # Vite production build → dist/
```

Commit `public/` (staged assets + `draco/` decoder files) alongside the source.
`dist/` is generated by CI and should remain in `.gitignore`. **Detail tiles (`public/tiles/`,
~184 MB) are intentionally not committed** — pick a deploy strategy (Git LFS / external host / CI
generation) before staging them; see the deploy note in §8.

> The GitHub Pages deployment base is `/DTM-Visualizer/` — configured in `vite.config.js`.
> `import.meta.env.BASE_URL` is injected by Vite at build time so all asset URLs are correct
> in both dev (`/`) and production (`/DTM-Visualizer/`) without any manual path management.

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
├── tile_dtm.py          # Merged island → 20 m streamable detail tiles + index.json
├── shp_to_json.py       # Shapefile boundaries → JSON (Python)
├── road_to_json.py      # Road centrelines → JSON (Python)
├── scripts/
│   ├── fetch_dtm.py     # Download/extract all main-island counties (curl, --main-island)
│   └── dtm_sources.csv  # TGOS 2025 20 m DTM catalogue (per-county zip URLs)
├── flake.nix            # Nix dev shell (Node 22, Python 3.13 + numpy/pyshp/pyproj)
├── justfile             # Task runner (fetch, convert-100m, tile, compress, stage, dev, build)
├── vite.config.js       # Vite config + output/ dev middleware (serves *.glb / *.json)
├── index.html           # App shell
├── src/
│   ├── main.js          # Three.js scene, base mesh, detail-tile streamer, shaders, overlays
│   ├── stats.js         # Dependency-free MS / MB performance HUD (top-left)
│   └── style.css        # Dark UI styles
├── public/              # Web-ready assets (committed; tiles/ NOT committed — see §8)
│   ├── draco/           # Draco WASM decoder (from three.js)
│   ├── taiwan_100m.glb  # Draco-compressed 100 m island base
│   ├── boundaries.json  # Township boundary rings
│   └── roads.json       # Road centreline edge pairs
├── raw/<county>/        # Source DTM tiles per county (not committed)
├── raw/road/            # Road shapefile (not committed)
├── line/                # Boundary shapefile (not committed)
└── output/              # Intermediate generated files incl. tiles/ (not committed)
```

---

## License

Source code: MIT.
Terrain data: [CC BY 4.0](https://data.gov.tw/dataset/176927) — 國土測繪中心, 內政部.
Boundary data: [CC BY 4.0](https://data.gov.tw/dataset/7441) — 內政部國土管理署.
Road data: [CC BY 4.0](https://data.gov.tw/dataset/73232) — 內政部國土管理署.
3D building data: [tpe3d](https://github.com/sheethub/tpe3d) — 臺北市政府都市發展局 (台北市開放資料).
