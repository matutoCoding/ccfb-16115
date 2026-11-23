import { describe, it, expect } from 'vitest';
import { detectCarriedHazards } from '../src/ui/pages/acceptancePage';
import type { MapPatch, SlopeClass } from '../src/core/types';

function patch(id: string, cls: SlopeClass, cx: number, cy: number, area: number): MapPatch {
  return {
    id, periodId: 'p', cls,
    polygon: [[cx, cy]],
    areaM2: area, centroid: [cx, cy],
  };
}

describe('危岩遗留检测(上期标记、本期仍在则标红)', () => {
  it('同一位置 >70° 图斑两期都在 -> 标记遗留', () => {
    const prev = [patch('a', 3, 100, 200, 100)];
    const cur = [patch('b', 3, 102, 201, 100)];
    const carried = detectCarriedHazards(prev, cur);
    expect(carried.has('b')).toBe(true);
  });

  it('本期危岩已清理(消失) -> 不标记', () => {
    const prev = [patch('a', 3, 100, 200, 100)];
    const cur = [patch('b', 2, 100, 200, 100)]; // 降级为鱼鳞坑
    expect(detectCarriedHazards(prev, cur).size).toBe(0);
  });

  it('位置明显迁移的危岩不算同一处遗留', () => {
    const prev = [patch('a', 3, 100, 200, 50)];
    const cur = [patch('b', 3, 400, 500, 50)];
    expect(detectCarriedHazards(prev, cur).has('b')).toBe(false);
  });

  it('非危岩类图斑永不标记', () => {
    const prev = [patch('a', 0, 100, 200, 100)];
    const cur = [patch('b', 0, 100, 200, 100)];
    expect(detectCarriedHazards(prev, cur).size).toBe(0);
  });
});
