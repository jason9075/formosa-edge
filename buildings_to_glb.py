#!/usr/bin/env python3
"""Convert Taipei 3D building KMZ models to white low-poly massing GLB(s).

PoC stage: processes one region directory (e.g. raw/buildings/kmzs/3357), parses
every ``*_r*.kmz`` (a ZIP of an inner KML + COLLADA .dae models + jpg textures),
transforms each building into the terrain GLB's coordinate frame, clamps it onto
the 20 m DTM surface, and writes a single merged GLB for visual alignment checks.

Coordinate chain (per building):
  dae local (inch, Z-up) ×0.0254 → metres
  → apply Scale, then heading rotation about up-axis
  → local ENU (X=east, Y=north, Z=up)
  Location (lon,lat WGS84) --pyproj 4326→3826--> TWD97 (E,N)
  → world TWD97: E'=E+x, N'=N+y, elev=z
  → GLB: x = E'-x_center, y = elev + (baseY - foundation), z = -(N'-y_center)

baseY = lowest 20 m DTM height across the footprint corners (so buildings on a
slope embed rather than float); foundation sinks the base a few metres.

Usage:
  python3 buildings_to_glb.py raw/buildings/kmzs/3357 output/buildings_poc.glb \
      --dtm raw/taipei --center-glb output/taiwan_100m.glb
"""

import argparse
import json
import struct
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
from pyproj import Transformer

from dtm_to_glb import build_grid, load_tiles

INCH_TO_M = 0.0254
WGS84_TO_TWD97 = Transformer.from_crs('EPSG:4326', 'EPSG:3826', always_xy=True)


def center_from_glb(glb_path: Path) -> tuple[float, float]:
    """Read (x_center, y_center) from a GLB's JSON-chunk extras."""
    with open(glb_path, 'rb') as f:
        f.seek(12)
        json_len = struct.unpack('<I', f.read(4))[0]
        f.read(4)
        meta = json.loads(f.read(json_len)).get('extras', {})
    return float(meta['x_center']), float(meta['y_center'])


# ── Terrain height sampler (20 m DTM) ──────────────────────────────────────────────
class TerrainSampler:
    """Nearest-neighbour 20 m DTM elevation lookup in TWD97 (E, N)."""

    def __init__(self, dtm_dir: Path):
        pts, spacing = load_tiles(dtm_dir)
        self.x_grid, self.y_grid, self.Z = build_grid(pts, spacing, step=1)
        self.spacing = spacing
        self.x0, self.y0 = float(self.x_grid[0]), float(self.y_grid[0])
        self.rows, self.cols = self.Z.shape
        self._fallback = float(np.nanmin(self.Z))

    def height(self, e: float, n: float, radius: int = 8) -> float | None:
        """Nearest valid 20 m sample. DTM is ~42% no-data (rivers, carved footprints),
        so on a NaN hit we search an outward window for the nearest valid cell rather
        than failing — avoids sinking buildings to the global minimum."""
        ix = int(round((e - self.x0) / self.spacing))
        iy = int(round((n - self.y0) / self.spacing))
        if not (0 <= ix < self.cols and 0 <= iy < self.rows):
            return None
        z = self.Z[iy, ix]
        if not np.isnan(z):
            return float(z)

        r0, r1 = max(0, iy - radius), min(self.rows, iy + radius + 1)
        c0, c1 = max(0, ix - radius), min(self.cols, ix + radius + 1)
        win = self.Z[r0:r1, c0:c1]
        valid = ~np.isnan(win)
        if not valid.any():
            return None
        rr, cc = np.nonzero(valid)
        d2 = (rr + r0 - iy) ** 2 + (cc + c0 - ix) ** 2
        return float(win[rr[d2.argmin()], cc[d2.argmin()]])

    def base_height(self, e_min: float, e_max: float, n_min: float, n_max: float) -> float:
        """Lowest terrain height across the footprint corners. On a large no-data
        patch (river floodplain), widen the search to ~1 km before the global fallback."""
        ec, nc = (e_min + e_max) / 2, (n_min + n_max) / 2
        samples = [
            self.height(e_min, n_min), self.height(e_max, n_min),
            self.height(e_min, n_max), self.height(e_max, n_max),
            self.height(ec, nc),
        ]
        valid = [s for s in samples if s is not None]
        if valid:
            return min(valid)
        wide = self.height(ec, nc, radius=50)  # ~1 km
        return wide if wide is not None else self._fallback


