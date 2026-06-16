#!/usr/bin/env python3
"""Convert Taiwan DTM .grd/.hdr tiles to a single .glb terrain mesh.

Header format (CP950):
  Line 1:  Region name
  Line 2:  Tile ID
  Line 3:  CRS (TWD97[2020])
  Line 4:  Vertical datum (TWVD2001)
  Line 6:  X grid spacing (meters)
  Line 7:  Y grid spacing (meters)
  Line 9:  Rows
  Line 10: Cols
  Line 11: X origin (TWD97 Easting)
  Line 12: Y origin (TWD97 Northing)

GRD format: plain text, 3 columns: X  Y  Z

Usage:
  python3 dtm_to_glb.py raw/taipei output/taipei.glb
  python3 dtm_to_glb.py raw/taipei output/taipei.glb --step 2 --z-scale 1.5
"""

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

HDR_ENCODING = 'cp950'


def parse_hdr(path: Path) -> dict:
    lines = path.read_bytes().decode(HDR_ENCODING, errors='replace').strip().splitlines()
    return {
        'name': lines[0],
        'tile_id': lines[1],
        'spacing': float(lines[5]),
        'rows': int(lines[8]),
        'cols': int(lines[9]),
        'x_origin': float(lines[10]),
        'y_origin': float(lines[11]),
    }


def load_tiles(data_dir: Path) -> tuple[np.ndarray, float]:
    """Load all GRD tiles; return (N×3 float64 array of X,Y,Z), grid spacing.

    Searches recursively (rglob), so a parent dir holding many per-county
    subdirs (e.g. raw/ with raw/taipei, raw/taichung, …) merges every county's
    tiles into one point cloud — and thus one shared-centre mesh.
    """
    hdr_files = sorted(data_dir.rglob('*.hdr'))
    if not hdr_files:
        raise FileNotFoundError(f'No .hdr files in {data_dir}')

    all_pts: list[np.ndarray] = []
    spacing = None

    for hdr_path in hdr_files:
        grd_path = hdr_path.with_suffix('.grd')
        if not grd_path.exists():
            print(f'  [skip] {grd_path.name} not found', file=sys.stderr)
            continue

        info = parse_hdr(hdr_path)
        if spacing is None:
            spacing = info['spacing']

        try:
            pts = np.loadtxt(grd_path, dtype=np.float64)
            if pts.ndim == 1:
                pts = pts.reshape(1, 3)
            all_pts.append(pts)
            print(f'  {grd_path.name}: {len(pts):,} pts')
        except Exception as exc:
            print(f'  [warn] {grd_path.name}: {exc}', file=sys.stderr)

    if not all_pts:
        raise RuntimeError('No tiles loaded')

    return np.concatenate(all_pts, axis=0), float(spacing)


