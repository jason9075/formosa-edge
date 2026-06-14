data_dir := "raw/taipei"
out_dir  := "output"

set shell := ["sh", "-c"]

default:
    @just --list

# ── DTM conversion ──────────────────────────────────────────────────────────────

# Full resolution 20m — ~65 MB, production quality
convert:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taipei_20m.glb

# 40m decimated — ~18 MB, mid quality
convert-fast:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taipei_40m.glb --step 2

# 100m decimated — ~3 MB, default for web preview
convert-100m:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taipei_100m.glb --step 5

# Draco-compress all GLBs in output/ in-place (level 7 — good balance of size vs decode speed)
# Run after any convert-* target. Requires node_modules (just install).
compress-glb:
    @[ -d node_modules ] || npm install --ignore-scripts
    @for glb in output/taipei_100m.glb output/taipei_40m.glb output/taipei_20m.glb; do \
        [ -f "$$glb" ] || continue; \
        echo "Compressing $$glb …"; \
        node node_modules/.bin/gltf-pipeline -i "$$glb" -o "$$glb" --draco.compressionLevel 7; \
    done

# Copy Draco decoder WASM from three.js to public/draco/ (commit alongside code)
stage-draco:
    mkdir -p public/draco
    cp node_modules/three/examples/jsm/libs/draco/draco_decoder.wasm public/draco/
    cp node_modules/three/examples/jsm/libs/draco/draco_wasm_wrapper.js public/draco/
    cp node_modules/three/examples/jsm/libs/draco/draco_decoder.js public/draco/
    @echo "Draco decoder staged to public/draco/"

# Extract road centrelines from shapefile → output/roads.json
convert-roads:
    python3 road_to_json.py "raw/road/ROAD_國省道(含快速公路)_1150409.shp" output/taipei_100m.glb output/roads.json

# Extract township boundary rings from shapefile → output/boundaries.json
convert-boundaries:
    python3 shp_to_json.py line/TOWN_MOI_1140318.shp output/taipei_100m.glb output/boundaries.json

# 100m + 2× elevation exaggeration
convert-exag:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taipei_exag.glb --step 5 --z-scale 2.0

# Inspect a single tile header
inspect tile='97233072':
    @iconv -f cp950 -t utf8 {{data_dir}}/{{tile}}dem.hdr
    @echo "---"
    @head -3 {{data_dir}}/{{tile}}dem.grd
    @echo "..."
    @wc -l {{data_dir}}/{{tile}}dem.grd

# Show bounding box / metadata via GDAL (requires gdal in shell)
info tile='97233072':
    gdalinfo {{data_dir}}/{{tile}}dem.grd

# Clean generated GLB outputs
clean:
    rm -f {{out_dir}}/*.glb

# ── Frontend (Three.js / Vite) ──────────────────────────────────────────────────

# Install npm dependencies (--ignore-scripts avoids esbuild postinstall on noexec)
install:
    npm install --ignore-scripts

# Copy output GLBs + JSON overlays to public/ for Vite production builds
# (Dev mode serves output/ directly via vite.config.js middleware — no need to stage first)
stage:
    mkdir -p public
    @for glb in output/*.glb; do \
        [ -f "$$glb" ] && cp "$$glb" "public/$$(basename $$glb)" && echo "Staged $$glb"; \
    done || true
    @for json in output/*.json; do \
        [ -f "$$json" ] && cp "$$json" "public/$$(basename $$json)" && echo "Staged $$json"; \
    done || true

# Start Vite dev server on :8080
# GLB files are served from output/ transparently — run `just convert-fast` first
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
