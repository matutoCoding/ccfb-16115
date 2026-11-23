import { describe, it, expect } from 'vitest';
import { createCamera, screenRay, rayTerrainIntersect } from '../src/gpu/camera';
import { queryElevation } from '../src/core/elevation';
import { generateMockDataset } from '../src/data/mockGenerator';

describe('真实地形 + 应用默认相机取点', () => {
  const data = generateMockDataset({ size: 320, resolution: 0.5 });
  const dem = data.periods[0].dem;
  const cx = dem.originX + (dem.cols * dem.resolution) / 2;
  const cy = dem.originY + (dem.rows * dem.resolution) / 2;
  const bounds = {
    minX: dem.originX, minY: dem.originY,
    maxX: dem.originX + dem.cols * dem.resolution,
    maxY: dem.originY + dem.rows * dem.resolution,
  };
  const heightAt = (x: number, y: number) => queryElevation(dem, x, y);

  it('默认相机(自适应距离,60°)中心射线命中地形', () => {
    const cam = createCamera(cx, cy);
    cam.aspect = 902 / 828;
    const ground = queryElevation(dem, cx, cy);
    const span = Math.max(dem.rows, dem.cols) * dem.resolution;
    cam.distance = Math.min(3000, Math.max(60, span * 1.8));
    cam.eyeHeight = ground + cam.distance * 0.7;
    const { origin, dir } = screenRay(cam, 0, 0);
    const hit = rayTerrainIntersect(origin, dir, heightAt, bounds, 8000);
    expect(hit).not.toBeNull();
    if (hit) {
      const err = Math.abs(hit[2] - queryElevation(dem, hit[0], hit[1]));
      expect(err).toBeLessThan(0.05);
    }
  });

  it('俯冲到 20m 后中心射线仍连续命中(无穿帮)', () => {
    const cam = createCamera(cx, cy);
    cam.aspect = 902 / 828;
    const ground = queryElevation(dem, cx, cy);
    cam.eyeHeight = ground + 20;
    cam.distance = 20;
    cam.elevation = (70 * Math.PI) / 180;
    const { origin, dir } = screenRay(cam, 0, 0);
    const hit = rayTerrainIntersect(origin, dir, heightAt, bounds, 8000);
    expect(hit).not.toBeNull();
  });

  it('多个屏幕偏移点都能取到合理高程(小地形视锥内)', () => {
    const cam = createCamera(cx, cy);
    cam.aspect = 902 / 828;
    const span = Math.max(dem.rows, dem.cols) * dem.resolution;
    cam.distance = Math.min(3000, Math.max(60, span * 1.8));
    cam.eyeHeight = queryElevation(dem, cx, cy) + cam.distance * 0.7;
    for (const [nx, ny] of [[0, 0], [0.05, 0.03], [-0.05, -0.03]]) {
      const { origin, dir } = screenRay(cam, nx, ny);
      const hit = rayTerrainIntersect(origin, dir, heightAt, bounds, 8000);
      expect(hit, `ndc ${nx},${ny}`).not.toBeNull();
    }
  });
});
