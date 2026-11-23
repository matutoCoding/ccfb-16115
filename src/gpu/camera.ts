/**
 * 轨道相机 + 俯冲浏览。支持 3000m 高空到 20m 坡面的连续缩放,
 * 视角、投影矩阵与 GPU 共用同一套数学。
 */
export interface CameraState {
  /** 注视点(世界坐标) */
  targetX: number;
  targetY: number;
  /** 距离 m */
  distance: number;
  /** 方位角(弧度,自北顺时针) */
  azimuth: number;
  /** 俯仰角(弧度,0 水平,π/2 正俯视) */
  elevation: number;
  /** 视点高程(由地形查询回填,保证俯冲贴地) */
  eyeHeight: number;
  fovYDeg: number;
  aspect: number;
  near: number;
  far: number;
}

export function createCamera(targetX: number, targetY: number): CameraState {
  return {
    targetX,
    targetY,
    distance: 3000,
    azimuth: 0,
    elevation: (60 * Math.PI) / 180,
    eyeHeight: 400,
    fovYDeg: 55,
    aspect: 1,
    near: 0.5,
    far: 12000,
  };
}

export interface Mat4 {
  /** 列优先 16 元素 */
  m: Float32Array;
}

export function perspective(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return { m: out };
}

export function lookAt(eye: [number, number, number], center: [number, number, number], up: [number, number, number]): Mat4 {
  const zx = eye[0] - center[0];
  const zy = eye[1] - center[1];
  const zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz);
  const f0 = zx / len, f1 = zy / len, f2 = zz / len;
  // right = up × f
  let rx = up[1] * f2 - up[2] * f1;
  let ry = up[2] * f0 - up[0] * f2;
  let rz = up[0] * f1 - up[1] * f0;
  len = Math.hypot(rx, ry, rz) || 1;
  rx /= len; ry /= len; rz /= len;
  // true up = f × right
  const ux = f1 * rz - f2 * ry;
  const uy = f2 * rx - f0 * rz;
  const uz = f0 * ry - f1 * rx;
  const out = new Float32Array(16);
  out[0] = rx; out[1] = ux; out[2] = f0; out[3] = 0;
  out[4] = ry; out[5] = uy; out[6] = f1; out[7] = 0;
  out[8] = rz; out[9] = uz; out[10] = f2; out[11] = 0;
  out[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  out[14] = -(f0 * eye[0] + f1 * eye[1] + f2 * eye[2]);
  out[15] = 1;
  return { m: out };
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a.m[0 * 4 + r] * b.m[c * 4 + 0] +
        a.m[1 * 4 + r] * b.m[c * 4 + 1] +
        a.m[2 * 4 + r] * b.m[c * 4 + 2] +
        a.m[3 * 4 + r] * b.m[c * 4 + 3];
    }
  }
  return { m: out };
}

/** 相机眼点世界坐标(eyeHeight 为绝对高程) */
export function eyePosition(cam: CameraState): [number, number, number] {
  const horiz = cam.distance * Math.cos(cam.elevation);
  const vert = cam.distance * Math.sin(cam.elevation);
  const x = cam.targetX + horiz * Math.sin(cam.azimuth);
  const y = cam.targetY + horiz * Math.cos(cam.azimuth);
  const z = cam.eyeHeight + vert;
  return [x, y, z];
}

export function viewProj(cam: CameraState): Mat4 {
  const eye = eyePosition(cam);
  const view = lookAt(eye, [cam.targetX, cam.targetY, cam.eyeHeight - cam.distance * 0.15], [0, 0, 1]);
  const proj = perspective(cam.fovYDeg, cam.aspect, cam.near, cam.far);
  return multiply(proj, view);
}