# ── COLLADA (.dae) parsing ──────────────────────────────────────────────────────────
def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


def parse_dae(dae_bytes: bytes) -> tuple[np.ndarray, np.ndarray]:
    """Parse a COLLADA .dae into (positions Nx3 metres Z-up, faces Mx3 uint32).

    Merges every <geometry> in the file (a building model is split into wall/roof
    pieces). Reads the <unit meter=...> scale; assumes identity node transform.
    """
    root = ET.fromstring(dae_bytes)
    nodes = {_local(e.tag): e for e in root}

    unit_m = INCH_TO_M
    asset = nodes.get('asset')
    if asset is not None:
        for e in asset:
            if _local(e.tag) == 'unit' and e.get('meter'):
                unit_m = float(e.get('meter'))

    lib = nodes.get('library_geometries')
    if lib is None:
        return np.empty((0, 3), np.float32), np.empty((0, 3), np.uint32)

    all_pos: list[np.ndarray] = []
    all_faces: list[np.ndarray] = []
    vbase = 0

    for geom in lib:
        mesh = next((c for c in geom if _local(c.tag) == 'mesh'), None)
        if mesh is None:
            continue

        # Index float_array sources by id; find POSITION source via <vertices>.
        sources: dict[str, np.ndarray] = {}
        vertices_src: dict[str, str] = {}  # vertices id → position source id
        tri_blocks = []
        for child in mesh:
            t = _local(child.tag)
            if t == 'source':
                fa = next((c for c in child if _local(c.tag) == 'float_array'), None)
                if fa is not None and fa.text:
                    sources['#' + child.get('id')] = np.fromstring(fa.text, sep=' ')
            elif t == 'vertices':
                vid = '#' + child.get('id')
                pos_in = next((i for i in child if i.get('semantic') == 'POSITION'), None)
                if pos_in is not None:
                    vertices_src[vid] = pos_in.get('source')
            elif t in ('triangles', 'polylist'):
                tri_blocks.append(child)

        for tri in tri_blocks:
            inputs = [i for i in tri if _local(i.tag) == 'input']
            vinput = next((i for i in inputs if i.get('semantic') == 'VERTEX'), None)
            if vinput is None:
                continue
            voff = int(vinput.get('offset', '0'))
            stride = max(int(i.get('offset', '0')) for i in inputs) + 1

            # Resolve VERTEX → POSITION float_array
            src = vinput.get('source')
            pos_src_id = vertices_src.get(src, src)
            pos_flat = sources.get(pos_src_id)
            if pos_flat is None:
                continue
            pos = pos_flat.reshape(-1, 3)

            p_elem = next((c for c in tri if _local(c.tag) == 'p'), None)
            if p_elem is None or not p_elem.text:
                continue
            idx = np.fromstring(p_elem.text, sep=' ', dtype=np.int64)
            vidx = idx[voff::stride]

            if _local(tri.tag) == 'triangles':
                faces = vidx.reshape(-1, 3)
            else:  # polylist — fan-triangulate each polygon by its vcount
                vc_elem = next((c for c in tri if _local(c.tag) == 'vcount'), None)
                if vc_elem is None or not vc_elem.text:
                    continue
                vcount = np.fromstring(vc_elem.text, sep=' ', dtype=np.int64)
                faces_list, off = [], 0
                for n in vcount:
                    for k in range(1, n - 1):
                        faces_list.append((vidx[off], vidx[off + k], vidx[off + k + 1]))
                    off += n
                if not faces_list:
                    continue
                faces = np.array(faces_list, dtype=np.int64)

            all_pos.append(pos)
            all_faces.append(faces + vbase)
            vbase += len(pos)

    if not all_pos:
        return np.empty((0, 3), np.float32), np.empty((0, 3), np.uint32)

    positions = np.concatenate(all_pos, axis=0) * unit_m  # → metres, still Z-up local
    faces = np.concatenate(all_faces, axis=0).astype(np.uint32)
    return positions.astype(np.float32), faces


