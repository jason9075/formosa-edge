#!/usr/bin/env python3
"""Slice the merged DTM into streamable 20 m detail tiles + an index.

Builds one global 20 m grid from all source points, computes normals on that
global grid (so shading is continuous across tile borders), then cuts it into
fixed-size square tiles with a 1-cell overlap (adjacent tiles share their
boundary row/column → no geometric cracks). Each non-empty tile is written as a
GLB whose vertices are baked against a SHARED centre — read from the base
overview GLB so detail tiles align exactly on top of it.

Usage:
  python3 tile_dtm.py raw output/tiles --center-glb output/taiwan_100m.glb
  python3 tile_dtm.py raw/taipei output/tiles --center-glb output/taiwan_100m.glb --tile-size 5000
"""

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

from dtm_to_glb import build_faces, build_grid, compute_normals, load_tiles, write_glb


def center_from_glb(glb_path: Path) -> tuple[float, float]:
    """Read (x_center, y_center) from a GLB's JSON-chunk extras."""
    with open(glb_path, 'rb') as f:
        f.seek(12)  # skip 12-byte GLB header
        json_len = struct.unpack('<I', f.read(4))[0]
        f.read(4)   # chunk type
        meta = json.loads(f.read(json_len)).get('extras', {})
    return float(meta['x_center']), float(meta['y_center'])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input_dir', type=Path, help='Dir with .grd/.hdr (rglob, merges counties)')
    ap.add_argument('out_dir', type=Path, help='Output dir for tile GLBs + index.json')
    ap.add_argument('--tile-size', type=int, default=5000, metavar='M',
                    help='Tile edge length in metres (must be a multiple of grid spacing)')
    ap.add_argument('--center-glb', type=Path, default=None,
                    help='Reference GLB to copy x_center/y_center from (for base alignment)')
    ap.add_argument('--step', type=int, default=1, metavar='N',
                    help='Decimation within each tile: every Nth sample (5 = 100 m base tiles)')
    ap.add_argument('--skirt', type=float, default=0.0, metavar='M',
                    help='Vertical skirt depth (metres) to hide LOD-boundary cracks')
    ap.add_argument('--z-scale', type=float, default=1.0)
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    print('=== Loading tiles ===')
    pts, spacing = load_tiles(args.input_dir)
    if args.center_glb:
        x_center, y_center = center_from_glb(args.center_glb)
        print(f'Shared centre from {args.center_glb.name}: ({x_center:.2f}, {y_center:.2f})')
    else:
        x_center, y_center = float(pts[:, 0].mean()), float(pts[:, 1].mean())

    cells = int(round(args.tile_size / spacing))
    if abs(cells * spacing - args.tile_size) > 1e-6:
        sys.exit(f'tile-size {args.tile_size} not a multiple of spacing {spacing}')

    print('\n=== Building global 20 m grid ===')
    x_grid, y_grid, Z = build_grid(pts, spacing, step=1)
    del pts
    rows, cols = Z.shape

    print('\n=== Computing global normals ===')
    normals = compute_normals(x_grid, y_grid, Z)  # (rows, cols, 3) — continuous across tiles

    print(f'\n=== Slicing into {args.tile_size:.0f} m tiles ({cells} cells, +1 overlap) ===')
    n_tx = (cols + cells - 1) // cells
    n_ty = (rows + cells - 1) // cells
    index_tiles: list[dict] = []
    written = 0

    for ty in range(n_ty):
        for tx in range(n_tx):
            r0, c0 = ty * cells, tx * cells
            r1 = min(r0 + cells + 1, rows)  # +1 cell overlap → shared boundary samples
            c1 = min(c0 + cells + 1, cols)
            if r1 - r0 < 2 or c1 - c0 < 2:
                continue

            subZ = Z[r0:r1, c0:c1]
            subN = normals[r0:r1, c0:c1]
            subX, subY = x_grid[c0:c1], y_grid[r0:r1]
            if args.step > 1:
                # Decimate within the tile (cells % step == 0 keeps the shared boundary
                # sample, so same-level tiles stay seamless). 5 = 100 m base tiles.
                subZ = subZ[::args.step, ::args.step]
                subN = subN[::args.step, ::args.step]
                subX = subX[::args.step]
                subY = subY[::args.step]
            if np.isnan(subZ).all():
                continue
            faces = build_faces(subZ)
            if faces.size == 0:  # only no-data corners → no triangles
                continue

            key = f'{tx}_{ty}'
            out_path = args.out_dir / f'{key}.glb'
            write_glb(subX, subY, subZ, subN, faces, x_center, y_center,
                      args.z_scale, out_path, skirt=args.skirt)

            # Local-space (GLB) tile centre for the frontend's visibility test.
            cx = float((subX[0] + subX[-1]) * 0.5 - x_center)
            cz = float(-((subY[0] + subY[-1]) * 0.5 - y_center))
            index_tiles.append({'key': key, 'url': f'tiles/{key}.glb', 'cx': round(cx, 1), 'cz': round(cz, 1)})
            written += 1

    index = {
        'center': [round(x_center, 2), round(y_center, 2)],
        'zScale': args.z_scale,
        'tileSize': args.tile_size,
        'spacing': spacing,
        'tiles': index_tiles,
    }
    (args.out_dir / 'index.json').write_text(json.dumps(index, separators=(',', ':')))
    print(f'\nWrote {written} tiles + index.json to {args.out_dir}')


if __name__ == '__main__':
    main()
