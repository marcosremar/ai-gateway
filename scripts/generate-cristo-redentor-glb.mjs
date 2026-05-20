import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outPath = resolve('output/cristo-redentor.glb');

const materials = [
  {
    name: 'pale soapstone',
    pbrMetallicRoughness: {
      baseColorFactor: [0.82, 0.80, 0.72, 1],
      metallicFactor: 0,
      roughnessFactor: 0.92,
    },
    doubleSided: true,
  },
  {
    name: 'weathered fold shadow',
    pbrMetallicRoughness: {
      baseColorFactor: [0.54, 0.53, 0.48, 1],
      metallicFactor: 0,
      roughnessFactor: 0.96,
    },
    doubleSided: true,
  },
  {
    name: 'warm stone skin',
    pbrMetallicRoughness: {
      baseColorFactor: [0.76, 0.70, 0.60, 1],
      metallicFactor: 0,
      roughnessFactor: 0.9,
    },
    doubleSided: true,
  },
  {
    name: 'dark carved face',
    pbrMetallicRoughness: {
      baseColorFactor: [0.16, 0.15, 0.13, 1],
      metallicFactor: 0,
      roughnessFactor: 0.98,
    },
    doubleSided: true,
  },
];

const groups = materials.map(() => ({ positions: [], normals: [], indices: [] }));

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function addTri(material, a, b, c) {
  const group = groups[material];
  const normal = normalize(cross(sub(b, a), sub(c, a)));
  const idx = group.positions.length / 3;
  group.positions.push(...a, ...b, ...c);
  group.normals.push(...normal, ...normal, ...normal);
  group.indices.push(idx, idx + 1, idx + 2);
}

function rotatePoint(p, rotation) {
  let [x, y, z] = p;
  const [rx, ry, rz] = rotation;
  if (rx) {
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    [y, z] = [y * c - z * s, y * s + z * c];
  }
  if (ry) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    [x, z] = [x * c + z * s, -x * s + z * c];
  }
  if (rz) {
    const c = Math.cos(rz);
    const s = Math.sin(rz);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y, z];
}

function transformPoint(p, options = {}) {
  const scale = options.scale ?? [1, 1, 1];
  const rotation = options.rotation ?? [0, 0, 0];
  const translate = options.translate ?? [0, 0, 0];
  const scaled = [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]];
  const rotated = rotatePoint(scaled, rotation);
  return [
    rotated[0] + translate[0],
    rotated[1] + translate[1],
    rotated[2] + translate[2],
  ];
}

function addBox(material, center, size, rotation = [0, 0, 0]) {
  const [sx, sy, sz] = size.map(v => v / 2);
  const corners = [
    [-sx, -sy, -sz], [sx, -sy, -sz], [sx, sy, -sz], [-sx, sy, -sz],
    [-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz],
  ].map(p => transformPoint(p, { translate: center, rotation }));
  const faces = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [3, 7, 6], [3, 6, 2],
    [1, 2, 6], [1, 6, 5],
    [0, 4, 7], [0, 7, 3],
  ];
  for (const [a, b, c] of faces) addTri(material, corners[a], corners[b], corners[c]);
}

function addTaperedCylinder(material, options) {
  const {
    center = [0, 0, 0],
    height = 1,
    bottom = [0.5, 0.5],
    top = [0.5, 0.5],
    segments = 24,
    rotation = [0, 0, 0],
  } = options;
  const bottomRing = [];
  const topRing = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    bottomRing.push(transformPoint([Math.cos(a) * bottom[0], -height / 2, Math.sin(a) * bottom[1]], { translate: center, rotation }));
    topRing.push(transformPoint([Math.cos(a) * top[0], height / 2, Math.sin(a) * top[1]], { translate: center, rotation }));
  }
  const bottomCenter = transformPoint([0, -height / 2, 0], { translate: center, rotation });
  const topCenter = transformPoint([0, height / 2, 0], { translate: center, rotation });
  for (let i = 0; i < segments; i++) {
    const n = (i + 1) % segments;
    addTri(material, bottomRing[i], bottomRing[n], topRing[n]);
    addTri(material, bottomRing[i], topRing[n], topRing[i]);
    addTri(material, bottomCenter, bottomRing[i], bottomRing[n]);
    addTri(material, topCenter, topRing[n], topRing[i]);
  }
}

