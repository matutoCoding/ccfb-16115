# 矿山复绿三维巡查与治理设计系统

面向闭坑露天采石场季度生态修复验收的网页版三维系统。TypeScript + WebGPU,
高程与影像切片持久化在 IndexedDB,纯算法层与 GPU 解耦并全部有单元测试守护。

## 运行

```bash
npm install
npm run dev        # 开发服务器
npm test           # 55 个单元测试(纯逻辑硬指标)
npm run build      # 类型检查 + 生产构建
# 端到端(先起 dev server 在 5199):
npx vite --port 5199 --strictPort
npx vite-node test/e2e.smoke.ts
```

首次进入「测绘期次」页点击「生成并切片演示数据」,会生成带 **6 级台阶、运输道、
危岩陡坎、封闭积水坑** 的三期采石场(期次间有削坡/回填/客土喷播变化),
并在 Web Worker 内切成多级瓦片入库。

## 六个页面

| 页面 | 能力 |
| --- | --- |
| 矿区档案 | 矿区基础信息、修复范围、季度巡查要求、统计概览 |
| 测绘期次 | 三期 DEM/正射导入、Worker 切片进度、**断点续切** |
| 三维巡查 | clipmap 三维、原始精度取点/量测、坡度分级、两期差分、水文库容 |
| 治理设计 | 三维布削坡线、平台宽/坡比参数、实时设计面与挖填、设计面同套 clipmap |
| 验收台账 | 按台阶/图斑列措施面积期次照片、点行飞至、**危岩遗留自动标红** |
| 设置 | **GPU 缓存预算定死**、clipmap 参数、量测容差、差分阈值 |

## 硬指标与对应测试

### 1. Clipmap 无缝(无裂缝、无 T 形接缝)

`src/core/clipmap.ts` 是与 GPU 无关的纯逻辑,三条不变量由 `test/clipmap.test.ts` 守护:

- **I1 环块覆盖**:`buildRingBlocks` 最细级整块、其余级只画框,并集恰好无重叠无缝隙。
- **I2 morph 共面**:细环外缘奇数顶点在 alpha=1 时精确落到粗格网角点
  (`coarseBilinear` 对线性曲面精确),与粗环三角形共面,杜绝 T 形接缝。
- **I3 金字塔抽稀**:粗级高程取细级对应点(decimate,非平均),值严格一致(仅 float32 舍入)。

WGSL 顶点着色器 `src/gpu/shaders.ts` 用同一套 morph 分解在 GPU 上做几何过渡。

### 2. 显存环形缓存,只补条带、不超预算

- `planToroidalUpdate` 计算焦点移动后新露出的行/列,单步平移上传量 O(N) 而非 O(N²),
  测试断言条带数量、地址与全环一致性。
- `GpuRingCache` 用 `writeTexture` 只写条带;`planGpuCache` 在设置页预算内取最大层级,
  `totalBytes <= budget` 有测试,UI 在预算不足时拒绝保存。

### 3. 量测永远用原始精度,与显示层级隔离

- 参考实现 `queryElevation`(Float64 双线性)在 `src/core/elevation.ts`。
- 瓦片路径 `queryElevationFromTiles` 只读 **level 0** 瓦片(自带 1 像元 halo,
  无需跨瓦片拼接),`test/tiling.test.ts` 用 500 个随机点(含瓦片分界线)对拍,
  误差远小于 1cm(Float32 存储舍入约 1e-4m)。
- 端到端 `test/e2e.smoke.ts` 在浏览器里用页面上报坐标反算参考双线性,断言 ≤1cm。
- GPU 渲染器(`renderer.ts`)只负责显示,应用层取点/量测不经过它。

### 4. 分析与设计

- 坡度四级(<25 / 25–45 / 45–70 / >70°)对应挂网喷播、植生袋、鱼鳞坑、危岩清理,
  8 邻域连通 + marching squares 自动圈图斑算面积。
- 两期差分按台阶分开统计削方/回填;卷帘 UI 与差分着色色带。
- 设计面沿削坡线按平台宽 + 坡比 + 台段高生成,只削不填,与现状同格网走同一 clipmap。
- D8 汇流、汇水面积、台阶内侧排水沟走线、积水坑按水位线算蓄水量(溢流口截断)。
- 危岩遗留 `detectCarriedHazards` 比对相邻两期 >70° 图斑质心,`test/hazard.test.ts` 覆盖。

## 目录结构

```
src/core/      纯算法:clipmap、高程查询、切片、坡度、水文、差分、设计、连通域
src/data/      TileStore 抽象、IndexedDB/内存实现、Worker 切片编排、模拟数据、应用仓库
src/gpu/       WebGPU 渲染器、环形纹理缓存、环块网格、WGSL、相机/射线、View3D 交互
src/workers/   切片 Worker
src/ui/        六页面与主框架
test/          单元测试(*.test.ts)与端到端冒烟(e2e.smoke.ts)
```

## 无 WebGPU 环境

自动回退到 CPU hillshade 俯视图(`FallbackHillshade`),取点/量测/分析路径不变,
精度不受影响,便于在不支持 WebGPU 的机器上演示与验收。
