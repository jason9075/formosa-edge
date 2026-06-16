#!/usr/bin/env python3
"""Convert river-area polygons (riverpoly.shp) into a flat water-surface GLB.

PoC stage: clips river polygons to the reference DTM extent (e.g. raw/taipei),
triangulates each polygon (holes handled) with earcut, samples the 20 m DTM so
the water surface clamps onto terrain (bank elevation), and writes a single
merged GLB for visual alignment checks.

The shapefile is already EPSG:3826 (TWD97 / TM2 zone 121, metres) — same frame
as the terrain GLB — so no reprojection is needed (unlike shp_to_json.py).

Coordinate mapping (per vertex):
  GLB x =  E - x_center
  GLB y =  DTM_height(E, N) + lift
  GLB z = -(N - y_center)

Usage:
  python3 rivers_to_glb.py raw/river/riverpoly/riverpoly.shp output/rivers_poc.glb \
      --dtm raw/taipei --center-glb output/taiwan_100m.glb --types 1 2 3 4
"""

import argparse
import json
import sys
from pathlib import Path

import mapbox_earcut as earcut
import numpy as np
import shapefile
from shapely.geometry import box as shapely_box, shape

from buildings_to_glb import (
    TILE,
    TerrainSampler,
    _merge_write,
    center_from_glb,
    flat_mesh,
    write_mesh_glb,
)


def _iter_polygons(geom):
    """Recursively yield bare shapely Polygons from any geometry.

    A tile-clip intersection may return Polygon / MultiPolygon / GeometryCollection
    (the last can also hold touching LineStrings / Points, which are skipped)."""
    gt = geom.geom_type
    if gt == 'Polygon':
        if not geom.is_empty:
            yield geom
    elif gt in ('MultiPolygon', 'GeometryCollection'):
        for g in geom.geoms:
            yield from _iter_polygons(g)


def triangulate(poly) -> tuple[np.ndarray, np.ndarray]:
    """Triangulate one shapely Polygon (with holes) → (verts Nx2 E/N, faces Mx3).

    earcut adds no Steiner points — output triangles reference only the input
    boundary vertices, so every vertex lies on a ring and can be DTM-sampled."""
    ext = np.asarray(poly.exterior.coords[:-1], dtype=np.float64)  # drop closing dup
    parts = [ext]
    ring_ends = [len(ext)]
    for interior in poly.interiors:
        h = np.asarray(interior.coords[:-1], dtype=np.float64)
        parts.append(h)
        ring_ends.append(ring_ends[-1] + len(h))

    verts = np.concatenate(parts, axis=0)
    idx = earcut.triangulate_float64(verts, np.asarray(ring_ends, dtype=np.uint32))
    return verts, idx.reshape(-1, 3).astype(np.uint32)


def polygon_water_z(poly, sampler, radius, pct, lift):
    """Flat water elevation for one polygon: a percentile of its boundary bank
    heights (+lift). Computed from the FULL polygon so the level stays consistent
    when the polygon is later clipped across tile seams. None = no bank in range."""
    pts = list(poly.exterior.coords)
    for interior in poly.interiors:
        pts += list(interior.coords)
    hs = [h for h in (sampler.height(e, n, radius=radius) for e, n in pts) if h is not None]
    if not hs:
        return None
    return float(np.percentile(hs, pct)) + lift