function addEllipsoid(material, center, radius, segments = 24, rings = 12, rotation = [0, 0, 0]) {
  const point = (theta, phi) => transformPoint([
    Math.cos(theta) * Math.sin(phi) * radius[0],
    Math.cos(phi) * radius[1],
    Math.sin(theta) * Math.sin(phi) * radius[2],
  ], { translate: center, rotation });

  for (let r = 0; r < rings; r++) {
    const p0 = (r / rings) * Math.PI;
    const p1 = ((r + 1) / rings) * Math.PI;
    for (let s = 0; s < segments; s++) {
      const t0 = (s / segments) * Math.PI * 2;
      const t1 = ((s + 1) / segments) * Math.PI * 2;
      const a = point(t0, p0);
      const b = point(t1, p0);
      const c = point(t1, p1);
      const d = point(t0, p1);
      if (r > 0) addTri(material, a, b, d);
      if (r < rings - 1) addTri(material, b, c, d);
    }
  }
}

function addRobeFold(x, y, h, z, width = 0.045) {
  addBox(1, [x, y, z], [width, h, 0.04], [0, 0, x * 0.08]);
}

function buildModel() {
  addBox(0, [0, 0.16, 0], [3.8, 0.32, 3.15]);
  addBox(0, [0, 0.48, 0], [3.25, 0.28, 2.65]);
  addBox(0, [0, 0.92, 0], [2.25, 0.62, 1.9]);
  addBox(1, [0, 1.26, -0.96], [1.35, 0.12, 0.06]);

  addTaperedCylinder(0, {
    center: [0, 2.75, 0],
    height: 2.95,
    bottom: [0.74, 0.45],
    top: [0.45, 0.30],
    segments: 32,
  });
  addTaperedCylinder(0, {
    center: [0, 4.17, -0.02],
    height: 0.8,
    bottom: [0.48, 0.31],
    top: [0.63, 0.34],
    segments: 24,
  });

  for (const x of [-0.42, -0.24, -0.08, 0.1, 0.28, 0.45]) {
    addRobeFold(x, 2.72, 2.32, -0.455);
  }
  addBox(1, [0.02, 3.7, -0.43], [1.04, 0.07, 0.055], [0, 0, -0.18]);
  addBox(1, [-0.18, 3.22, -0.47], [0.08, 1.25, 0.05], [0, 0, 0.06]);

  addTaperedCylinder(0, {
    center: [-1.65, 4.43, 0],
    height: 2.45,
    bottom: [0.19, 0.23],
    top: [0.24, 0.29],
    segments: 20,
    rotation: [0, 0, Math.PI / 2],
  });
  addTaperedCylinder(0, {
    center: [1.65, 4.43, 0],
    height: 2.45,
    bottom: [0.24, 0.29],
    top: [0.19, 0.23],
    segments: 20,
    rotation: [0, 0, Math.PI / 2],
  });
  addBox(1, [-1.6, 4.23, -0.23], [1.95, 0.055, 0.055], [0, 0, 0.05]);
  addBox(1, [1.6, 4.23, -0.23], [1.95, 0.055, 0.055], [0, 0, -0.05]);
  addEllipsoid(2, [-2.92, 4.43, 0], [0.19, 0.12, 0.16], 16, 8, [0, 0, Math.PI / 2]);
  addEllipsoid(2, [2.92, 4.43, 0], [0.19, 0.12, 0.16], 16, 8, [0, 0, Math.PI / 2]);

  addTaperedCylinder(2, {
    center: [0, 4.86, 0],
    height: 0.24,
    bottom: [0.16, 0.13],
    top: [0.14, 0.12],
    segments: 16,
  });
  addEllipsoid(2, [0, 5.22, -0.01], [0.31, 0.43, 0.28], 24, 12);
  addEllipsoid(3, [0, 5.39, 0.02], [0.32, 0.18, 0.27], 20, 8);
  addBox(3, [-0.095, 5.24, -0.285], [0.055, 0.035, 0.025]);
  addBox(3, [0.095, 5.24, -0.285], [0.055, 0.035, 0.025]);
  addTaperedCylinder(2, {
    center: [0, 5.12, -0.31],
    height: 0.18,
    bottom: [0.045, 0.035],
    top: [0.025, 0.02],
    segments: 8,
    rotation: [Math.PI / 2, 0, 0],
  });
  addBox(3, [0, 5.02, -0.275], [0.16, 0.025, 0.02]);

  addBox(1, [0, 0.02, 0], [4.05, 0.035, 3.34]);
}

