data_dir := "raw"
out_dir  := "output"
csv      := "scripts/dtm_sources.csv"

set shell := ["sh", "-c"]

default:
    @just --list

# ── DTM acquisition ──────────────────────────────────────────────────────────────

# Download + extract all 19 main-island counties from the TGOS catalogue → raw/<slug>/
fetch:
    python3 scripts/fetch_dtm.py {{csv}} --out {{data_dir}} --main-island --skip-existing

# ── DTM conversion (merged main island) ──────────────────────────────────────────
# dtm_to_glb.py rglobs all raw/<county>/*.hdr → one shared-centre mesh. A full 20 m
# island mesh is not web-viable (~90 M verts), hence the 100 m backdrop + detail tiles.

# 100 m decimated merged-island overview → taiwan_100m.glb (always-visible backdrop; ~7 MB draco)
convert-100m:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taiwan_100m.glb --step 5

# Slice the island into streamable 20 m (tiles/) + 100 m (base_tiles/) LOD tiles, draco-compressed
tile:
    @[ -d node_modules ] || npm install --ignore-scripts
    python3 tile_dtm.py {{data_dir}} {{out_dir}}/tiles      --center-glb {{out_dir}}/taiwan_100m.glb --tile-size 5000 --skirt 120
    python3 tile_dtm.py {{data_dir}} {{out_dir}}/base_tiles --center-glb {{out_dir}}/taiwan_100m.glb --tile-size 5000 --step 5 --skirt 120
    @echo "Draco-compressing tiles…"
    @ls {{out_dir}}/tiles/*.glb {{out_dir}}/base_tiles/*.glb | xargs -P 8 -I{} node node_modules/.bin/gltf-pipeline -i {} -o {} --draco.compressionLevel 7 >/dev/null 2>&1
    @echo "Detail: $(ls {{out_dir}}/tiles/*.glb | wc -l) files, $(du -sh {{out_dir}}/tiles | cut -f1)  |  Base: $(ls {{out_dir}}/base_tiles/*.glb | wc -l) files, $(du -sh {{out_dir}}/base_tiles | cut -f1)"

# Taipei 3D building KMZ → massing (building_tiles/) + AABB-box LOD (building_boxes/) tiles, draco
buildings:
    @[ -d node_modules ] || npm install --ignore-scripts
    python3 buildings_to_glb.py {{data_dir}}/buildings/kmzs {{out_dir}}/building_tiles --dtm {{data_dir}}/taipei --center-glb {{out_dir}}/taiwan_100m.glb --mode massing --tiled
    python3 buildings_to_glb.py {{data_dir}}/buildings/kmzs {{out_dir}}/building_boxes --dtm {{data_dir}}/taipei --center-glb {{out_dir}}/taiwan_100m.glb --mode box --tiled
    @echo "Draco-compressing building tiles…"
    @ls {{out_dir}}/building_tiles/*.glb {{out_dir}}/building_boxes/*.glb | xargs -P 8 -I{} node node_modules/.bin/gltf-pipeline -i {} -o {} --draco.compressionLevel 7 >/dev/null 2>&1
    @echo "Massing: $(ls {{out_dir}}/building_tiles/*.glb | wc -l) files, $(du -sh {{out_dir}}/building_tiles | cut -f1)  |  Box: $(du -sh {{out_dir}}/building_boxes | cut -f1)"

# River polygons (type 1–4) → 5 km flat water-surface tiles (river_tiles/), draco-compressed
rivers:
    @[ -d node_modules ] || npm install --ignore-scripts
    python3 rivers_to_glb.py "raw/river/riverpoly/riverpoly.shp" {{out_dir}}/river_tiles --dtm {{data_dir}} --center-glb {{out_dir}}/taiwan_100m.glb --types 1 2 3 4 --tiled --dtm-step 5
    @echo "Draco-compressing river tiles…"
    @ls {{out_dir}}/river_tiles/*.glb | xargs -P 8 -I{} node node_modules/.bin/gltf-pipeline -i {} -o {} --draco.compressionLevel 7 >/dev/null 2>&1
    @echo "Rivers: $(ls {{out_dir}}/river_tiles/*.glb | wc -l) files, $(du -sh {{out_dir}}/river_tiles | cut -f1)"

# Clip terrain + buildings to a WGS84 box → one standalone GLB (terrain + buildings nodes).
# Needs built output/tiles + output/building_tiles. Coords: SW/NE as "LAT LON".
# Example: just merge-region 25.05787 121.56175 25.06124 121.56572 output/region_xinyi.glb
merge-region sw_lat sw_lon ne_lat ne_lon out="output/region.glb":
    @[ -d node_modules ] || npm install --ignore-scripts
    python3 merge_region_glb.py \
        --tiles {{out_dir}}/tiles --buildings {{out_dir}}/building_tiles \
        --sw {{sw_lat}} {{sw_lon}} --ne {{ne_lat}} {{ne_lon}} \
        --out {{out}} --draco --recenter

# Draco-compress every output/*.glb in place (run after convert-100m; tile/buildings/rivers self-compress)
compress-glb:
    @[ -d node_modules ] || npm install --ignore-scripts
    @for glb in output/*.glb; do \
        [ -f "$$glb" ] || continue; \
        echo "Compressing $$glb …"; \
        node node_modules/.bin/gltf-pipeline -i "$$glb" -o "$$glb" --draco.compressionLevel 7; \
    done

# Copy the three.js Draco decoder WASM → public/draco/ (commit alongside code)
stage-draco:
    mkdir -p public/draco
    cp node_modules/three/examples/jsm/libs/draco/draco_decoder.wasm public/draco/
    cp node_modules/three/examples/jsm/libs/draco/draco_wasm_wrapper.js public/draco/
    cp node_modules/three/examples/jsm/libs/draco/draco_decoder.js public/draco/
    @echo "Draco decoder staged to public/draco/"

# Road centrelines shapefile → output/roads.json, terrain height baked per vertex (--dtm, no runtime clamp)
convert-roads:
    python3 road_to_json.py "raw/road/ROAD_國省道(含快速公路)_1150409.shp" output/taiwan_100m.glb output/roads.json --dtm {{data_dir}} --dtm-step 2

# Township boundaries shapefile → output/boundaries.json, draped on terrain (--dtm 3D rings + names)
convert-boundaries:
    python3 shp_to_json.py line/TOWN_MOI_1140318.shp output/taiwan_100m.glb output/boundaries.json --simplify 5 --dtm {{data_dir}} --dtm-step 2

# Clean generated GLB outputs
clean:
    rm -f {{out_dir}}/*.glb

# ── Frontend (Three.js / Vite) ──────────────────────────────────────────────────

# Install npm dependencies (--ignore-scripts avoids esbuild postinstall on noexec)
install:
    npm install --ignore-scripts

# Copy all deploy assets output/ → public/ (GLBs, JSON overlays, every tile dir) before committing for Pages
stage:
    mkdir -p public
    @for glb in {{out_dir}}/*.glb; do \
        [ -f "$$glb" ] && cp "$$glb" "public/$$(basename $$glb)" && echo "Staged $$glb"; \
    done || true
    @for json in {{out_dir}}/*.json; do \
        [ -f "$$json" ] && cp "$$json" "public/$$(basename $$json)" && echo "Staged $$json"; \
    done || true
    @for d in tiles base_tiles building_tiles building_boxes river_tiles; do \
        [ -d "{{out_dir}}/$$d" ] && rm -rf "public/$$d" && cp -r "{{out_dir}}/$$d" "public/$$d" \
            && echo "Staged $$d ($$(find public/$$d -name '*.glb' | wc -l) glb)"; \
    done || true
    @echo "public/ total: $(du -sh public | cut -f1)"

# Start the Vite dev server on :8080 (serves output/ assets directly — no staging needed)
dev:
    @[ -d node_modules ] || npm install --ignore-scripts
    @echo "\033[36m[dtm-visualizer] Vite dev server → http://localhost:8080\033[0m"
    node --require ./scripts/fix-noexec.cjs ./node_modules/vite/bin/vite.js --port 8080

# Production build → dist/
build:
    @[ -d node_modules ] || npm install --ignore-scripts
    node --require ./scripts/fix-noexec.cjs ./node_modules/vite/bin/vite.js build

# Preview production build on :8080
preview: build
    node --require ./scripts/fix-noexec.cjs ./node_modules/vite/bin/vite.js preview --port 8080

# Remove all build artifacts and node_modules
clean-all: clean
    rm -rf dist node_modules
