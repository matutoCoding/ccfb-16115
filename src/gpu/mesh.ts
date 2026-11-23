/**
 * 静态环块网格:每个 clipmap 级的块拓扑在初始化时构建一次,运行期只更新
 * uniform(环角/焦点),不重建顶点缓冲。
 */
import { buildRingBlocks } from '../core/clipmap';

export interface RingMesh {
  level: number;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

/** 位置属性 vec2f,8 字节/顶点 */
const VERTEX_STRIDE = 8;

export function buildRingMeshes(device: GPUDevice, N: number, levels: number): RingMesh[] {
  const meshes: RingMesh[] = [];
  for (let lvl = 0; lvl < levels; lvl++) {
    const blocks = buildRingBlocks(N, lvl === 0);
    const positions: number[] = [];
    const indices: number[] = [];
    let vertexBase = 0;
    for (const b of blocks) {
      for (let r = b.row0; r < b.row1; r++) {
        for (let c = b.col0; c < b.col1; c++) {
          positions.push(c, r); // localPos: x=col, y=row
        }
      }
      const w = b.col1 - b.col0;
      const h = b.row1 - b.row0;
      for (let r = 0; r < h - 1; r++) {
        for (let c = 0; c < w - 1; c++) {
          const a = vertexBase + r * w + c;
          const ib = a + 1;
          const d = a + w;
          const e = d + 1;
          indices.push(a, d, ib, ib, d, e);
        }
      }
      vertexBase += w * h;
    }
    const vertexBuffer = device.createBuffer({
      label: `ring-vbo-L${lvl}`,
      size: Math.ceil(positions.length * 4 / 4) * 4,
      usage: GPUBufferUsage.VERTEX,
    });
    device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(positions));
    const indexBuffer = device.createBuffer({
      label: `ring-ibo-L${lvl}`,
      size: Math.ceil(indices.length * 4 / 4) * 4,
      usage: GPUBufferUsage.INDEX,
    });
    device.queue.writeBuffer(indexBuffer, 0, new Uint32Array(indices));
    meshes.push({ level: lvl, vertexBuffer, indexBuffer, indexCount: indices.length });
  }
  return meshes;
}

export const TERRAIN_VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
};
