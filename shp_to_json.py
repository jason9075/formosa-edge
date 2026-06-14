#!/usr/bin/env python3
"""Extract township boundary rings from a shapefile and write JSON for Three.js overlay.

The shapefile CRS (GCS_TWD97[2020], degrees) is reprojected to EPSG:3826
(TWD97 TM2 zone 121, metres) to match the terrain GLB coordinate space.

GLB coordinate mapping:
  Three.js X =  Easting  - x_center
  Three.js Z = -(Northing - y_center)

Usage:
  python3 shp_to_json.py line/TOWN_MOI_1140318.shp output/taipei_100m.glb output/boundaries.json
"""

import argparse
import json
import struct
import sys
from pathlib import Path

import shapefile
from pyproj import Transformer


def read_glb_meta(glb_path: Path) -> dict:
    """Read extras (x_center, y_center) and POSITION accessor bbox from GLB JSON chunk."""
    with open(glb_path, 'rb') as f:
        f.read(12)  # GLB header: magic + version + total_length
        json_len = struct.unpack('<I', f.read(4))[0]
        f.read(4)   # chunk type 0x4E4F534A (JSON)
        data = json.loads(f.read(json_len))

    extras = data.get('extras', {})
    acc    = data['accessors'][0]  # POSITION accessor always first

    return {
        'x_center': float(extras.get('x_center', 0)),
        'y_center': float(extras.get('y_center', 0)),
        # Terrain bbox in GLB local space
        'glb_xmin': float(acc['min'][0]),
        'glb_xmax': float(acc['max'][0]),
        'glb_zmin': float(acc['min'][2]),
        'glb_zmax': float(acc['max'][2]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Convert shapefile boundary rings to Three.js overlay JSON.',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument('shapefile', type=Path, help='.shp path (GCS_TWD97, degrees)')
    parser.add_argument('glb',       type=Path, help='Reference terrain .glb for coordinate origin')
    parser.add_argument('output',    type=Path, help='Output .json path')
    parser.add_argument(
        '--margin', type=float, default=2000,
        metavar='M', help='Extra metres around terrain bbox to include (default 2000)',
    )
    args = parser.parse_args()

    # ── Read GLB metadata ───────────────────────────────────────────────────────
    print('Reading GLB metadata…')
    meta   = read_glb_meta(args.glb)
    xc, yc = meta['x_center'], meta['y_center']

    # Convert GLB local bbox to TWD97 TM2 extent for filtering
    # GLB X = E - xc  →  E = GLB_X + xc
    # GLB Z = -(N-yc) →  N = -GLB_Z + yc
    E_min = meta['glb_xmin'] + xc - args.margin
    E_max = meta['glb_xmax'] + xc + args.margin
    N_min = -meta['glb_zmax'] + yc - args.margin
    N_max = -meta['glb_zmin'] + yc + args.margin
    print(f'  Terrain TWD97 extent: E[{E_min:.0f}, {E_max:.0f}]  N[{N_min:.0f}, {N_max:.0f}]')
    print(f'  Origin centroid: x_center={xc:.1f}  y_center={yc:.1f}')

    # ── Coordinate transformer ──────────────────────────────────────────────────
    # GCS_TWD97[2020] (lon/lat, degrees) → EPSG:3826 (TM2 metres)
    # always_xy=True ensures (lon, lat) input order regardless of CRS authority
    transformer = Transformer.from_crs('EPSG:4326', 'EPSG:3826', always_xy=True)

    # ── Read shapefile ──────────────────────────────────────────────────────────
    print(f'Reading {args.shapefile}…')
    sf     = shapefile.Reader(str(args.shapefile))
    fields = [f[0] for f in sf.fields[1:]]
    print(f'  Fields: {fields}')
    print(f'  Shapes: {len(sf.shapes())}')

    # Detect name field (内政部鄉鎮界常見欄位名)
    name_field = next(
        (f for f in ('TOWNNAME', 'COUNTYNAME', 'NAME', 'NAME_C') if f in fields),
        fields[0] if fields else None,
    )
    print(f'  Name field: {name_field}')

    # ── Process each shape ──────────────────────────────────────────────────────
    rings: list[list[list[float]]] = []
    names: list[str] = []
    skipped = 0

    for sr in sf.iterShapeRecords():
        shp = sr.shape
        rec = sr.record

        if shp.shapeType == 0:
            continue

        name = str(rec[fields.index(name_field)]) if name_field else ''

        # shapefile parts: each part is a separate ring (outer boundary or hole)
        part_starts = list(shp.parts) + [len(shp.points)]
        for pi in range(len(part_starts) - 1):
            pts = shp.points[part_starts[pi]:part_starts[pi + 1]]
            if len(pts) < 3:
                continue

            lons = [p[0] for p in pts]
            lats = [p[1] for p in pts]
            es, ns = transformer.transform(lons, lats)

            ring_E_min, ring_E_max = min(es), max(es)
            ring_N_min, ring_N_max = min(ns), max(ns)

            if (ring_E_max < E_min or ring_E_min > E_max or
                    ring_N_max < N_min or ring_N_min > N_max):
                skipped += 1
                continue

            # Convert to Three.js local space (same transform as GLB vertices)
            ring = [
                [round(float(e - xc), 1), round(float(-(n - yc)), 1)]
                for e, n in zip(es, ns)
            ]
            rings.append(ring)
            names.append(name)

    print(f'  Kept {len(rings)} rings, skipped {skipped} outside extent')

    # ── Write output ────────────────────────────────────────────────────────────
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = {'rings': rings, 'names': names}
    args.output.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    size_kb = args.output.stat().st_size / 1024
    print(f'Output: {args.output}  ({size_kb:.1f} KB, {len(rings)} rings)')


if __name__ == '__main__':
    main()
