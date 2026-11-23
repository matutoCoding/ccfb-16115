/**
 * WGSL 着色器:geometry clipmap 地形。
 *
 * 顶点输入为环块内的静态格网坐标 (localRow, localCol) ∈ [0,N)。
 * 每级 uniform 给出环角全局索引与焦点索引,着色器:
 *  1. 全局索引 = 环角 + 局部坐标;
 *  2. 高度从环形 R32 纹理按 toroidal(全局 mod N)采样;
 *  3. morph:框外缘顶点按权重向粗级双线性位置/高程过渡,消除 T 形接缝;
 *  4. 影像从环形 RGBA8 纹理采样。
 */
export const TERRAIN_WGSL = /* wgsl */ `
struct LevelUniform {
  cornerR: f32,
  cornerC: f32,
  focusR: f32,
  focusC: f32,
  resolution: f32,
  originX: f32,
  originY: f32,
  gridRows: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
  pad3: f32,
};

struct GlobalUniform {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  lightDir: vec3<f32>,
  mode: f32,           // 0 影像 1 坡度分级 2 差分 3 设计面叠加
  morphEnabled: f32,
  pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> global: GlobalUniform;
@group(1) @binding(0) var<uniform> level: LevelUniform;
@group(1) @binding(1) var heightTex: texture_2d<f32>;
@group(1) @binding(2) var imageTex: texture_2d<f32>;
@group(1) @binding(3) var<uniform> coarseLevel: LevelUniform;
@group(1) @binding(4) var coarseHeight: texture_2d<f32>;

struct VsIn {
  @location(0) localPos: vec2<f32>,
};

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) morphAlpha: f32,
};

fn tor(g: f32, n: f32) -> i32 {
  var a = i32(g) % i32(n);
  if (a < 0) { a = a + i32(n); }
  return a;
}

fn sampleHeight(tex: texture_2d<f32>, gr: f32, gc: f32, n: f32) -> f32 {
  let dims = textureDimensions(tex);
  let uv = vec2<i32>(tor(gc, f32(dims.x)), tor(gr, f32(dims.y)));
  return textureLoad(tex, uv, 0).r;
}

fn morphWeight(gr: f32, gc: f32) -> f32 {
  let dmax = max(abs(gr - level.focusR), abs(gc - level.focusC));
  let inner = f32(textureDimensions(heightTex).x) * 0.25;
  let outer = f32(textureDimensions(heightTex).x) * 0.5;
  if (dmax <= inner) { return 0.0; }
  if (dmax >= outer) { return 1.0; }
  return (dmax - inner) / (outer - inner);
}

@vertex
fn vs(input: VsIn) -> VsOut {
  var out: VsOut;
  let n = f32(textureDimensions(heightTex).x);
  // 全局细索引
  var gr = level.cornerR + input.localPos.y;
  var gc = level.cornerC + input.localPos.x;

  // 高度(细级)
  var h = sampleHeight(heightTex, gr, gc, n);

  // morph 到粗级
  let alpha = select(0.0, morphWeight(gr, gc), global.morphEnabled > 0.5);
  out.morphAlpha = alpha;
  if (alpha > 0.001) {
    let fr = floor(gr * 0.5);
    let fc = floor(gc * 0.5);
    let tr = gr * 0.5 - fr;
    let tc = gc * 0.5 - fc;
    let h00 = sampleHeight(coarseHeight, fr,     fc,     n * 0.5);
    let h01 = sampleHeight(coarseHeight, fr,     fc + 1.0, n * 0.5);
    let h10 = sampleHeight(coarseHeight, fr + 1.0, fc,     n * 0.5);
    let h11 = sampleHeight(coarseHeight, fr + 1.0, fc + 1.0, n * 0.5);
    let a = mix(h00, h01, tc);
    let b = mix(h10, h11, tc);
    let coarseH = mix(a, b, tr);
    h = mix(h, coarseH, alpha);
    // 位置也向粗格网中点收缩(奇数顶点移动,偶数不动)
    let coarseGr = fr + tr;
    let coarseGc = fc + tc;
    gr = mix(gr, coarseGr * 2.0, alpha);
    gc = mix(gc, coarseGc * 2.0, alpha);
  }

  let wx = level.originX + (gc + 0.5) * level.resolution;
  let wy = level.originY + (level.gridRows - 1.0 - gr + 0.5) * level.resolution;
  out.world = vec3<f32>(wx, wy, h);
  out.clip = global.viewProj * vec4<f32>(wx, wy, h, 1.0);

  // 法线:邻近像元有限差分
  let hr = sampleHeight(heightTex, gr + 1.0, gc, n);
  let hl = sampleHeight(heightTex, gr - 1.0, gc, n);
  let hc = sampleHeight(heightTex, gr, gc + 1.0, n);
  let hd = sampleHeight(heightTex, gr, gc - 1.0, n);
  let dzdx = (hc - hd) / (2.0 * level.resolution);
  let dzdy = -(hr - hl) / (2.0 * level.resolution);
  out.normal = normalize(vec3<f32>(-dzdx, -dzdy, 1.0));

  // 影像色
  let imgUV = vec2<i32>(tor(gc, n), tor(gr, n));
  out.color = textureLoad(imageTex, imgUV, 0);
  return out;
}

fn slopeColor(deg: f32) -> vec3<f32> {
  if (deg < 25.0) { return vec3<f32>(0.30, 0.69, 0.31); }
  if (deg < 45.0) { return vec3<f32>(1.00, 0.76, 0.27); }
  if (deg < 70.0) { return vec3<f32>(1.00, 0.44, 0.26); }
  return vec3<f32>(0.90, 0.22, 0.21);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let nrm = normalize(in.normal);
  let lambert = max(dot(nrm, normalize(global.lightDir)), 0.0);
  let shade = 0.55 + 0.45 * lambert;
  var base = in.color.rgb;
  if (global.mode > 0.5 && global.mode < 1.5) {
    let slopeDeg = atan2(length(nrm.xy), nrm.z) * 57.2958;
    base = slopeColor(slopeDeg);
  }
  return vec4<f32>(base * shade, 1.0);
}
`;

export const LINE_WGSL = /* wgsl */ `
struct GlobalUniform {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  lightDir: vec3<f32>,
  mode: f32,
  morphEnabled: f32,
  pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> global: GlobalUniform;
struct VsIn { @location(0) p: vec3<f32>; };
@vertex
fn vs(input: VsIn) -> @builtin(position) vec4<f32> {
  return global.viewProj * vec4<f32>(input.p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.35, 0.1, 1.0);
}
`;