/** 屏幕射线反投影(用于三维取点/量测),返回世界空间射线起点与方向 */
export function screenRay(
  cam: CameraState,
  ndcX: number,
  ndcY: number,
): { origin: [number, number, number]; dir: [number, number, number] } {
  const eye = eyePosition(cam);
  const proj = perspective(cam.fovYDeg, cam.aspect, cam.near, cam.far);
  const view = lookAt(eye, [cam.targetX, cam.targetY, cam.eyeHeight - cam.distance * 0.15], [0, 0, 1]);
  const vp = multiply(proj, view);
  // 逆矩阵(4x4 解析求逆代价大,这里用通用高斯消元)
  const inv = invert(vp);
  const nearPt = transformPoint(inv, [ndcX, ndcY, -1, 1]);
  const farPt = transformPoint(inv, [ndcX, ndcY, 1, 1]);
  const dx = farPt[0] - nearPt[0];
  const dy = farPt[1] - nearPt[1];
  const dz = farPt[2] - nearPt[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return { origin: eye, dir: [dx / l, dy / l, dz / l] };
}

function invert(a: Mat4): Mat4 {
  const m = a.m;
  const inv = new Float32Array(16);
  const tmp = new Float32Array(16);
  for (let i = 0; i < 16; i++) tmp[i] = m[i];
  for (let i = 0; i < 4; i++) {
    inv[i * 4 + i] = 1;
  }
  for (let col = 0; col < 4; col++) {
    let pivot = tmp[col * 4 + col];
    if (Math.abs(pivot) < 1e-10) {
      for (let r = col + 1; r < 4; r++) {
        if (Math.abs(tmp[r * 4 + col]) > 1e-10) {
          for (let k = 0; k < 4; k++) {
            const t0 = tmp[col * 4 + k]; tmp[col * 4 + k] = tmp[r * 4 + k]; tmp[r * 4 + k] = t0;
            const t1 = inv[col * 4 + k]; inv[col * 4 + k] = inv[r * 4 + k]; inv[r * 4 + k] = t1;
          }
          pivot = tmp[col * 4 + col];
          break;
        }
      }
    }
    for (let k = 0; k < 4; k++) {
      tmp[col * 4 + k] /= pivot;
      inv[col * 4 + k] /= pivot;
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const factor = tmp[r * 4 + col];
      for (let k = 0; k < 4; k++) {
        tmp[r * 4 + k] -= factor * tmp[col * 4 + k];
        inv[r * 4 + k] -= factor * inv[col * 4 + k];
      }
    }
  }
  return { m: inv };
}

function transformPoint(a: Mat4, p: [number, number, number, number]): [number, number, number] {
  const m = a.m;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * p[3];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * p[3];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * p[3];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * p[3];
  return [x / w, y / w, z / w];
}

/** 射线与地形求交:沿射线步进,用高程查询找首次由地上到地下的交点(二分细化) */
export function rayTerrainIntersect(
  origin: [number, number, number],
  dir: [number, number, number],
  heightAt: (x: number, y: number) => number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  maxDist = 6000,
): [number, number, number] | null {
  // 射线整体朝天(方向分量为正即向上,世界 Z 向上)时不可能命中地表
  if (dir[2] >= 0) return null;
  // 越界时按边缘高程钳制,保证射线在地形范围外也有连续地表可比较,
  // 不会因跳过 above/below 状态而漏判交点。
  const clampedHeight = (x: number, y: number) => {
    const cx = x < bounds.minX ? bounds.minX : x > bounds.maxX ? bounds.maxX : x;
    const cy = y < bounds.minY ? bounds.minY : y > bounds.maxY ? bounds.maxY : y;
    return heightAt(cx, cy);
  };
  const step = 4;
  let prevT = 0;
  let prevAbove = origin[2] >= clampedHeight(origin[0], origin[1]);
  for (let t = 0; t <= maxDist; t += step) {
    const x = origin[0] + dir[0] * t;
    const y = origin[1] + dir[1] * t;
    const ground = clampedHeight(x, y);
    const z = origin[2] + dir[2] * t;
    const above = z >= ground;
    if (!above && prevAbove) {
      // 二分细化到 0.05m
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        const mx = origin[0] + dir[0] * mid;
        const my = origin[1] + dir[1] * mid;
        const mz = origin[2] + dir[2] * mid;
        if (mz >= clampedHeight(mx, my)) lo = mid;
        else hi = mid;
      }
      const tt = (lo + hi) / 2;
      const ix = origin[0] + dir[0] * tt;
      const iy = origin[1] + dir[1] * tt;
      // 交点若明显在真实范围外,判定为未命中
      const margin = step * 4;
      if (ix < bounds.minX - margin || ix > bounds.maxX + margin || iy < bounds.minY - margin || iy > bounds.maxY + margin) {
        return null;
      }
      return [ix, iy, heightAt(ix, iy)];
    }
    prevAbove = above;
    prevT = t;
  }
  return null;
}