# ── KMZ / KML parsing ───────────────────────────────────────────────────────────────
def parse_kmz(kmz_path: Path):
    """Yield (positions_local, faces, lon, lat, heading, scale_xyz, dae_name) per Model."""
    with zipfile.ZipFile(kmz_path) as zf:
        kml_name = next((n for n in zf.namelist() if n.endswith('.kml')), None)
        if kml_name is None:
            return
        root = ET.fromstring(zf.read(kml_name))
        dae_cache: dict[str, tuple] = {}

        for pm in root.iter():
            if _local(pm.tag) != 'Placemark':
                continue
            model = next((c for c in pm if _local(c.tag) == 'Model'), None)
            if model is None:
                continue

            lon = lat = heading = None
            scale = [1.0, 1.0, 1.0]
            href = None
            for c in model:
                t = _local(c.tag)
                if t == 'Location':
                    for v in c:
                        vt = _local(v.tag)
                        if vt == 'longitude':
                            lon = float(v.text)
                        elif vt == 'latitude':
                            lat = float(v.text)
                elif t == 'Orientation':
                    h = next((v for v in c if _local(v.tag) == 'heading'), None)
                    heading = float(h.text) if h is not None and h.text else 0.0
                elif t == 'Scale':
                    for v in c:
                        vt = _local(v.tag)
                        if vt in ('x', 'y', 'z'):
                            scale['xyz'.index(vt)] = float(v.text)
                elif t == 'Link':
                    hr = next((v for v in c if _local(v.tag) == 'href'), None)
                    if hr is not None:
                        href = hr.text
            if lon is None or lat is None or href is None:
                continue

            dae_member = next((n for n in zf.namelist() if n.endswith(href.split('/')[-1])), None)
            if dae_member is None:
                continue
            if dae_member not in dae_cache:
                dae_cache[dae_member] = parse_dae(zf.read(dae_member))
            pos, faces = dae_cache[dae_member]
            if len(pos) == 0:
                continue
            yield pos, faces, lon, lat, (heading or 0.0), scale, dae_member


def place_building(pos_local, lon, lat, heading, scale, sampler, x_center, y_center, foundation):
    """Transform a local building mesh into GLB world coords, clamped to terrain."""
    e_loc, n_loc = WGS84_TO_TWD97.transform(lon, lat)

    p = pos_local.astype(np.float64).copy()
    p[:, 0] *= scale[0]
    p[:, 1] *= scale[1]
    p[:, 2] *= scale[2]

    if heading:
        # KML heading: clockwise from north (local +Y) viewed from above.
        h = np.radians(heading)
        cos_h, sin_h = np.cos(h), np.sin(h)
        x, y = p[:, 0].copy(), p[:, 1].copy()
        p[:, 0] = x * cos_h + y * sin_h
        p[:, 1] = -x * sin_h + y * cos_h

    # local ENU → world TWD97
    e_world = e_loc + p[:, 0]
    n_world = n_loc + p[:, 1]
    elev = p[:, 2]

    base_y = sampler.base_height(float(e_world.min()), float(e_world.max()),
                                 float(n_world.min()), float(n_world.max()))

    gx = e_world - x_center
    gy = elev + (base_y - foundation)
    gz = -(n_world - y_center)
    world = np.stack([gx, gy, gz], axis=-1).astype(np.float32)
    return world, float(e_loc), float(n_loc)


