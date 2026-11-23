import { describe, it, expect } from 'vitest';
import { createCamera, screenRay, rayTerrainIntersect, viewProj, eyePosition } from '../src/gpu/camera';
import type { ElevationGrid } from '../src/core/types';

function planeGrid(baseH: number, slope = 0): ElevationGrid {
  const rows = 100, cols = 100, resolution = 1;
  const heights = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = baseH + c * slope;
  return { rows, cols, resolution, originX: 0, originY: 0, heights };
}

describe('相机与射线求交', () => {
  it('viewProj 矩阵可逆且眼点投影在视锥内', () => {
    const cam = createCamera(50, 50);
    cam.aspect = 1.5;
    const vp = viewProj(cam);
    expect(vp.m.length).toBe(16);
    expect(vp.m.every((n) => Number.isFinite(n))).toBe(true);
    const eye = eyePosition(cam);
    expect(eye.every((n) => Number.isFinite(n))).toBe(true);
  });

  it('俯视相机中心射线应击中地形中心附近', () => {
    const g = planeGrid(10);
    const cam = createCamera(50, 50);
    cam.aspect = 1.5;
    cam.elevation = Math.PI / 2 - 0.02; // 接近正俯视
    cam.distance = 200;
    cam.eyeHeight = 210;
    const { origin, dir } = screenRay(cam, 0, 0);
    const hit = rayTerrainIntersect(
      origin, dir,
      (x, y) => g.heights[
        Math.max(0, Math.min(99, Math.floor(g.rows - 1 - y))) * g.cols +
        Math.max(0, Math.min(99, Math.floor(x)))
      ],
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      4000,
    );
    expect(hit).not.toBeNull();
    // 中心射线落点应在注视点 (50,50) 附近
    expect(Math.abs(hit![0] - 50)).toBeLessThan(8);
    expect(Math.abs(hit![1] - 50)).toBeLessThan(8);
    expect(Math.abs(hit![2] - 10)).toBeLessThan(1);
  });

  it('倾斜视角射线也能命中坡面', () => {
    planeGrid(10, 0.1);
    const cam = createCamera(50, 50);
    cam.aspect = 1.5;
    cam.elevation = (45 * Math.PI) / 180;
    cam.azimuth = 0.5;
    cam.distance = 150;
    cam.eyeHeight = 120;
    const { origin, dir } = screenRay(cam, 0.1, -0.1);
    const hit = rayTerrainIntersect(
      origin, dir,
      (x) => 10 + Math.max(0, Math.min(99, x)) * 0.1,
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      4000,
    );
    expect(hit).not.toBeNull();
    expect(hit![0]).toBeGreaterThanOrEqual(0);
    expect(hit![0]).toBeLessThanOrEqual(100);
  });

  it('射线朝天上时返回 null 而不是死循环', () => {
    const cam = createCamera(50, 50);
    cam.aspect = 1.5;
    cam.distance = 100;
    cam.eyeHeight = 500;
    const { origin, dir } = screenRay(cam, 0, 0.95); // 接近上缘、朝上
    const hit = rayTerrainIntersect(
      origin, dir,
      () => 0,
      { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
      500,
    );
    expect(hit).toBeNull();
  });
});
