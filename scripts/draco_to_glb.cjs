'use strict';
/**
 * Decode a Draco-compressed GLB (single mesh, single primitive with
 * POSITION+NORMAL+indices, as produced by this project's pipeline) into an
 * UNCOMPRESSED .glb with the same `extras` (x_center/y_center) preserved.
 *
 * Usage: node scripts/draco_to_glb.cjs <in.glb> <out.glb>
 */
const fs = require('fs');
const draco3d = require('draco3d');

const GLB_MAGIC = 0x46546c67;
const JSON_TYPE = 0x4e4f534a;
const BIN_TYPE = 0x004e4942;

/** Split a GLB into its parsed JSON object and the binary chunk Buffer. */
function readGlb(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_TYPE) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_TYPE) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

/** GLB serializer matching buildings_to_glb.write_mesh_glb (VEC3 pos/nor + uint32 idx). */
function writeGlb(positions, normals, indices, extras, outPath) {
  const pad4 = (b) => {
    const r = b.length % 4;
    return r === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - r)]);
  };
  const vBuf = pad4(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  const nBuf = pad4(Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength));
  const iBuf = pad4(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  const binData = Buffer.concat([vBuf, nBuf, iBuf]);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }

  const gltf = {
    asset: { version: '2.0', generator: 'draco_to_glb' },
    extras,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0, mode: 4 }] }],
    accessors: [
      { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3',
        min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vBuf.length, target: 34962 },
      { buffer: 0, byteOffset: vBuf.length, byteLength: nBuf.length, target: 34962 },
      { buffer: 0, byteOffset: vBuf.length + nBuf.length, byteLength: iBuf.length, target: 34963 },
    ],
    buffers: [{ byteLength: binData.length }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binData.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(JSON_TYPE, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binData.length, 0);
  binHeader.writeUInt32LE(BIN_TYPE, 4);

  fs.writeFileSync(outPath, Buffer.concat([header, jsonHeader, jsonBuf, binHeader, binData]));
}

async function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('usage: node draco_to_glb.cjs <in.glb> <out.glb>');
    process.exit(1);
  }
  const decoderModule = await draco3d.createDecoderModule({});
  const { json, bin } = readGlb(inPath);

  const prim = json.meshes[0].primitives[0];
  const dext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
  if (!dext) throw new Error('primitive is not Draco-compressed');
  const bv = json.bufferViews[dext.bufferView];
  const start = bv.byteOffset || 0;
  const slice = bin.subarray(start, start + bv.byteLength);

  const decoder = new decoderModule.Decoder();
  const buffer = new decoderModule.DecoderBuffer();
  buffer.Init(new Int8Array(slice), slice.byteLength);
  const mesh = new decoderModule.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok()) throw new Error('Draco decode failed: ' + status.error_msg());

  const numPoints = mesh.num_points();

  const readVec3 = (uniqueId) => {
    const attr = decoder.GetAttributeByUniqueId(mesh, uniqueId);
    const out = new decoderModule.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attr, out);
    const arr = new Float32Array(numPoints * 3);
    for (let i = 0; i < numPoints * 3; i++) arr[i] = out.GetValue(i);
    decoderModule.destroy(out);
    return arr;
  };

  const positions = readVec3(dext.attributes.POSITION);
  const normals = readVec3(dext.attributes.NORMAL);

  const numFaces = mesh.num_faces();
  const indices = new Uint32Array(numFaces * 3);
  const ia = new decoderModule.DracoInt32Array();
  for (let f = 0; f < numFaces; f++) {
    decoder.GetFaceFromMesh(mesh, f, ia);
    indices[f * 3] = ia.GetValue(0);
    indices[f * 3 + 1] = ia.GetValue(1);
    indices[f * 3 + 2] = ia.GetValue(2);
  }
  decoderModule.destroy(ia);
  decoderModule.destroy(buffer);
  decoderModule.destroy(mesh);
  decoderModule.destroy(decoder);

  writeGlb(positions, normals, indices, json.extras || {}, outPath);
  console.log(`decoded ${inPath} -> ${outPath}: ${numPoints} verts, ${numFaces} tris`);
}

main().catch((e) => { console.error(e); process.exit(1); });