def clamp(verts2d: np.ndarray, water_z: float, xc: float, yc: float) -> np.ndarray:
    """(E, N) boundary verts → GLB world space at a flat water height."""
    gx = verts2d[:, 0] - xc
    gy = np.full(len(verts2d), water_z, dtype=np.float64)
    gz = -(verts2d[:, 1] - yc)
    return np.stack([gx, gy, gz], axis=-1).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('shapefile', type=Path, help='riverpoly.shp (EPSG:3826)')
    ap.add_argument('output', type=Path, help='Output .glb')
    ap.add_argument('--dtm', type=Path, required=True, help='20 m DTM dir (clip + clamp)')
    ap.add_argument('--center-glb', type=Path, required=True, help='Reference GLB for x/y_center')
    ap.add_argument('--types', type=int, nargs='+', default=[1, 2, 3, 4],
                    help='RIVER_TYPE values to keep (default: 1 2 3 4 — drops type 5 noise)')
    ap.add_argument('--lift', type=float, default=1.0, metavar='M',
                    help='Raise water plane above sampled bank height (anti z-fight)')
    ap.add_argument('--water-pct', type=float, default=50, metavar='P',
                    help='Percentile of boundary bank heights used as the flat water '
                         'level (50=median; raise to fill higher up the banks)')
    ap.add_argument('--radius', type=int, default=25, metavar='CELLS',
                    help='Nearest-valid DTM search radius in 20 m cells (25=500 m); '
                         'wide rivers need a large window to reach a valid bank')
    ap.add_argument('--simplify', type=float, default=2.0, metavar='M',
                    help='Douglas-Peucker tolerance in metres (0 = off)')
    ap.add_argument('--margin', type=float, default=2000, metavar='M',
                    help='Extra metres around DTM extent to include')
    ap.add_argument('--tiled', action='store_true',
                    help='Clip polygons to the 5 km grid → per-tile GLBs + index.json')
    ap.add_argument('--dtm-step', type=int, default=1, metavar='N',
                    help='DTM decimation for the height grid (5 = 100 m; use for the '
                         'whole island — a 20 m island-wide grid is too heavy)')
    args = ap.parse_args()

    x_center, y_center = center_from_glb(args.center_glb)
    print(f'Centre: ({x_center:.2f}, {y_center:.2f})')

    print(f'\n=== Building terrain sampler (step {args.dtm_step}) ===')
    sampler = TerrainSampler(args.dtm, step=args.dtm_step)
    # DTM extent in TWD97 → clip bounds
    e_lo = sampler.x0 - args.margin
    e_hi = sampler.x0 + sampler.cols * sampler.spacing + args.margin
    n_lo = sampler.y0 - args.margin
    n_hi = sampler.y0 + sampler.rows * sampler.spacing + args.margin
    print(f'  Clip extent: E[{e_lo:.0f}, {e_hi:.0f}]  N[{n_lo:.0f}, {n_hi:.0f}]')

    print(f'\n=== Reading {args.shapefile} (types {args.types}) ===')
    sf = shapefile.Reader(str(args.shapefile), encoding='utf-8')
    keep_types = set(args.types)
    type_idx = [f[0] for f in sf.fields[1:]].index('RIVER_TYPE')

    # Each kept sub-polygon → its flat water level, ready to triangulate (single GLB)
    # or clip against the tile grid (--tiled). Water level is per-polygon so it stays
    # consistent across tile seams.
    polys: list[tuple] = []  # (shapely Polygon, water_z)
    n_skip_type = n_skip_clip = 0

    for sr in sf.iterShapeRecords():
        if sr.record[type_idx] not in keep_types:
            n_skip_type += 1
            continue
        bx0, by0, bx1, by1 = sr.shape.bbox
        if bx1 < e_lo or bx0 > e_hi or by1 < n_lo or by0 > n_hi:
            n_skip_clip += 1
            continue

        geom = shape(sr.shape.__geo_interface__)
        if args.simplify > 0:
            geom = geom.simplify(args.simplify, preserve_topology=True)
        for poly in _iter_polygons(geom):
            if len(poly.exterior.coords) < 4:
                continue
            water_z = polygon_water_z(poly, sampler, args.radius, args.water_pct, args.lift)
            if water_z is None:
                n_skip_clip += 1  # entirely over no-data, no bank within radius
                continue
            polys.append((poly, water_z))

    print(f'  Kept {len(polys)} polygons | skipped: {n_skip_type} type, '
          f'{n_skip_clip} out-of-extent/no-bank')
    if not polys:
        sys.exit('No river polygons in extent.')

    if not args.tiled:
        all_verts, all_faces, vbase, n_tri_fail = [], [], 0, 0
        for poly, water_z in polys:
            try:
                verts2d, faces = triangulate(poly)
            except Exception:  # noqa: BLE001 — robust batch
                n_tri_fail += 1
                continue
            if len(faces) == 0:
                continue
            world = clamp(verts2d, water_z, x_center, y_center)
            all_verts.append(world)
            all_faces.append(faces + vbase)
            vbase += len(world)
        print(f'\n=== Flat-shading + writing GLB ({n_tri_fail} tri-fail) ===')
        positions = np.concatenate(all_verts, axis=0)
        faces = np.concatenate(all_faces, axis=0).astype(np.uint32)
        fpos, fnor, fidx = flat_mesh(positions, faces)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        write_mesh_glb(fpos, fnor, fidx, x_center, y_center, args.output)
        return

    # ── Tiled: clip each polygon to the 5 km grid (shared keys with terrain/buildings) ──
    print(f'\n=== Clipping into {TILE} m tiles → {args.output} ===')
    groups: dict[str, list] = {}
    n_tri_fail = 0
    for poly, water_z in polys:
        bx0, by0, bx1, by1 = poly.bounds
        for ti in range(int(bx0 // TILE), int(bx1 // TILE) + 1):
            for tj in range(int(by0 // TILE), int(by1 // TILE) + 1):
                cell = shapely_box(ti * TILE, tj * TILE, (ti + 1) * TILE, (tj + 1) * TILE)
                clip = poly.intersection(cell)
                for sub in _iter_polygons(clip):
                    if len(sub.exterior.coords) < 4:
                        continue
                    try:
                        verts2d, faces = triangulate(sub)
                    except Exception:  # noqa: BLE001
                        n_tri_fail += 1
                        continue
                    if len(faces) == 0:
                        continue
                    world = clamp(verts2d, water_z, x_center, y_center)
                    groups.setdefault(f'{ti}_{tj}', []).append((world, faces))

    args.output.mkdir(parents=True, exist_ok=True)
    index_tiles = []
    for key, pieces in sorted(groups.items()):
        _merge_write(pieces, x_center, y_center, args.output / f'{key}.glb')
        ti, tj = (int(p) for p in key.split('_'))
        cx = (ti + 0.5) * TILE - x_center
        cz = -((tj + 0.5) * TILE - y_center)
        index_tiles.append({'key': key, 'url': f'{args.output.name}/{key}.glb',
                            'cx': round(cx, 1), 'cz': round(cz, 1)})

    index = {'center': [round(x_center, 2), round(y_center, 2)],
             'tileSize': TILE, 'tiles': index_tiles}
    (args.output / 'index.json').write_text(json.dumps(index, separators=(',', ':')))
    print(f'\nWrote {len(index_tiles)} tiles + index.json ({n_tri_fail} tri-fail)')


if __name__ == '__main__':
    main()