def building_box(world_pos: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Axis-aligned bounding box of a placed building → 8 verts + 12 triangles.

    The far-LOD "simple square": footprint AABB (in GLB x/z) extruded from the
    building base (min y) to its roof (max y)."""
    x0, y0, z0 = world_pos.min(axis=0)
    x1, y1, z1 = world_pos.max(axis=0)
    v = np.array([
        [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],  # base 0..3
        [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],  # roof 4..7
    ], dtype=np.float32)
    # Winding chosen so every face normal points OUTWARD (verified against
    # cross(v1-v0, v2-v0)); the frontend renders FrontSide, so inward faces would
    # be culled / mis-lit. Verts: 0-3 base (y0), 4-7 roof (y1); x0<x1, z0<z1.
    f = np.array([
        [0, 1, 2], [0, 2, 3],            # bottom (−Y)
        [4, 7, 6], [4, 6, 5],            # top    (+Y)
        [0, 4, 5], [0, 5, 1],            # −Z wall (north)
        [3, 2, 6], [3, 6, 7],            # +Z wall (south)
        [1, 6, 2], [1, 5, 6],            # +X wall (east)
        [0, 3, 7], [0, 7, 4],            # −X wall (west)
    ], dtype=np.uint32)
    return v, f


# ── Flat-shaded normals + GLB writer ────────────────────────────────────────────────
def flat_mesh(positions: np.ndarray, faces: np.ndarray):
    """Expand to unindexed flat-shaded geometry: one face normal per triangle."""
    tri = positions[faces]                       # (F, 3, 3)
    v0, v1, v2 = tri[:, 0], tri[:, 1], tri[:, 2]
    fn = np.cross(v1 - v0, v2 - v0)
    ln = np.linalg.norm(fn, axis=1, keepdims=True)
    fn = np.divide(fn, ln, out=np.zeros_like(fn), where=ln > 0)
    out_pos = tri.reshape(-1, 3).astype(np.float32)
    out_nor = np.repeat(fn, 3, axis=0).astype(np.float32)
    out_idx = np.arange(len(out_pos), dtype=np.uint32)
    return out_pos, out_nor, out_idx


def write_mesh_glb(positions, normals, faces, x_center, y_center, out_path: Path):
    """Serialize an arbitrary indexed mesh to GLB (white massing, no materials)."""
    def pad4(b, fill=b'\x00'):
        r = len(b) % 4
        return b if r == 0 else b + fill * (4 - r)

    v_buf = pad4(positions.tobytes())
    n_buf = pad4(normals.tobytes())
    i_buf = pad4(faces.tobytes())
    bin_data = v_buf + n_buf + i_buf
    p_min = positions.min(axis=0).tolist()
    p_max = positions.max(axis=0).tolist()

    gltf = {
        'asset': {'version': '2.0', 'generator': 'buildings_to_glb'},
        'extras': {'x_center': round(x_center, 2), 'y_center': round(y_center, 2), 'crs': 'EPSG:3826'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': 'buildings'}],
        'meshes': [{'name': 'buildings', 'primitives': [{
            'attributes': {'POSITION': 0, 'NORMAL': 1}, 'indices': 2, 'mode': 4}]}],
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': len(positions), 'type': 'VEC3',
             'min': [float(x) for x in p_min], 'max': [float(x) for x in p_max]},
            {'bufferView': 1, 'componentType': 5126, 'count': len(normals), 'type': 'VEC3'},
            {'bufferView': 2, 'componentType': 5125, 'count': faces.size, 'type': 'SCALAR'},
        ],
        'bufferViews': [
            {'buffer': 0, 'byteOffset': 0, 'byteLength': len(v_buf), 'target': 34962},
            {'buffer': 0, 'byteOffset': len(v_buf), 'byteLength': len(n_buf), 'target': 34962},
            {'buffer': 0, 'byteOffset': len(v_buf) + len(n_buf), 'byteLength': len(i_buf), 'target': 34963},
        ],
        'buffers': [{'byteLength': len(bin_data)}],
    }

    json_bytes = pad4(json.dumps(gltf, separators=(',', ':')).encode('utf-8'), b' ')
    json_chunk = struct.pack('<II', len(json_bytes), 0x4E4F534A) + json_bytes
    bin_chunk = struct.pack('<II', len(bin_data), 0x004E4942) + bin_data
    total = 12 + len(json_chunk) + len(bin_chunk)
    header = struct.pack('<III', 0x46546C67, 2, total)
    out_path.write_bytes(header + json_chunk + bin_chunk)
    print(f'Output: {out_path}  ({total / 1024 / 1024:.2f} MB)')
    print(f'  Vertices: {len(positions):,}  |  Triangles: {faces.size // 3:,}')


TILE = 5000  # metres — match tile_dtm.py grid


def collect_buildings(src_dir: Path, sampler, x_center, y_center, foundation, mode):
    """Parse every KMZ under src_dir → list of (verts, faces, e_loc, n_loc) per building.

    mode='massing' keeps source geometry; mode='box' emits each building's AABB."""
    kmzs = sorted(src_dir.rglob('*_r*.kmz'))
    print(f'=== Processing {len(kmzs)} KMZ under {src_dir} (mode={mode}) ===')
    out, n_skipped = [], 0
    for kmz in kmzs:
        try:
            for pos_local, faces, lon, lat, heading, scale, _ in parse_kmz(kmz):
                world, e_loc, n_loc = place_building(
                    pos_local, lon, lat, heading, scale, sampler, x_center, y_center, foundation)
                if mode == 'box':
                    world, faces = building_box(world)
                out.append((world, faces, e_loc, n_loc))
        except Exception as exc:  # noqa: BLE001 — robust batch processing
            print(f'  [warn] {kmz.name}: {exc}', file=sys.stderr)
            n_skipped += 1
    print(f'Parsed {len(out):,} buildings ({n_skipped} KMZ skipped)')
    return out


def _merge_write(pieces, x_center, y_center, out_path):
    """Merge (verts, faces) pieces, flat-shade, write one GLB."""
    all_pos, all_faces, vbase = [], [], 0
    for verts, faces in pieces:
        all_pos.append(verts)
        all_faces.append(faces + vbase)
        vbase += len(verts)
    positions = np.concatenate(all_pos, axis=0)
    faces = np.concatenate(all_faces, axis=0).astype(np.uint32)
    fpos, fnor, fidx = flat_mesh(positions, faces)
    write_mesh_glb(fpos, fnor, fidx, x_center, y_center, out_path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src_dir', type=Path, help='KMZ dir (region e.g. raw/buildings/kmzs/3357, or kmzs root)')
    ap.add_argument('output', type=Path, help='Output .glb (single) or dir (--tiled)')
    ap.add_argument('--dtm', type=Path, required=True, help='20 m DTM dir (raw/taipei)')
    ap.add_argument('--center-glb', type=Path, required=True, help='Reference GLB for x/y_center')
    ap.add_argument('--mode', choices=['massing', 'box'], default='massing')
    ap.add_argument('--tiled', action='store_true', help='Slice into 5 km tiles + index.json')
    ap.add_argument('--foundation', type=float, default=0.0, metavar='M', help='Sink base below terrain')
    args = ap.parse_args()

    x_center, y_center = center_from_glb(args.center_glb)
    print(f'Centre: ({x_center:.2f}, {y_center:.2f})')

    print('\n=== Building terrain sampler (20 m DTM) ===')
    sampler = TerrainSampler(args.dtm)

    print()
    buildings = collect_buildings(args.src_dir, sampler, x_center, y_center, args.foundation, args.mode)
    if not buildings:
        sys.exit('No buildings parsed.')

    if not args.tiled:
        print('\n=== Flat-shading + writing single GLB ===')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        _merge_write([(v, f) for v, f, _, _ in buildings], x_center, y_center, args.output)
        return

    # Tiled: bin each building into a 5 km TWD97 cell (centroid → tile).
    print(f'\n=== Slicing into {TILE} m tiles → {args.output} ===')
    args.output.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list] = {}
    for verts, faces, e_loc, n_loc in buildings:
        ti, tj = int(e_loc // TILE), int(n_loc // TILE)
        groups.setdefault(f'{ti}_{tj}', []).append((verts, faces))

    index_tiles = []
    for key, pieces in sorted(groups.items()):
        _merge_write(pieces, x_center, y_center, args.output / f'{key}.glb')
        ti, tj = (int(p) for p in key.split('_'))
        cx = (ti + 0.5) * TILE - x_center
        cz = -((tj + 0.5) * TILE - y_center)
        index_tiles.append({'key': key, 'url': f'{args.output.name}/{key}.glb',
                            'cx': round(cx, 1), 'cz': round(cz, 1)})

    index = {'center': [round(x_center, 2), round(y_center, 2)], 'tileSize': TILE, 'tiles': index_tiles}
    (args.output / 'index.json').write_text(json.dumps(index, separators=(',', ':')))
    print(f'\nWrote {len(index_tiles)} tiles + index.json to {args.output}')


if __name__ == '__main__':
    main()