function pushBuffer(chunks, buffer) {
  const byteOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(buffer);
  while (chunks.reduce((sum, chunk) => sum + chunk.length, 0) % 4 !== 0) chunks.push(Buffer.from([0]));
  return byteOffset;
}

function accessorMinMax(values, stride) {
  const min = Array(stride).fill(Number.POSITIVE_INFINITY);
  const max = Array(stride).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < values.length; i += stride) {
    for (let j = 0; j < stride; j++) {
      min[j] = Math.min(min[j], values[i + j]);
      max[j] = Math.max(max[j], values[i + j]);
    }
  }
  return { min, max };
}

function buildGlb() {
  buildModel();
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const primitives = [];

  groups.forEach((group, material) => {
    if (group.positions.length === 0) return;
    const positionBuffer = Buffer.from(new Float32Array(group.positions).buffer);
    const normalBuffer = Buffer.from(new Float32Array(group.normals).buffer);
    const indexBuffer = Buffer.from(new Uint32Array(group.indices).buffer);

    const positionOffset = pushBuffer(chunks, positionBuffer);
    const normalOffset = pushBuffer(chunks, normalBuffer);
    const indexOffset = pushBuffer(chunks, indexBuffer);

    const positionView = bufferViews.push({ buffer: 0, byteOffset: positionOffset, byteLength: positionBuffer.length, target: 34962 }) - 1;
    const normalView = bufferViews.push({ buffer: 0, byteOffset: normalOffset, byteLength: normalBuffer.length, target: 34962 }) - 1;
    const indexView = bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: indexBuffer.length, target: 34963 }) - 1;

    const positionBounds = accessorMinMax(group.positions, 3);
    const positionAccessor = accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: group.positions.length / 3,
      type: 'VEC3',
      min: positionBounds.min,
      max: positionBounds.max,
    }) - 1;
    const normalAccessor = accessors.push({
      bufferView: normalView,
      componentType: 5126,
      count: group.normals.length / 3,
      type: 'VEC3',
    }) - 1;
    const indexAccessor = accessors.push({
      bufferView: indexView,
      componentType: 5125,
      count: group.indices.length,
      type: 'SCALAR',
    }) - 1;

    primitives.push({
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
      indices: indexAccessor,
      material,
      mode: 4,
    });
  });

  const binary = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'ai-gateway procedural Cristo Redentor test model' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Cristo Redentor stylized test statue' }],
    meshes: [{ name: 'cristo-redentor-procedural', primitives }],
    materials,
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
  };

  const jsonBuffer = Buffer.from(JSON.stringify(gltf));
  const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuffer, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - (binary.length % 4)) % 4;
  const binChunk = Buffer.concat([binary, Buffer.alloc(binPadding)]);

  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, buildGlb());
console.log(outPath);
