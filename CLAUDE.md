# CLAUDE.md — DTM Visualizer

Project-specific guidance for Claude Code. See `README.md` for the full mechanism write-up.

## What this is

Browser 3D terrain viewer for Taiwan's **main island** (19 counties merged into one map),
Three.js + Vite frontend, offline Python pipeline that turns government 20 m DTM tiles into GLB.

## Pipeline (offline, Python)

- `scripts/fetch_dtm.py` — downloads + extracts per-county DTM zips listed in
  `scripts/dtm_sources.csv` (TGOS 2025 catalogue) into `raw/<slug>/`. Uses **curl** (Python's
  OpenSSL rejects the tgos.tw cert: "Missing Subject Key Identifier"). `--main-island` excludes
  outlying islands. → `just fetch`
- `dtm_to_glb.py` — `rglob`s `raw/**/*.hdr`, so pointing it at `raw/` merges all counties into one
  **shared-centre** mesh. Drops no-data/sea vertices (compaction). `--step 5` = 100 m base. → `just convert-100m`
- `tile_dtm.py` — builds a global 20 m grid + normals, slices into 5 km tiles with **+1 cell
  overlap** (seamless edges), baked against `taiwan_100m.glb`'s centre. → `just tile`
- `shp_to_json.py` / `road_to_json.py` — overlays, clipped to the reference GLB's extent.
- Draco compression is a separate step (`gltf-pipeline`): `just compress-glb`, and `just tile`
  compresses tiles in-place.

## Frontend (`src/main.js`)

- **Two-level tiled LOD + stencil-masked backdrop** (`updateTiles` in the animate loop). The
  monolithic `taiwan_100m.glb` is **always visible as a backdrop**. Far (camera > `FAR_ALT` 20 km)
  → tiles unloaded. Near → stream **one tile per visible cell**: 20 m (`tiles/`) within
  `DETAIL_DIST` 18 km of the camera, else 100 m (`base_tiles/`) out to `BASE_DIST` 70 km.
  Frustum-based, nearest-first, caps 160/320, `LOD_HYST` anti-thrash. Tiles coloured against the
  base global range (`colorTileGeometry`).
- **Stencil**: tiles render first (renderOrder 0) and write `stencil=1`; backdrop (renderOrder 1)
  tests `stencil != 1` so it's hidden under tiles (no overlap/poke-through) but FILLS streaming
  gaps with the 100 m surface — without the backdrop, panning showed black where tiles hadn't
  loaded yet. `stencilWrite=true` is three.js's master switch ENABLING the stencil test
  (`false` disables it). `logarithmicDepthBuffer: true` for depth precision.
- Note: with the backdrop restored the 100 m `base_tiles` are largely redundant (identical to the
  backdrop); kept per the user's "tile the 100m" request. **Skirts** (`tile_dtm.py --skirt 120`)
  exist but matter less now (the backdrop fills cracks too). History (git): polygonOffset → stencil
  (broke on `stencilWrite=false`) → pure tiling (black gaps when sliding, no backdrop) → this.
- The old altitude-switched multi-mesh LOD (`lodCache`/`lodGroupCache`/`switchLod`) is retained but
  the merged map uses one base level. Camera far plane is 1,000,000 (full island ~400 km N–S).

## Key decisions / constraints

- **Outlying islands excluded** (Penghu/Kinmen/Lienchiang): too far offshore to merge into one mesh.
- **Full 20 m island as one mesh is not web-viable** (~90 M verts) — hence the base + detail-tile split.
- **Known source gap**: ~12×13 km void over Xueshan/Shei-Pa peaks (≈ TWD97 E 257 480, N 2 711 390).
  No source tile covers it — renders as a square hole. **Left as-is** by decision. To fill: interpolate
  the `NaN` region in `dtm_to_glb.py`, or splice the "不分幅_全台" combined dataset.

## Deploy / size caveat

- `raw/`, `output/`, `line/`, `*.zip` are gitignored. Deployed assets live in `public/` (force-tracked).
- **Detail tiles (~184 MB, 1581 files) are NOT staged into `public/`** — would bloat git. `just dev`
  serves them from `output/` via Vite middleware (no staging). For production decide: Git LFS /
  external host / CI generation, then `just stage` (copies `output/tiles/ → public/tiles/`).

## Conventions

- NixOS: `nix develop` / direnv for the shell; `just` for all tasks. No global `pip`/`apt`.
- `/usr/bin/time` does not exist here; don't use it.
- Commit only when asked; conventional-commit messages.
