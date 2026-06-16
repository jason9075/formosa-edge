#!/usr/bin/env python3
"""Clip terrain + building tiles to a lon/lat box and merge into one standalone GLB.

Self-contained: given the project's built tile dirs (``output/tiles`` 20 m terrain and
``output/building_tiles`` massing) it auto-selects every tile overlapping the requested
WGS84 box, decodes each (Draco → plain via ``scripts/draco_to_glb.cjs``), clips it to the
box, and merges into ONE GLB with two nodes — ``terrain`` and ``buildings`` — that stay
perfectly aligned (both baked against the same shared TWD97 centre).

Local GLB frame (see dtm_to_glb.write_glb):
  x = Easting - x_center ,  y = elevation ,  z = -(Northing - y_center)

Usage:
  python3 merge_region_glb.py \
      --tiles output/tiles --buildings output/building_tiles \
      --sw 25.05787 121.56175 --ne 25.06124 121.56572 \
      --out output/region_xinyi.glb --draco
"""

import argparse
import json
import struct
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from pyproj import Transformer

WGS84_TO_TWD97 = Transformer.from_crs('EPSG:4326', 'EPSG:3826', always_xy=True)
DRACO_DECODER = Path(__file__).parent / 'scripts' / 'draco_to_glb.cjs'
GLTF_PIPELINE = Path(__file__).parent / 'node_modules' / '.bin' / 'gltf-pipeline'

_COMPONENT = {5126: '<f4', 5125: '<u4', 5123: '<u2'}
_TYPE_N = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}


# ── GLB reading ───────────────────────────────────────────────────────────────────────
def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    assert struct.unpack('<I', data[:4])[0] == 0x46546C67, f'{path} is not a GLB'
    off, gltf, bin_chunk = 12, None, b''
    while off < len(data):
        clen, ctype = struct.unpack('<II', data[off:off + 8])
        chunk = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            gltf = json.loads(chunk)
        elif ctype == 0x004E4942:
            bin_chunk = chunk
        off += 8 + clen
    return gltf, bin_chunk


