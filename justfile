data_dir := "raw/taipei"
out_dir  := "output"

# List available targets
default:
    @just --list

# Full resolution 20m — ~65 MB, production quality
convert:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taipei_20m.glb

# 40m decimated — ~18 MB, fast preview
convert-fast:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taipei_40m.glb --step 2

# 40m + 2× elevation exaggeration — better visual depth for flat areas
convert-exag:
    python3 dtm_to_glb.py {{data_dir}} {{out_dir}}/taipei_exag.glb --step 2 --z-scale 2.0

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

# Clean generated outputs
clean:
    rm -f {{out_dir}}/*.glb
