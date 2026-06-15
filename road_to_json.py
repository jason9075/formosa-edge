#!/usr/bin/env python3
"""Convert road centreline shapefile (EPSG:3826) to Three.js LineSegments JSON.

The shapefile is already in TWD97 TM2 zone 121 (EPSG:3826, metres);
no coordinate reprojection is needed.

Road class mapping (ROADCLASS1):
  H*       → highway    國道 / national freeway
  1E       → expressway 快速公路
  1U, 1W   → provincial 省道

Output JSON (per-class array of polyline strips):
  { "highway": [[x0,z0,x1,z1,...], [...]], "expressway": [...], "provincial": [...] }

Each inner array is one polyline as a flat XZ strip (no vertex duplication — half the
size of the old edge-pair format). The viewer expands each strip into edge pairs and
merges a class into a single LineSegments2 (one draw call/class); the road Group is
lifted by roadGroup.position.y.

Usage:
  python3 road_to_json.py raw/road/ROAD_*.shp output/taipei_100m.glb output/roads.json
"""

import argparse
import json
import struct
from pathlib import Path

import shapefile
from shapely.geometry import LineString


def read_glb_meta(glb_path: Path) -> dict:
    with open(glb_path, 'rb') as f:
        f.read(12)
        json_len = struct.unpack('<I', f.read(4))[0]
        f.read(4)
        data = json.loads(f.read(json_len))
    extras = data.get('extras', {})
    # Resolve the POSITION accessor via the primitive (Draco compression reorders
    # accessors, so index 0 is not necessarily POSITION). POSITION always carries
    # min/max per the glTF spec.
    pos_idx = data['meshes'][0]['primitives'][0]['attributes']['POSITION']
    acc = data['accessors'][pos_idx]
    return {
        'x_center': float(extras.get('x_center', 0)),
        'y_center': float(extras.get('y_center', 0)),
        'glb_xmin': float(acc['min'][0]),
        'glb_xmax': float(acc['max'][0]),
        'glb_zmin': float(acc['min'][2]),
        'glb_zmax': float(acc['max'][2]),
    }


def classify(roadclass1: str) -> str:
    if roadclass1.startswith('H'):
        return 'highway'
    if roadclass1 == '1E':
        return 'expressway'
    return 'provincial'


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Road shapefile (EPSG:3826) → Three.js LineSegments JSON.',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument('shapefile', type=Path, help='.shp path (EPSG:3826, metres)')
    parser.add_argument('glb',       type=Path, help='Reference terrain .glb for coordinate origin')
    parser.add_argument('output',    type=Path, help='Output .json path')
    parser.add_argument('--margin',  type=float, default=1000, metavar='M',
                        help='Extra metres around terrain bbox to include')
    parser.add_argument('--simplify', type=float, default=1.0, metavar='M',
                        help='Douglas-Peucker tolerance in metres (0 = off); '
                             'coords are also rounded to 1 m integers')
    args = parser.parse_args()

    print('Reading GLB metadata…')
    meta = read_glb_meta(args.glb)
    xc, yc = meta['x_center'], meta['y_center']

    # Terrain extent in EPSG:3826 metres (same CRS as shapefile — no transform needed)
    E_min = meta['glb_xmin'] + xc - args.margin
    E_max = meta['glb_xmax'] + xc + args.margin
    N_min = -meta['glb_zmax'] + yc - args.margin
    N_max = -meta['glb_zmin'] + yc + args.margin
    print(f'  Terrain extent: E[{E_min:.0f}, {E_max:.0f}]  N[{N_min:.0f}, {N_max:.0f}]')
    print(f'  Origin centroid: x_center={xc:.1f}  y_center={yc:.1f}')

    print(f'Reading {args.shapefile.name}…')
    sf = shapefile.Reader(str(args.shapefile))
    fields = [f[0] for f in sf.fields[1:]]
    i_cls = fields.index('ROADCLASS1')
    print(f'  Total records: {len(sf.shapes()):,}')

    buckets: dict[str, list[list[float]]] = {'highway': [], 'expressway': [], 'provincial': []}
    skipped = 0

    for sr in sf.iterShapeRecords():
        shp = sr.shape
        if shp.shapeType == 0 or not shp.points:
            continue

        cls = classify(sr.record[i_cls])
        buf = buckets[cls]

        part_starts = list(shp.parts) + [len(shp.points)]
        for pi in range(len(part_starts) - 1):
            pts = shp.points[part_starts[pi]:part_starts[pi + 1]]
            if len(pts) < 2:
                continue

            # Bbox filter in EPSG:3826 metres
            es = [p[0] for p in pts]
            ns = [p[1] for p in pts]
            if max(es) < E_min or min(es) > E_max or max(ns) < N_min or min(ns) > N_max:
                skipped += 1
                continue

            # Douglas-Peucker drop near-collinear vertices (1 m tolerance) in EPSG:3826
            # metres, before mapping to local space.
            if args.simplify > 0:
                pts = list(LineString(pts).simplify(args.simplify, preserve_topology=False).coords)
                if len(pts) < 2:
                    continue

            # Three.js coordinate mapping (same as GLB vertices), as a polyline strip:
            #   X =  Easting  - x_center        Z = -(Northing - y_center)
            # round() → 1 m integers (no ".x" decimals → smaller JSON)
            strip = []
            for p in pts:
                strip.append(round(p[0] - xc))
                strip.append(round(-(p[1] - yc)))
            if len(strip) >= 4:  # ≥ 2 points
                buf.append(strip)

    total_pts = 0
    for cls, buf in buckets.items():
        pts = sum(len(s) // 2 for s in buf)
        total_pts += pts
        print(f'  {cls:12s}: {len(buf):,} polylines, {pts:,} points')
    print(f'  Skipped {skipped} parts outside extent')
    print(f'  Total points: {total_pts:,}')

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(buckets, separators=(',', ':')), encoding='utf-8')
    size_kb = args.output.stat().st_size / 1024
    print(f'Output: {args.output}  ({size_kb:.1f} KB)')


if __name__ == '__main__':
    main()