def build_grid(pts: np.ndarray, spacing: float, step: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Project scattered points onto a regular 2D grid.

    Returns (x_grid, y_grid, Z) where Z[row, col] is elevation (NaN = no data).
    Rows correspond to y_grid (northing), cols to x_grid (easting).
    """
    x, y, z = pts[:, 0], pts[:, 1], pts[:, 2]

    # Snap extents to grid
    x_min = np.round(x.min() / spacing) * spacing
    x_max = np.round(x.max() / spacing) * spacing
    y_min = np.round(y.min() / spacing) * spacing
    y_max = np.round(y.max() / spacing) * spacing

    eff = spacing * step
    x_grid = np.arange(x_min, x_max + eff / 2, eff)
    y_grid = np.arange(y_min, y_max + eff / 2, eff)
    rows, cols = len(y_grid), len(x_grid)

    Z = np.full((rows, cols), np.nan, dtype=np.float32)

    # Grid indices for each point
    ix = np.round((x - x_min) / spacing).astype(np.int64)
    iy = np.round((y - y_min) / spacing).astype(np.int64)

    # Keep only points that land on the decimated step
    if step > 1:
        mask = (ix % step == 0) & (iy % step == 0)
        ix, iy, z = ix[mask], iy[mask], z[mask]
    ix //= step
    iy //= step

    valid = (ix >= 0) & (ix < cols) & (iy >= 0) & (iy < rows)
    Z[iy[valid], ix[valid]] = z[valid].astype(np.float32)

    nan_pct = np.isnan(Z).mean() * 100
    print(f'Grid {rows}×{cols} ({eff:.0f}m spacing), {nan_pct:.1f}% no-data')
    return x_grid, y_grid, Z


def compute_normals(x_grid: np.ndarray, y_grid: np.ndarray, Z: np.ndarray) -> np.ndarray:
    """Per-vertex surface normals via central differences.

    GLB coordinate space: X=East, Y=Up (elevation), Z=South (-Northing).
    Normal vector = normalize(-dz/dx, 1, dz/d(-y)) = normalize(-dz/dx, 1, -dz/dy).
    """
    dx = float(x_grid[1] - x_grid[0]) if len(x_grid) > 1 else 1.0
    dy = float(y_grid[1] - y_grid[0]) if len(y_grid) > 1 else 1.0

    # Fill NaN for gradient calculation only
    Z_filled = np.where(np.isnan(Z), 0.0, Z)
    Zp = np.pad(Z_filled, 1, mode='edge')

    dz_dx = (Zp[1:-1, 2:] - Zp[1:-1, :-2]) / (2.0 * dx)
    dz_dy = (Zp[2:, 1:-1] - Zp[:-2, 1:-1]) / (2.0 * dy)

    nx = -dz_dx.astype(np.float32)
    ny = np.ones_like(nx)
    nz = -dz_dy.astype(np.float32)  # Z axis points south (inverted northing)

    length = np.sqrt(nx**2 + ny**2 + nz**2)
    length = np.where(length == 0.0, 1.0, length)

    return np.stack([nx / length, ny / length, nz / length], axis=-1)


def build_faces(Z: np.ndarray) -> np.ndarray:
    """Build triangle indices for a regular grid, skipping cells with NaN corners.

    Returns (F×3 uint32) array.
    """
    rows, cols = Z.shape
    r = np.arange(rows - 1, dtype=np.int64)
    c = np.arange(cols - 1, dtype=np.int64)
    rr, cc = np.meshgrid(r, c, indexing='ij')

    v00 = (rr * cols + cc).ravel()
    v10 = ((rr + 1) * cols + cc).ravel()
    v01 = (rr * cols + (cc + 1)).ravel()
    v11 = ((rr + 1) * cols + (cc + 1)).ravel()

    z_flat = Z.ravel()
    valid = (
        ~np.isnan(z_flat[v00]) &
        ~np.isnan(z_flat[v10]) &
        ~np.isnan(z_flat[v01]) &
        ~np.isnan(z_flat[v11])
    )
    v00, v10, v01, v11 = v00[valid], v10[valid], v01[valid], v11[valid]

    # Winding: CCW when viewed from +Y (above), so face normals point up (+Y).
    # Verify: for tri1, N.y = (v11-v00).z*(v10-v00).x - (v11-v00).x*(v10-v00).z
    #         = (-s)(0) - (s)(-s) = +s²  > 0  ✓
    tri1 = np.stack([v00, v11, v10], axis=-1)
    tri2 = np.stack([v00, v01, v11], axis=-1)
    return np.concatenate([tri1, tri2], axis=0).astype(np.uint32)


def add_skirts(positions: np.ndarray, norms: np.ndarray, faces: np.ndarray,
               depth: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Add vertical skirts along the mesh boundary to hide LOD-boundary cracks.

    Boundary edges (used by exactly one triangle) get a lowered duplicate vertex;
    each boundary edge becomes a quad (emitted in both windings so the curtain is
    visible from either side under a FrontSide material). Returns extended arrays.
    """
    if depth <= 0 or len(faces) == 0:
        return positions, norms, faces

    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]], axis=0)
    ekey = np.sort(edges, axis=1)
    uniq, counts = np.unique(ekey, axis=0, return_counts=True)
    bedges = uniq[counts == 1]
    if len(bedges) == 0:
        return positions, norms, faces

    bverts = np.unique(bedges)
    base = len(positions)
    remap = np.full(base, -1, dtype=np.int64)
    remap[bverts] = np.arange(len(bverts)) + base

    skirt_pos = positions[bverts].copy()
    skirt_pos[:, 1] -= depth
    skirt_nor = norms[bverts].copy()
    positions = np.concatenate([positions, skirt_pos])
    norms = np.concatenate([norms, skirt_nor])

    a, b = bedges[:, 0], bedges[:, 1]
    a2, b2 = remap[a], remap[b]
    quads = np.concatenate([
        np.stack([a, b, b2], axis=1), np.stack([a, b2, a2], axis=1),   # one winding
        np.stack([a, b2, b], axis=1), np.stack([a, a2, b2], axis=1),   # reverse winding
    ], axis=0)
    faces = np.concatenate([faces, quads]).astype(np.uint32)
    return positions, norms, faces


