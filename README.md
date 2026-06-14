# DTM Visualizer — Taipei

An interactive 3D terrain viewer for the Taipei metropolitan area, built with Three.js and Vite.
Raw elevation data is converted from government LiDAR tiles to a binary GLB mesh in a fully
offline Python pipeline, then rendered in-browser with LOD switching, frustum culling,
a TWD97 coordinate grid overlay, and administrative boundary lines.

---

## Live Data Sources

| Dataset | Format | CRS | Source |
|---------|--------|-----|--------|
| Taiwan 20 m DTM (2025 edition) | GRD / HDR tiles | TWD97 TM2 (EPSG:3826), TWVD2001 vertical | [data.gov.tw/dataset/176927](https://data.gov.tw/dataset/176927) |
| Township / district boundaries | Shapefile (polygon) | GCS TWD97 geographic (degrees) | [data.gov.tw/dataset/7441](https://data.gov.tw/dataset/7441) |

---

## Architecture

```
raw/taipei/*.grd          line/TOWN_MOI_*.shp
       │                          │
  dtm_to_glb.py            shp_to_json.py
       │                          │
output/taipei_20m.glb      output/boundaries.json
output/taipei_40m.glb
output/taipei_100m.glb
       │                          │
       └─────────── Vite dev server ──────────────┘
                         │
                   src/main.js (Three.js)
```

---

## Implemented Mechanisms

### 1. DTM → GLB Conversion (`dtm_to_glb.py`)

Each source tile is a plain-text GRD file with `(X, Y, Z)` triplets on a 20 m grid (TWD97 Easting,
Northing, TWVD2001 elevation). The pipeline:

1. **Grid assembly** — all tiles are concatenated and snapped onto a unified regular grid.
   Cells with at least one `NaN` corner are skipped, producing holes instead of bogus triangles.
2. **Decimation** — the `--step N` flag retains every Nth grid row/column, producing the three
   resolution variants (20 m / 40 m / 100 m) without re-loading raw tiles.
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

Three pre-baked meshes are switched automatically based on camera altitude above the terrain:

| Mesh | Spacing | Altitude trigger |
|------|---------|-----------------|
| `taipei_100m.glb` (~3 MB) | 100 m | > 8 000 m above terrain |
| `taipei_40m.glb` (~18 MB) | 40 m | 3 000 – 8 000 m |
| `taipei_20m.glb` (~71 MB) | 20 m | < 3 000 m |

The LOD check runs once every 60 render frames (after the intro animation completes).
Loaded geometries are cached in a `Map` so each resolution is fetched at most once per session.
Switching replaces the terrain `Group` in the scene; the shared `MeshStandardMaterial` is kept
alive across switches.

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

## Development Setup

This project uses [Nix flakes](https://nixos.wiki/wiki/Flakes) for reproducible environments
and [`just`](https://just.systems/) for task automation.

```sh
# Enter the dev shell (or use direnv)
nix develop

# Install npm dependencies
just install

# Generate terrain meshes (one-time; raw tiles required)
just convert-100m   # 100 m — ~3 MB,  fast web preview
just convert-fast   # 40 m  — ~18 MB, regional zoom
just convert        # 20 m  — ~71 MB, full detail

# Generate admin boundary JSON (requires output/taipei_100m.glb)
just convert-boundaries

# Start Vite dev server → http://localhost:8080
just dev
```

> **Note:** The dev server middleware serves `output/*.glb` and `output/boundaries.json`
> directly without a separate staging step. For a production build run `just build`.

---

## Controls

| Input | Action |
|-------|--------|
| Left-drag | Orbit (rotate around target) |
| Right-drag / Middle-drag | Pan |
| Scroll | Zoom |
| Double-click terrain | Set new orbit target |
| `R` | Reset camera |
| `T` | Top-down view |
| `Esc` | Close math modal |

---

## Project Layout

```
.
├── dtm_to_glb.py        # DTM tiles → GLB mesh (Python)
├── shp_to_json.py       # Shapefile boundaries → JSON (Python)
├── flake.nix            # Nix dev shell (Node 22, Python 3.13 + numpy/pyshp/pyproj)
├── justfile             # Task runner
├── vite.config.js       # Vite config + output/ middleware
├── index.html           # App shell
├── src/
│   ├── main.js          # Three.js scene, LOD, chunking, shaders, boundaries
│   └── style.css        # Dark UI styles
├── raw/taipei/          # Source DTM tiles (not committed)
├── line/                # Shapefile data (not committed)
└── output/              # Generated GLB + JSON files (not committed)
```

---

## License

Source code: MIT.
Terrain data: [CC BY 4.0](https://data.gov.tw/dataset/176927) — 國土測繪中心, 內政部.
Boundary data: [CC BY 4.0](https://data.gov.tw/dataset/7441) — 內政部國土管理署.