def accessor_array(gltf: dict, bin_chunk: bytes, idx: int) -> np.ndarray:
    acc = gltf['accessors'][idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    n = _TYPE_N[acc['type']]
    start = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    arr = np.frombuffer(bin_chunk, dtype=np.dtype(_COMPONENT[acc['componentType']]),
                        count=acc['count'] * n, offset=start)
    return arr.reshape(acc['count'], n) if n > 1 else arr


def load_decoded_tile(glb: Path, tmp: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Decode a (Draco) tile via the node helper, then read POSITION/NORMAL/indices."""
    out = tmp / (glb.stem + '.plain.glb')
    subprocess.run(['node', str(DRACO_DECODER), str(glb), str(out)],
                   check=True, capture_output=True)
    gltf, bin_chunk = read_glb(out)
    prim = gltf['meshes'][0]['primitives'][0]
    pos = accessor_array(gltf, bin_chunk, prim['attributes']['POSITION']).astype(np.float32)
    nor = accessor_array(gltf, bin_chunk, prim['attributes']['NORMAL']).astype(np.float32)
    idx = accessor_array(gltf, bin_chunk, prim['indices']).reshape(-1).astype(np.uint32)
    return pos, nor, idx, gltf.get('extras', {})


# ── tile selection + clipping ───────────────────────────────────────────────────────────
def overlapping_tiles(index_path: Path, x0, x1, z0, z1) -> list[Path]:
    """Tiles whose local AABB (cx±tileSize/2) intersects the box."""
    index = json.loads(index_path.read_text())
    half = index['tileSize'] / 2 + index.get('spacing', 20)  # + overlap margin
    base = index_path.parent
    hits = []
    for t in index['tiles']:
        if (t['cx'] - half <= x1 and t['cx'] + half >= x0 and
                t['cz'] - half <= z1 and t['cz'] + half >= z0):
            hits.append(base / Path(t['url']).name)
    return hits


def clip_to_box(pos, nor, idx, x0, x1, z0, z1):
    """Keep triangles whose centroid (x,z) lies in the box; reindex compactly."""
    faces = idx.reshape(-1, 3)
    tri = pos[faces]
    cx, cz = tri[:, :, 0].mean(axis=1), tri[:, :, 2].mean(axis=1)
    faces = faces[(cx >= x0) & (cx <= x1) & (cz >= z0) & (cz <= z1)]
    if len(faces) == 0:
        return np.empty((0, 3), np.float32), np.empty((0, 3), np.float32), np.empty(0, np.uint32)
    used = np.unique(faces)
    remap = np.full(pos.shape[0], -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return pos[used], nor[used], remap[faces].reshape(-1).astype(np.uint32)


def collect(tile_dir: Path, x0, x1, z0, z1, tmp: Path):
    """Decode + clip every overlapping tile; return (merged_pos, nor, idx, extras)."""
    index_path = tile_dir / 'index.json'
    tiles = overlapping_tiles(index_path, x0, x1, z0, z1)
    print(f'  {tile_dir.name}: {len(tiles)} overlapping tile(s)')
    parts, extras = [], {}
    for glb in tiles:
        pos, nor, idx, extras = load_decoded_tile(glb, tmp)
        parts.append(clip_to_box(pos, nor, idx, x0, x1, z0, z1))
    if not parts:
        return np.empty((0, 3), np.float32), np.empty((0, 3), np.float32), np.empty(0, np.uint32), extras
    all_pos, all_nor, all_idx, vbase = [], [], [], 0
    for pos, nor, idx in parts:
        all_pos.append(pos)
        all_nor.append(nor)
        all_idx.append(idx + vbase)
        vbase += len(pos)
    return (np.concatenate(all_pos), np.concatenate(all_nor),
            np.concatenate(all_idx).astype(np.uint32), extras)


# ── combined GLB writer ───────────────────────────────────────────────────────────────
def write_combined_glb(parts, x_center, y_center, out_path: Path, shift=None):
    """One GLB, one node/mesh per non-empty part: [(name, pos, nor, idx), …].

    `shift` (dx, dy, dz), if given, is SUBTRACTED from every position before writing
    and recorded in extras so the original project-frame coords are recoverable."""
    def pad4(b, fill=b'\x00'):
        r = len(b) % 4
        return b if r == 0 else b + fill * (4 - r)

    blobs, views, accessors, meshes, nodes, offset = [], [], [], [], [], 0

    def add_view(buf, target):
        nonlocal offset
        padded = pad4(buf)
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(buf), 'target': target})
        blobs.append(padded)
        offset += len(padded)
        return len(views) - 1

    off = np.asarray(shift, np.float32) if shift is not None else None
    for name, pos, nor, idx in parts:
        if len(idx) == 0:
            print(f'  [skip] {name}: empty after clip')
            continue
        if off is not None:
            pos = pos - off
        vpos = add_view(pos.astype(np.float32).tobytes(), 34962)
        vnor = add_view(nor.astype(np.float32).tobytes(), 34962)
        vidx = add_view(idx.astype(np.uint32).tobytes(), 34963)
        a = len(accessors)
        accessors.append({'bufferView': vidx, 'componentType': 5125, 'count': int(idx.size),
                          'type': 'SCALAR'})
        accessors.append({'bufferView': vpos, 'componentType': 5126, 'count': int(len(pos)),
                          'type': 'VEC3', 'min': [float(v) for v in pos.min(0)],
                          'max': [float(v) for v in pos.max(0)]})
        accessors.append({'bufferView': vnor, 'componentType': 5126, 'count': int(len(nor)),
                          'type': 'VEC3'})
        meshes.append({'name': name, 'primitives': [{
            'attributes': {'POSITION': a + 1, 'NORMAL': a + 2}, 'indices': a, 'mode': 4}]})
        nodes.append({'mesh': len(meshes) - 1, 'name': name})

    bin_data = b''.join(blobs)
    extras = {'x_center': round(x_center, 2), 'y_center': round(y_center, 2), 'crs': 'EPSG:3826'}
    if shift is not None:
        # Add back to a local position to recover the project-frame coords.
        extras['recenter_offset'] = [round(float(v), 3) for v in shift]
    gltf = {
        'asset': {'version': '2.0', 'generator': 'merge_region_glb'},
        'extras': extras,
        'scene': 0,
        'scenes': [{'nodes': list(range(len(nodes)))}],
        'nodes': nodes,
        'meshes': meshes,
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': len(bin_data)}],
    }
    json_bytes = pad4(json.dumps(gltf, separators=(',', ':')).encode('utf-8'), b' ')
    json_chunk = struct.pack('<II', len(json_bytes), 0x4E4F534A) + json_bytes
    bin_chunk = struct.pack('<II', len(bin_data), 0x004E4942) + bin_data
    total = 12 + len(json_chunk) + len(bin_chunk)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(struct.pack('<III', 0x46546C67, 2, total) + json_chunk + bin_chunk)

    tris = sum(int(idx.size) // 3 for _, _, _, idx in parts)
    verts = sum(int(len(pos)) for _, pos, _, _ in parts)
    print(f'Output: {out_path}  ({total / 1024 / 1024:.2f} MB)')
    print(f'  Nodes: {len(nodes)}  |  Vertices: {verts:,}  |  Triangles: {tris:,}')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tiles', type=Path, required=True, help='20 m terrain tile dir (has index.json)')
    ap.add_argument('--buildings', type=Path, required=True, help='Building massing tile dir')
    ap.add_argument('--sw', type=float, nargs=2, required=True, metavar=('LAT', 'LON'))
    ap.add_argument('--ne', type=float, nargs=2, required=True, metavar=('LAT', 'LON'))
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--draco', action='store_true', help='Also write <out>.draco.glb (gltf-pipeline)')
    ap.add_argument('--recenter', action='store_true',
                    help='Shift mesh so the box centre sits at the origin (easy to view '
                         'in Blender; the applied offset is stored in extras.recenter_offset)')
    args = ap.parse_args()

    extras = json.loads((args.tiles / 'index.json').read_text())
    x_center, y_center = extras['center']
    print(f'Centre (TWD97): ({x_center:.2f}, {y_center:.2f})')

    e_sw, n_sw = WGS84_TO_TWD97.transform(args.sw[1], args.sw[0])
    e_ne, n_ne = WGS84_TO_TWD97.transform(args.ne[1], args.ne[0])
    x0, x1 = e_sw - x_center, e_ne - x_center
    z0, z1 = -(n_ne - y_center), -(n_sw - y_center)
    print(f'BBox TWD97 E[{e_sw:.1f},{e_ne:.1f}] N[{n_sw:.1f},{n_ne:.1f}] '
          f'({e_ne - e_sw:.1f}×{n_ne - n_sw:.1f} m)')
    print(f'  → local x[{x0:.1f},{x1:.1f}] z[{z0:.1f},{z1:.1f}]')

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        print('Terrain:')
        terr = collect(args.tiles, x0, x1, z0, z1, tmp)
        print('Buildings:')
        bld = collect(args.buildings, x0, x1, z0, z1, tmp)

    offset = None
    if args.recenter:
        # Centre on the box midpoint in x/z; drop y by the terrain's min so the
        # ground sits at ~y=0 (keeps building heights intact).
        terr_pos = terr[0]
        y_floor = float(terr_pos[:, 1].min()) if len(terr_pos) else 0.0
        offset = ((x0 + x1) / 2, y_floor, (z0 + z1) / 2)
        print(f'Recenter offset (subtracted): ({offset[0]:.1f}, {offset[1]:.1f}, {offset[2]:.1f})')

    write_combined_glb([('terrain', *terr[:3]), ('buildings', *bld[:3])],
                       x_center, y_center, args.out, shift=offset)

    if args.draco:
        draco_out = args.out.with_suffix('.draco.glb')
        # .bin/gltf-pipeline lacks the exec bit under this project's noexec npm setup → run via node.
        subprocess.run(['node', str(GLTF_PIPELINE), '-i', str(args.out), '-o', str(draco_out),
                        '--draco.compressionLevel', '7'], check=True, capture_output=True)
        mb = draco_out.stat().st_size / 1024 / 1024
        print(f'Draco:  {draco_out}  ({mb:.2f} MB)')


if __name__ == '__main__':
    main()