def write_glb(
    x_grid: np.ndarray,
    y_grid: np.ndarray,
    Z: np.ndarray,
    normals: np.ndarray,
    faces: np.ndarray,
    x_center: float,
    y_center: float,
    z_scale: float,
    output_path: Path,
    skirt: float = 0.0,
) -> None:
    """Serialize mesh to GLB (glTF 2.0 binary) format.

    Coordinate mapping (Y-up, right-hand):
      GLB X = TWD97 Easting  - x_center  (meters)
      GLB Y = Elevation * z_scale         (meters)
      GLB Z = -(TWD97 Northing - y_center)(meters, south-positive)
    """
    rows, cols = Z.shape
    xx, yy = np.meshgrid(x_grid, y_grid, indexing='xy')  # both (rows, cols)

    z_values = np.where(np.isnan(Z), 0.0, Z) * z_scale

    positions = np.stack([
        (xx - x_center).astype(np.float32),
        z_values.astype(np.float32),
        (-(yy - y_center)).astype(np.float32),
    ], axis=-1).reshape(-1, 3)  # (N, 3)

    norms = normals.reshape(-1, 3).astype(np.float32)

    # Compact: drop vertices no face references (every no-data/sea grid cell adds
    # an unused z=0 vertex — ~half the grid for an island). Remap face indices.
    used = np.unique(faces)
    if len(used) < len(positions):
        remap = np.full(len(positions), -1, dtype=np.int64)
        remap[used] = np.arange(len(used), dtype=np.int64)
        positions = positions[used]
        norms = norms[used]
        faces = remap[faces].astype(np.uint32)
        print(f'Compacted vertices: {len(used):,} kept '
              f'({100 * len(used) / (rows * cols):.1f}% of grid)')

    if skirt > 0:
        positions, norms, faces = add_skirts(positions, norms, faces, skirt)

    v_count = len(positions)
    i_count = faces.size

    def pad4(b: bytes, fill: bytes = b'\x00') -> bytes:
        remainder = len(b) % 4
        return b if remainder == 0 else b + fill * (4 - remainder)

    v_buf = pad4(positions.tobytes())
    n_buf = pad4(norms.tobytes())
    i_buf = pad4(faces.tobytes())
    bin_data = v_buf + n_buf + i_buf

    p_min = positions.min(axis=0).tolist()
    p_max = positions.max(axis=0).tolist()

    gltf = {
        'asset': {'version': '2.0', 'generator': 'dtm_to_glb'},
        'extras': {
            'x_center': round(x_center, 2),
            'y_center': round(y_center, 2),
            'z_scale': z_scale,
            'crs': 'EPSG:3826',
            'vertical_datum': 'TWVD2001',
        },
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': 'terrain'}],
        'meshes': [{
            'name': 'terrain',
            'primitives': [{
                'attributes': {'POSITION': 0, 'NORMAL': 1},
                'indices': 2,
                'mode': 4,  # TRIANGLES
            }],
        }],
        'accessors': [
            {
                'bufferView': 0,
                'componentType': 5126,  # FLOAT
                'count': v_count,
                'type': 'VEC3',
                'min': [float(p_min[0]), float(p_min[1]), float(p_min[2])],
                'max': [float(p_max[0]), float(p_max[1]), float(p_max[2])],
            },
            {
                'bufferView': 1,
                'componentType': 5126,  # FLOAT
                'count': v_count,
                'type': 'VEC3',
            },
            {
                'bufferView': 2,
                'componentType': 5125,  # UNSIGNED_INT
                'count': i_count,
                'type': 'SCALAR',
            },
        ],
        'bufferViews': [
            {'buffer': 0, 'byteOffset': 0,                             'byteLength': len(v_buf), 'target': 34962},  # ARRAY_BUFFER
            {'buffer': 0, 'byteOffset': len(v_buf),                    'byteLength': len(n_buf), 'target': 34962},
            {'buffer': 0, 'byteOffset': len(v_buf) + len(n_buf),       'byteLength': len(i_buf), 'target': 34963},  # ELEMENT_ARRAY_BUFFER
        ],
        'buffers': [{'byteLength': len(bin_data)}],
    }

    json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    json_chunk_data = pad4(json_bytes, b' ')  # GLB spec: JSON padding = 0x20

    json_chunk = struct.pack('<II', len(json_chunk_data), 0x4E4F534A) + json_chunk_data
    bin_chunk  = struct.pack('<II', len(bin_data),        0x004E4942) + bin_data

    total_length = 12 + len(json_chunk) + len(bin_chunk)
    header = struct.pack('<III', 0x46546C67, 2, total_length)  # magic='glTF', version=2

    output_path.write_bytes(header + json_chunk + bin_chunk)

    size_mb = total_length / 1024 / 1024
    print(f'Output: {output_path}  ({size_mb:.1f} MB)')
    print(f'  Vertices: {v_count:,}  |  Triangles: {i_count // 3:,}')


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Convert Taiwan DTM tiles (.grd/.hdr) to a GLB terrain mesh.',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument('input_dir', type=Path, help='Directory containing .grd/.hdr files')
    parser.add_argument('output',    type=Path, help='Output .glb path')
    parser.add_argument(
        '--step', type=int, default=1, metavar='N',
        help='Decimation step: use every Nth grid point (1=full resolution)',
    )
    parser.add_argument(
        '--z-scale', type=float, default=1.0, metavar='F',
        help='Elevation exaggeration multiplier',
    )
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)

    print('=== Loading tiles ===')
    pts, spacing = load_tiles(args.input_dir)
    x_center = float(np.mean(pts[:, 0]))
    y_center = float(np.mean(pts[:, 1]))
    z_min, z_max = float(pts[:, 2].min()), float(pts[:, 2].max())
    print(f'Total: {len(pts):,} points | spacing={spacing:.0f}m | Z=[{z_min:.1f}, {z_max:.1f}]m')

    print('\n=== Building grid ===')
    x_grid, y_grid, Z = build_grid(pts, spacing, step=args.step)
    del pts  # free memory

    print('\n=== Computing normals ===')
    normals = compute_normals(x_grid, y_grid, Z)

    print('\n=== Building faces ===')
    faces = build_faces(Z)
    print(f'Faces: {len(faces):,}')

    print('\n=== Writing GLB ===')
    write_glb(x_grid, y_grid, Z, normals, faces, x_center, y_center, args.z_scale, args.output)


if __name__ == '__main__':
    main()
