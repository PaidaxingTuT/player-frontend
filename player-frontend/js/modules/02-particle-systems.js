// ===== js/02-particle-systems.js =====

// ============================================================
//  粒子点纹理 (干净圆点, 无 glow)
// ============================================================
function makeDotTexture() {
  // 使用小尺寸 canvas 生成点精灵贴图，避免依赖外部图片资源。
  var cv = document.createElement('canvas'); cv.width = cv.height = 64;
  // 2D 上下文用于绘制中心亮、边缘透明的径向渐变。
  var ctx = cv.getContext('2d');
  // 渐变半径覆盖整个点精灵，让片元 shader 能得到柔和圆点。
  var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  // CanvasTexture 直接作为 PointsMaterial/ShaderMaterial 的点纹理。
  var tex = new THREE.CanvasTexture(cv);
  // 线性过滤让点大小变化时边缘更平滑。
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}
// 全局点精灵纹理，主粒子和辉光粒子共用。
var dotTexture = makeDotTexture();

// ============================================================
//  主粒子系统
//   - 5 个 preset, 每个预设走完全不同的 pos 计算
//   - 共享: 封面色采样, 鼠标交互, 粒子大小限制
// ============================================================
// SILK 平面预设的基础正方形尺寸，几何坐标会映射到这个范围。
var PLANE_SIZE = 4.8;
// 同时保留的鼠标涟漪数量上限，shader 中循环次数也按这个值固定。
var RIPPLE_MAX = 12;

// 当前封面粒子网格宽度；高度与宽度一致，形成正方形采样网格。
var GRID_X = coverParticleGridForResolution(fx.coverResolution), GRID_Y = GRID_X;
// 当前粒子总数，供后续统计和材质逻辑引用。
var PCOUNT = GRID_X * GRID_Y;
// 当前几何体的 typed array 引用，重建分辨率时会同步替换。
var positions = null, uvs = null, aRand = null;
// 分辨率切换后的封面重载定时器，用于合并连续调整。
var coverResolutionReloadTimer = null;
// 记录当前封面来源，粒子分辨率变更后用它重新套用封面。
var currentCoverSource = null;
// 复用的封面取色 canvas，避免每次采样都新建画布。
var coverPickerCanvas = null;

// 根据目标网格尺寸重新生成封面粒子几何。
function buildCoverParticleGeometry(grid) {
  // 调用方可能传入历史网格值，这里统一映射回受支持的封面分辨率档位。
  grid = coverParticleGridForResolution(grid / 118);
  // 粒子数量等于网格宽高相乘。
  var count = grid * grid;
  // 新几何体承载 position、aUv 和 aRand 三组属性。
  var nextGeo = new THREE.BufferGeometry();
  // 顶点位置数组，三个浮点数表示一个粒子的本地坐标。
  var nextPositions = new Float32Array(count * 3);
  // 封面采样 UV 数组，两个浮点数表示一个粒子的纹理坐标。
  var nextUvs = new Float32Array(count * 2);
  // 每粒子的随机种子，用于 shader 中制造细微差异。
  var nextRand = new Float32Array(count);
  // 每个网格单元在 UV 空间中的步长。
  var texelStep = 1 / grid;
  for (var i = 0; i < count; i++) {
    // 当前粒子在二维网格中的列和行。
    var gx = i % grid, gy = Math.floor(i / grid);
    // 采样点放在像素格中心，减少边缘采样偏移。
    var u = (gx + 0.5) * texelStep, v = (gy + 0.5) * texelStep;
    // 将网格坐标归一化到 0..1，用于映射到本地平面。
    var px = gx / (grid - 1), py = gy / (grid - 1);
    nextPositions[i*3]   = (px - 0.5) * PLANE_SIZE;
    nextPositions[i*3+1] = (py - 0.5) * PLANE_SIZE;
    nextPositions[i*3+2] = 0;
    nextUvs[i*2]   = u;
    nextUvs[i*2+1] = v;
    nextRand[i]   = Math.random();
  }
  nextGeo.setAttribute('position', new THREE.BufferAttribute(nextPositions, 3));
  nextGeo.setAttribute('aUv',      new THREE.BufferAttribute(nextUvs, 2));
  nextGeo.setAttribute('aRand',    new THREE.BufferAttribute(nextRand, 1));
  // 在 userData 上记录网格信息，便于后续判断是否真的需要重建。
  nextGeo.userData.grid = grid;
  nextGeo.userData.count = count;
  // 同步更新模块级数组引用，供其它运行期逻辑读取最新几何数据。
  positions = nextPositions;
  uvs = nextUvs;
  aRand = nextRand;
  return nextGeo;
}

// 初始粒子几何，后续分辨率变化会替换这个引用。
var geo = buildCoverParticleGeometry(GRID_X);

// 应用封面粒子分辨率设置，并按需重建几何和重载封面。
function applyCoverParticleResolution(value, opts) {
  // opts.reload=false 时只换几何，不触发封面重载。
  opts = opts || {};
  // 先把用户输入归一化为合法分辨率档位。
  fx.coverResolution = normalizeCoverResolution(value);
  // 档位再映射为实际网格尺寸。
  var grid = coverParticleGridForResolution(fx.coverResolution);
  // 如果网格没有变化，直接返回，避免无意义释放和重建 GPU 资源。
  if (grid === GRID_X && geo && geo.userData && geo.userData.grid === grid) return;
  // 保留旧几何，替换成功后再释放。
  var oldGeo = geo;
  // 生成下一版几何。
  var nextGeo = buildCoverParticleGeometry(grid);
  geo = nextGeo;
  // 同步全局网格尺寸和粒子数量。
  GRID_X = GRID_Y = grid;
  PCOUNT = grid * grid;
  // 主粒子和辉光粒子共享同一套几何，因此需要一起替换。
  if (particles) particles.geometry = nextGeo;
  if (bloomParticles) bloomParticles.geometry = nextGeo;
  // 释放旧 BufferGeometry，避免分辨率反复切换造成显存泄漏。
  if (oldGeo && oldGeo !== nextGeo) oldGeo.dispose();
  // 分辨率切换时给视觉一个轻微脉冲，掩盖采样密度变化。
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, 0.18);
  // 默认重新载入当前封面，让新粒子密度使用最新采样。
  if (opts.reload !== false) scheduleCoverResolutionReload();
}

// 延迟重载当前封面，合并连续的分辨率调整。
function scheduleCoverResolutionReload() {
  // 没有封面来源时没有可重载内容。
  if (!currentCoverSource || !currentCoverSource.src) return;
  // 取消上一轮排队，确保只执行最后一次调整。
  if (coverResolutionReloadTimer) clearTimeout(coverResolutionReloadTimer);
  coverResolutionReloadTimer = setTimeout(function(){
    // 定时器触发后清空句柄，便于后续重新排队。
    coverResolutionReloadTimer = null;
    // 执行前再次确认封面来源仍然存在。
    if (!currentCoverSource || !currentCoverSource.src) return;
    if (currentCoverSource.kind === 'url') {
      // URL 封面走图片加载流程，并带上当前曲目 token 防止串歌。
      loadCoverFromUrl(currentCoverSource.src, { trackToken: trackSwitchToken, fromResolutionChange: true });
    } else if (currentCoverSource.kind === 'data') {
      // data URL 封面直接应用，同样携带 token 标记来源。
      applyCoverDataUrl(currentCoverSource.src, { trackToken: trackSwitchToken, fromResolutionChange: true });
    }
  }, 260);
}

// 涟漪数据纹理 (1×N, RGBA: x, y, age, str)
// 每个涟漪占四个浮点数，shader 会按 DataTexture 逐行读取。
var rippleData = new Float32Array(RIPPLE_MAX * 4);
// DataTexture 把 CPU 侧涟漪状态传入 shader。
var rippleTex  = new THREE.DataTexture(rippleData, 1, RIPPLE_MAX, THREE.RGBAFormat, THREE.FloatType);
// 最近邻过滤保证每个涟漪槽位不会被相邻行插值污染。
rippleTex.magFilter = THREE.NearestFilter; rippleTex.minFilter = THREE.NearestFilter;
// JavaScript 侧的涟漪对象池，用于更新 age、强度和坐标。
var ripples = [];
// 初始化固定数量的涟漪槽位，age 为负表示空闲。
for (var ri = 0; ri < RIPPLE_MAX; ri++) ripples.push({ x:0, y:0, age:-10, str:0 });

// 封面纹理 + 边缘/深度纹理
// 当前封面颜色纹理，主 shader 通过它给粒子取色。
var coverTex = new THREE.Texture();
// 封面纹理夹边，避免采样到透明边或重复边缘。
coverTex.minFilter = THREE.LinearFilter; coverTex.magFilter = THREE.LinearFilter;
coverTex.wrapS = THREE.ClampToEdgeWrapping; coverTex.wrapT = THREE.ClampToEdgeWrapping;

// 当前封面的深度、边缘、前景遮罩和亮度纹理。
var coverEdgeTex = new THREE.Texture();  // R=depth, G=edge, B=fg-mask, A=lum
// 深度/边缘贴图使用线性过滤，让位移和亮度过渡更平滑。
coverEdgeTex.minFilter = THREE.LinearFilter; coverEdgeTex.magFilter = THREE.LinearFilter;

// 初始 1×1 像素
(function(){
  // 在真实封面加载前提供占位颜色，避免 shader 采样空纹理。
  var c = document.createElement('canvas'); c.width = c.height = 4;
  // 占位封面使用深色底，启动阶段不会闪白。
  var x = c.getContext('2d'); x.fillStyle = '#1c1c28'; x.fillRect(0,0,4,4);
  coverTex.image = c; coverTex.needsUpdate = true;
  // 深度占位纹理使用中性深度值，避免初始画面产生夸张位移。
  var d = document.createElement('canvas'); d.width = d.height = 4;
  // R 通道 128 表示中性深度，其他通道保持关闭或低影响。
  var dx = d.getContext('2d'); dx.fillStyle = 'rgba(128,0,0,255)'; dx.fillRect(0,0,4,4);
  coverEdgeTex.image = d; coverEdgeTex.needsUpdate = true;
})();

// 前一首封面纹理 (用于切歌渐变)
// 切歌时保留上一张封面，shader 可以在新旧封面之间混合。
var prevCoverTex = new THREE.Texture();
// 前一首封面同样使用线性过滤，保证过渡期间采样一致。
prevCoverTex.minFilter = THREE.LinearFilter; prevCoverTex.magFilter = THREE.LinearFilter;
(function(){
  // 初始上一首封面也使用深色占位，避免第一次切换前采样为空。
  var c = document.createElement('canvas'); c.width = c.height = 4;
  // 占位上下文只负责填充固定底色。
  var x = c.getContext('2d'); x.fillStyle = '#1c1c28'; x.fillRect(0,0,4,4);
  prevCoverTex.image = c; prevCoverTex.needsUpdate = true;
})();

// shader 统一变量集中定义在这里：
// 音频能量、封面纹理、深度纹理、鼠标状态、预设切换和加载态都会从主循环或封面管线写入。
// 新增视觉效果时优先复用这些 uniform，避免在 shader 和 JavaScript 之间散落多套状态。
var uniforms = {
  // 全局动画时间，主循环持续写入。
  uTime:       { value: 0 },
  // 低频能量，主要驱动呼吸、缩放和重低音脉冲。
  uBass:       { value: 0 },
  // 中频能量，主要驱动丝绸起伏和流动细节。
  uMid:        { value: 0 },
  // 高频能量，主要驱动闪烁、细碎扰动和颗粒亮度。
  uTreble:     { value: 0 },
  // 节拍瞬时强度，用于让预设在鼓点上产生短促响应。
  uBeat:       { value: 0 },
  // 综合音频能量，作为全局亮度和活跃度参考。
  uEnergy:     { value: 0 },
  // 预设切换或重载时的通用爆发量。
  uBurstAmt:   { value: 0 },          // 通用预设切换脉冲 0..1
  // 黑胶预设的唱片自旋角度。
  uVinylSpin:  { value: 0 },
  // 当前视觉预设索引，shader 通过区间判断走不同分支。
  uPreset:     { value: 0 },
  // 视觉强度滑块，放大音频位移和扰动。
  uIntensity:  { value: 0.85 },
  // 深度位移强度，主要影响 AI 深度或边缘深度贴图。
  uDepth:      { value: 1.0 },
  // 点精灵全局缩放，控制粒子视觉尺寸。
  uPointScale: { value: 1.0 },
  // 动画速度倍率，用于统一加快或放慢时间。
  uSpeed:      { value: 1.0 },
  // 丝绸预设的扭曲强度。
  uTwist:      { value: 0 },
  // 封面颜色增强参数，影响颜色 gamma 变化。
  uColorBoost: { value: 1.1 },
  // 离散散射强度，用于让粒子产生轻微分散。
  uScatter:    { value: 0 },
  // 封面粒子分辨率档位，shader 用它做高分辨率保护。
  uCoverRes:   { value: 1.0 },
  // 背景压暗强度，深度可用时用于突出前景。
  uBgFade:     { value: 0.20 },
  // 辉光层透明强度。
  uBloomStrength:{ value: 0.62 },
  // 辉光层点大小倍率。
  uBloomSize:  { value: 2.65 },
  // 用户色调覆盖色。
  uTintColor:  { value: new THREE.Color('#9db8cf') },
  // 用户色调混合强度。
  uTintStrength:{ value: 0 },
  // 当前封面颜色纹理。
  uCoverTex:   { value: coverTex },
  // 上一首封面颜色纹理。
  uPrevCoverTex:{ value: prevCoverTex },
  // 新旧封面混合进度。
  uColorMixT:  { value: 1.0 },        // 0=显示旧封面 → 1=显示新封面
  // 深度/边缘/前景遮罩/亮度合并纹理。
  uEdgeTex:    { value: coverEdgeTex },
  // 鼠标涟漪数据纹理。
  uRippleTex:  { value: rippleTex },
  // 当前有效涟漪数量。
  uRippleCount:{ value: 0 },
  // 点精灵透明度纹理。
  uDotTex:     { value: dotTexture },
  // 是否已有真实封面，0 时使用默认渐变色。
  uHasCover:   { value: 0 },
  // 是否已有深度贴图。
  uHasDepth:   { value: 0 },
  // 是否启用边缘增强。
  uEdgeEnabled:{ value: 1 },
  // AI 深度增强权重。
  uAiBoost:    { value: 0 },          // AI 深度增益, 当 AI 接管时升至 1
  // 鼠标在粒子本地平面上的坐标。
  uMouseXY:    { value: new THREE.Vector2(-999, -999) },
  // 鼠标是否正在影响粒子。
  uMouseActive:{ value: 0 },
  // 当前 renderer 像素比，用于修正点大小。
  uPixel:      { value: renderer.getPixelRatio() },
  // 粒子整体透明度，启动淡入和隐藏时使用。
  uAlpha:      { value: 0 },          // 整体粒子透明度 (启动 fade-in)
  // 叠层打开时的粒子压暗系数。
  uParticleDim:{ value: 1 },          // 覆盖层打开时只压低粒子背景, 不影响 3D 卡片
  // 空场浮动粒子透明度。
  uFloatAlpha: { value: 0 },          // 空场/浮空粒子透明度
  // 加载态混合量。
  uLoading:    { value: 0 },          // 加载动画混合度 0..1 (1 = 完全聚成圆环)
};
// 安装与页面可见性、后台省电相关的渲染钩子。
installRenderPowerHooks();
// 立即根据当前状态应用一次渲染功耗策略。
applyRendererPowerMode();

// ----- 顶点 Shader -----
//   v7.1: 律动幅度 ×2.5, Tunnel 自旋, 虚空预设, 切歌颜色渐变
// 顶点 shader 负责粒子位置、封面采样、深度位移和节拍扰动；片元 shader 只接收这里传出的颜色与亮度信息。
var vs = `
precision highp float;
uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uBurstAmt;
uniform float uPreset, uIntensity, uDepth, uPointScale, uSpeed, uTwist;
uniform float uVinylSpin;
uniform float uColorBoost, uScatter, uCoverRes, uBgFade;
uniform float uHasCover, uHasDepth, uEdgeEnabled, uAiBoost;
uniform float uMouseActive, uPixel, uColorMixT, uLoading;
uniform sampler2D uCoverTex, uPrevCoverTex, uEdgeTex, uRippleTex;
uniform int uRippleCount;
uniform vec2 uMouseXY;
uniform vec3 uTintColor;
uniform float uTintStrength;
attribute vec2 aUv;
attribute float aRand;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

#define PI 3.14159265359

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

vec2 safeCoverUv(vec2 uv) {
  return clamp(uv, vec2(0.0012), vec2(0.9988));
}

vec3 sampleNewCoverColor(vec2 uv) {
  return texture2D(uCoverTex, safeCoverUv(uv)).rgb;
}

vec3 samplePrevCoverColor(vec2 uv) {
  return texture2D(uPrevCoverTex, safeCoverUv(uv)).rgb;
}

vec4 sampleEdgeColor(vec2 uv) {
  return texture2D(uEdgeTex, safeCoverUv(uv));
}

float rippleSumAt(vec2 p, out float maxAmp) {
  float sum = 0.0; maxAmp = 0.0;
  for (int ri = 0; ri < 12; ri++) {
    if (ri >= uRippleCount) break;
    float vCoord = (float(ri) + 0.5) / 12.0;
    vec4 rd = texture2D(uRippleTex, vec2(0.5, vCoord));
    float age = rd.z; float str = rd.w;
    if (str < 0.005 || age < 0.0 || age > 2.0) continue;
    float dx = p.x - rd.x, dy = p.y - rd.y;
    float dist = sqrt(dx*dx + dy*dy);
    float lifeN = age / 2.0;
    float fadeIn  = smoothstep(0.0, 0.06, age);
    float fadeOut = 1.0 - smoothstep(0.7, 1.0, lifeN);
    float env = fadeIn * fadeOut;
    // v7.1: 把幅度放大 — 中心凸起更高更宽
    float bulgeW = 0.55 + age * 0.80;
    float bulge  = exp(-dist*dist / (2.0 * bulgeW * bulgeW)) * (1.0 - smoothstep(0.0, 0.55, lifeN));
    float waveR  = age * 2.10;
    float ringW  = 0.40 + age * 0.22;
    float ring   = exp(-pow((dist - waveR) / ringW, 2.0));
    // v7.1: 提升整体幅度 ×2
    float local  = (bulge * 2.4 + ring * 1.30) * env * str;
    sum += local;
    maxAmp = max(maxAmp, abs(local));
  }
  return sum;
}

void main(){
  float t = uTime * uSpeed;
  vec3 pos;
  vec2 sampleUv = safeCoverUv(aUv);
  // 切歌颜色渐变: 在新旧封面间 mix
  vec3 newCol = sampleNewCoverColor(sampleUv);
  vec3 prevCol = samplePrevCoverColor(sampleUv);
  vec3 coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
  vec4 edge = sampleEdgeColor(sampleUv);
  float depthVal = edge.r;
  float edgeVal  = edge.g;
  float fgMask   = edge.b;
  float lumVal   = edge.a;
  float maxRippleAmp = 0.0;
  float rippleZ = 0.0;

  vec3 defaultColor = mix(
    vec3(0.36, 0.28, 0.72),
    mix(vec3(0.85, 0.55, 0.95), vec3(0.45, 0.78, 0.95), aUv.x),
    aUv.y
  );
  vColor = mix(defaultColor, coverColor, uHasCover);
  vAlpha = 1.0;

  // 律动强度的真实倍数 (放大 intensity 滑块的影响)
  float K = uIntensity * 1.6;   // 滑块 1.0 → K=1.6, 滑块 1.6 → K=2.56

  // ====================================================
  //  Preset 0: SILK — 丝绸 (xy 平面, z 涟漪)
  //  v7.1: 全部位移 ×2.5
  // ====================================================
  if (uPreset < 0.5) {
    pos = position;
    rippleZ = rippleSumAt(pos.xy, maxRippleAmp);

    float midN = snoise(vec3(pos.x*1.4, pos.y*1.4, t*0.55)) * 0.6
               + snoise(vec3(pos.x*2.8+5.0, pos.y*2.8-3.0, t*0.85)) * 0.4;
    float midMask = 0.55 + 0.45 * snoise(vec3(pos.x*0.4, pos.y*0.4, t*0.18));
    float midDisp = midN * uMid * 0.55 * midMask * K;       // 0.20 → 0.55

    float trebleJ = snoise(vec3(pos.x*6.5, pos.y*6.5, t*3.5 + aRand*4.0)) * uTreble * 0.18 * K;  // 0.06→0.18
    float bassBreath = snoise(vec3(pos.x*0.35, pos.y*0.35, t*0.4)) * uBass * 0.42 * K;          // 0.14→0.42

    // AI 深度: 显著强化 (0.85 → 1.4)
    float depthZ = (depthVal - 0.5) * uAiBoost * uDepth * 1.40 * uHasDepth;

    pos.z = rippleZ * 1.30 + midDisp + trebleJ + bassBreath + depthZ;
  }

  // ====================================================
  //  Preset 1: TUNNEL — 隧道 + 自旋
  // ====================================================
  else if (uPreset < 1.5) {
    // v7.1: 整体自旋 — 整管缓慢绕 Z 轴
    float spin = t * 0.12;
    float angle = aUv.x * 2.0 * PI + spin;
    float flow = aUv.y - t * 0.08 * (1.0 + uBass * 0.55);
    flow = fract(flow);
    float zPos = (flow - 0.5) * 9.0;
    float baseR = 2.0 - uBass * 0.28 * K;                  // bass 收缩更明显
    float ripG  = sin(angle * 5.0 + zPos * 1.4 + t * 2.2) * 0.10 * (uMid + uTreble) * K;   // 0.04→0.10
    float r = baseR + ripG;
    pos.x = cos(angle) * r;
    pos.y = sin(angle) * r;
    pos.z = zPos;

    sampleUv = vec2(aUv.x, flow);
    sampleUv = safeCoverUv(sampleUv);
    newCol = sampleNewCoverColor(sampleUv);
    prevCol = samplePrevCoverColor(sampleUv);
    coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
    vColor = mix(defaultColor, coverColor, uHasCover);

    float depthFade = smoothstep(-4.5, 4.5, zPos);
    vColor *= 0.4 + depthFade * 0.7;
  }

  // ====================================================
  //  Preset 2: ORBIT — 星球 (保留自转)
  //  v7.1: 律动幅度加大
  // ====================================================
  else if (uPreset < 2.5) {
    float theta = aUv.x * 2.0 * PI;
    float phi   = (aUv.y - 0.5) * PI;
    float baseR = 2.2;
    float trebFlare = snoise(vec3(theta * 1.5, phi * 1.5, t * 0.7)) * uTreble * 0.85 * K;   // 0.40→0.85
    float bassExpand = uBass * 0.35 * K;                                                      // 0.18→0.35
    float r = baseR * (1.0 + bassExpand) + trebFlare;

    pos.x = r * cos(phi) * cos(theta);
    pos.y = r * sin(phi);
    pos.z = r * cos(phi) * sin(theta);

    float yaw = t * 0.18;
    float cy = cos(yaw), sy = sin(yaw);
    pos.xz = mat2(cy, -sy, sy, cy) * pos.xz;
  }

  // ====================================================
  //  Preset 3: VOID — 虚空 (无粒子, 适合自定义背景)
  // ====================================================
  else if (uPreset < 3.5) {
    pos = vec3((aUv.x - 0.5) * 0.01, (aUv.y - 0.5) * 0.01, -90.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    maxRippleAmp = 0.0;
  }

  // ====================================================
  //  Preset 4: VINYL RECORD
  //  A real record layout: circular album cover in the center, black vinyl
  //  grooves outside, and a complete white particle rim.
  // ====================================================
  else if (uPreset < 4.5) {
    // 这一分支把粒子排布成唱片，中间封面、外围沟槽和边缘亮环分层处理。
    float bassDrive = smoothstep(0.08, 0.78, uBass + uBeat * 0.82);
    float highDrive = smoothstep(0.05, 0.46, uTreble);
    float hiResGuard = smoothstep(1.08, 1.55, uCoverRes);
    float edgeGuard = mix(1.0, 0.38, hiResGuard);
    float depthGuard = mix(1.0, 0.44, hiResGuard);
    float grooveGuard = mix(1.0, 0.48, hiResGuard);
    float beatGuard = mix(1.0, 0.36, hiResGuard);

    vec2 p = (aUv - 0.5) * 5.12;
    float spin = uVinylSpin;
    float cs = cos(spin), sn = sin(spin);
    vec2 rp = mat2(cs, -sn, sn, cs) * p;
    float d = length(p);
    float angle0 = atan(p.y, p.x);
    float recordR = 2.46;
    float coverR = 1.18;
    float recordAlpha = 1.0 - smoothstep(recordR - 0.02, recordR + 0.05, d);
    float coverMask = 1.0 - smoothstep(coverR - 0.012, coverR + 0.018, d);
    float border = exp(-pow((d - coverR) / 0.064, 2.0)) * edgeGuard;
    float outerRim = exp(-pow((d - (recordR - 0.050)) / 0.055, 2.0)) * edgeGuard;
    float vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);

    pos = vec3(rp * (1.0 + bassDrive * 0.012 * beatGuard + uBeat * 0.026 * beatGuard), 0.0);
    vAlpha = recordAlpha;

    if (coverMask > 0.02) {
      vec2 coverUv = p / (coverR * 2.0) + 0.5;
      newCol = sampleNewCoverColor(coverUv);
      prevCol = samplePrevCoverColor(coverUv);
      coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
      if (hiResGuard > 0.001) {
        // 高分辨率封面下对封面颜色做轻微邻域柔化，降低密集点阵的闪烁。
        vec2 sx = vec2(0.0026, 0.0);
        vec2 sy = vec2(0.0, 0.0026);
        vec3 softNew = (sampleNewCoverColor(coverUv + sx) + sampleNewCoverColor(coverUv - sx) + sampleNewCoverColor(coverUv + sy) + sampleNewCoverColor(coverUv - sy)) * 0.25;
        vec3 softPrev = (samplePrevCoverColor(coverUv + sx) + samplePrevCoverColor(coverUv - sx) + samplePrevCoverColor(coverUv + sy) + samplePrevCoverColor(coverUv - sy)) * 0.25;
        coverColor = mix(coverColor, mix(softPrev, softNew, clamp(uColorMixT, 0.0, 1.0)), hiResGuard * 0.42);
      }
      vColor = mix(defaultColor, coverColor, uHasCover);
      float coverShade = 1.02 + 0.10 * (1.0 - smoothstep(0.0, coverR, d));
      vColor *= coverShade;
      vColor = mix(vColor, vec3(1.0), border * 0.54);
      pos.z = 0.040 + border * 0.026 * depthGuard + uBeat * 0.018 * beatGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.30 + bassDrive * 0.075 * beatGuard + uBeat * 0.075 * beatGuard);
    } else {
      // 封面圆之外使用程序化沟槽和高频刻痕模拟黑胶盘面。
      float groove = 0.5 + 0.5 * sin((d - coverR) * mix(98.0, 58.0, hiResGuard));
      float fineGroove = 0.5 + 0.5 * sin((d - coverR) * mix(170.0, 92.0, hiResGuard) + aRand * 3.0);
      float tick = smoothstep(0.82, 0.995, hash11(floor((angle0 + PI) * 38.0) + floor(d * 72.0) * 2.1));
      vec3 vinyl = vec3(0.052, 0.054, 0.058) + vec3(0.052 * grooveGuard) * groove + vec3(0.026 * grooveGuard) * fineGroove;
      vinyl = mix(vinyl, coverColor * 0.32, 0.18 * (1.0 - vinylN));
      float whiteRing = max(border * 0.92, outerRim * 0.26);
      vColor = mix(vinyl, vec3(0.92, 0.94, 0.94), whiteRing);
      vColor = mix(vColor, vec3(1.0), tick * highDrive * (0.06 + border * 0.12) * grooveGuard);
      pos.z = groove * 0.010 * grooveGuard + border * 0.024 * depthGuard + bassDrive * vinylN * 0.016 * K * beatGuard + tick * highDrive * 0.010 * grooveGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.32 + outerRim * 0.12 + bassDrive * vinylN * 0.11 * beatGuard + tick * highDrive * 0.10 * grooveGuard + uBeat * vinylN * 0.08 * beatGuard);
    }
  }

  // ====================================================
  //  Preset 5: WALLPAPER PULSE
  //  Layered music-particle wallpaper: aurora ribbons, depth sparks,
  //  and cover-colored audio flow.
  // ====================================================
  else {
    // 壁纸预设把大多数粒子分配给丝带层，少量粒子分配给远景尘点层。
    float bassGlow = smoothstep(0.07, 0.78, uBass) * 0.34 + uBeat * 0.014;
    float midGlow = smoothstep(0.07, 0.62, uMid) * 0.42;
    float highGlow = smoothstep(0.04, 0.46, uTreble) * 0.46;
    float lane = aUv.y;
    float transition = clamp(uBurstAmt, 0.0, 1.0);

    if (lane < 0.80) {
      // 前 80% 粒子生成横向流动的极光丝带。
      float laneWarp = snoise(vec3(aUv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11 + (hash11(aRand * 73.1) - 0.5) * 0.045;
      float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
      float bandCoord = warpedLane / 0.80 * 5.65 + snoise(vec3(aUv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
      float band = floor(bandCoord);
      float local = fract(bandCoord + hash11(band * 9.13 + aRand * 2.4) * 0.18);
      float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
      float seed = hash11(band * 19.17 + aRand * 31.0);
      float flow = fract(aUv.x + t * (0.0034 + bandN * 0.0038 + seed * 0.0022) + seed * 0.53);
      float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + seed * 0.24);
      float armCurve = sin(arc + bandN * 2.2 + seed * 5.3);
      float spiralRadius = 9.2 + bandN * 11.8 + seed * 6.0 + local * 2.9;
      float x = cos(arc * 0.72 + bandN * 0.92 + seed * 1.3) * spiralRadius + (flow - 0.5) * (13.5 + bandN * 9.5);
      float ribbonPhase = flow * PI * 2.0 * (0.55 + bandN * 0.24 + seed * 0.10) + t * (0.010 + bandN * 0.007) + seed * 5.7;
      float broadWave = sin(ribbonPhase) * 0.92;
      float fineWave = sin(ribbonPhase * (1.36 + seed * 0.62) - t * 0.044 + seed * 5.0) * 0.045;
      float yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6) + (seed - 0.5) * 1.85 + snoise(vec3(bandN * 2.0, flow * 0.62, seed)) * 0.92;
      float ridgeCenter = 0.43 + (seed - 0.5) * 0.18;
      float ridge = exp(-pow((local - ridgeCenter) / (0.25 + seed * 0.04), 2.0));
      float softMask = smoothstep(0.010, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));
      float ribbonNoise = snoise(vec3(flow * 1.18 + seed, bandN * 2.0, t * 0.018)) * 0.74;
      float zLayer = mix(-23.5, 15.5, bandN) + (seed - 0.5) * 6.0;

      pos.x = x + ribbonNoise * 1.40 + sin(t * 0.012 + seed * 8.0) * 0.22;
      pos.y = yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14);
      pos.z = zLayer + broadWave * 1.35 + ribbonNoise * 1.85;

      float pulseLine = 0.5 + 0.5 * sin(ribbonPhase * (1.7 + seed * 0.9) - t * 0.32 + seed * 6.0);
      vec3 aurora = mix(vec3(0.52, 0.86, 1.0), vec3(0.70, 0.58, 1.0), bandN);
      aurora = mix(aurora, vec3(0.96, 0.98, 0.92), bassGlow * 0.05);
      vAlpha = (0.18 + ridge * 0.78 + pulseLine * highGlow * 0.035 + bassGlow * 0.025) * softMask * (0.96 + transition * 0.02);
      vColor = mix(coverColor, aurora, 0.62 + ridge * 0.22) * (0.76 + ridge * 0.86 + pulseLine * highGlow * 0.05 + bassGlow * 0.04);
      maxRippleAmp = max(maxRippleAmp, ridge * (0.12 + midGlow * 0.05) + pulseLine * highGlow * 0.045 + bassGlow * 0.030);
    } else {
      // 剩余粒子作为远景尘点和星光，提供空间层次。
      float q = (lane - 0.80) / 0.20;
      float seed = hash11(aRand * 917.0 + floor(q * 130.0));
      float depth = mix(-32.0, 18.0, seed);
      float drift = fract(aUv.x + t * (0.0014 + seed * 0.0048) + seed * 0.63);
      float cluster = snoise(vec3(seed * 2.0, q * 3.2, t * 0.007));
      float x = (drift - 0.5) * (45.0 + seed * 22.0) + cluster * 3.4;
      float y = (hash11(aRand * 331.0 + seed * 5.0) - 0.5) * 22.0 + sin(t * (0.018 + seed * 0.028) + seed * 7.0) * 0.86;
      float z = depth + sin(t * (0.020 + seed * 0.032) + aRand * 8.0) * 1.05;
      float twinkle = pow(0.5 + 0.5 * sin(t * (0.24 + seed * 0.42) + aRand * 17.0), 5.0);
      float dust = smoothstep(0.22, 0.98, hash11(aRand * 661.0 + floor(q * 160.0)));

      pos = vec3(x, y, z);
      vAlpha = dust * (0.16 + twinkle * 0.46 + highGlow * 0.025 + bassGlow * 0.018) * (1.0 - q * 0.06);
      vColor = mix(coverColor, vec3(0.92, 0.97, 1.0), 0.62 + twinkle * 0.14) * (0.72 + twinkle * 0.62 + bassGlow * 0.025);
      maxRippleAmp = max(maxRippleAmp, twinkle * highGlow * 0.055 + dust * bassGlow * 0.030);
    }

    if (transition > 0.001) {
      // 预设切换时用轻微爆发扰动掩盖粒子重新组织。
      float bloom = smoothstep(0.0, 1.0, transition);
      vec2 burstVec = pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.75;
      vec2 burstDir = burstVec / max(length(burstVec), 0.001);
      pos.xy += burstDir * bloom * 0.026;
      pos.xy += vec2(snoise(vec3(aRand, t * 0.014, 1.0)), snoise(vec3(aRand, t * 0.014, 5.0))) * bloom * 0.06;
      pos.xy *= 1.0 + bloom * 0.014;
      pos.z += (hash11(aRand * 123.0) - 0.5) * bloom * 0.18;
      vAlpha *= 0.86 + bloom * 0.22;
      maxRippleAmp = max(maxRippleAmp, bloom * 0.10);
    }
  }

  // ====================================================
  //  鼠标交互 (仅 SILK)
  // ====================================================
  if (uMouseActive > 0.5 && uPreset < 0.5) {
    float mdx = pos.x - uMouseXY.x;
    float mdy = pos.y - uMouseXY.y;
    float md = sqrt(mdx*mdx + mdy*mdy);
    if (md < 1.0) {
      float push = (1.0 - md) * (1.0 - md);
      pos.z += push * 0.55;
    }
  }

  // ====================================================
  //  通用: 离散感 / 扭曲
  // ====================================================
  if (uScatter > 0.001) {
    vec2 jdir = vec2(cos(aRand * 6.2831), sin(aRand * 6.2831));
    pos.xy += jdir * uScatter * (0.05 + uTreble * 0.10);
  }
  if (uTwist > 0.001 && uPreset < 0.5) {
    float ta = uTwist * pos.z * 0.6;
    float cs = cos(ta), sn = sin(ta);
    pos.xy = mat2(cs, -sn, sn, cs) * pos.xy;
  }

  // 颜色
  float vinylHiResGuard = smoothstep(1.08, 1.55, uCoverRes) * step(3.5, uPreset) * (1.0 - step(4.5, uPreset));
  float edgeBoost = uEdgeEnabled * edgeVal * mix(1.0, 0.42, vinylHiResGuard);
  vSourceLum = dot(max(vColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));
  float blackParticleGuard = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  vEdgeBoost = edgeBoost * (uPreset > 3.5 ? 0.22 : 1.0) * (1.0 - blackParticleGuard);
  vColor = pow(max(vColor, vec3(0.0)), vec3(1.0 / max(0.35, uColorBoost)));
  float edgeColorMix = edgeBoost * (uPreset > 3.5 ? 0.20 : 0.50) * (1.0 - blackParticleGuard);
  vColor = mix(vColor, vColor + vec3(0.20), edgeColorMix);
  float tintLum = max(max(vColor.r, vColor.g), vColor.b);
  vec3 tintedColor = uTintColor * max(0.24, tintLum * 1.12);
  vColor = mix(vColor, tintedColor, clamp(uTintStrength, 0.0, 1.0) * (1.0 - blackParticleGuard));

  vBright = 0.82 + maxRippleAmp * 0.55 + uBass * 0.10 + edgeBoost * 0.30 + uEnergy * 0.05 + uBurstAmt * 0.40;
  if (uPreset > 4.5) {
    vBright = 0.94 + maxRippleAmp * 0.34 + uBass * 0.020 + uEnergy * 0.026 + uBurstAmt * 0.025;
  } else if (uPreset > 3.5) {
    vBright = 0.94 + maxRippleAmp * 0.64 + uBass * 0.08 + edgeBoost * 0.12 + uEnergy * 0.05 + uBeat * 0.16 + uBurstAmt * 0.16;
  }
  vRipple = clamp(maxRippleAmp * 1.5, 0.0, 1.0);

  if (uHasDepth > 0.5 && uPreset < 0.5) {
    float bgMul = mix(1.0, 0.55, uBgFade * (1.0 - fgMask));
    vBright *= bgMul;
  }
  float loadingMistSize = 1.0;

  // 加载形态: 雾状微尘流，避免廉价旋转圆环
  if (uLoading > 0.001) {
    float mistSeed = hash11(aRand * 931.7);
    float mistLayer = floor(mistSeed * 4.0);
    float layerN = (mistLayer + 0.5) / 4.0;
    float mistAngle = aRand * 6.2831 + uTime * (0.16 + mistSeed * 0.18) + snoise(vec3(aRand * 2.1, uTime * 0.24, 2.0)) * 1.85;
    float mistR = mix(1.35, 3.15, sqrt(hash11(aRand * 127.3))) * (1.0 + sin(uTime * 0.42 + aRand * 7.0) * 0.13);
    vec2 mistCurl = vec2(
      snoise(vec3(aRand * 4.1, uTime * 0.32, 3.0)),
      snoise(vec3(aRand * 4.7, uTime * 0.30, 8.0))
    );
    float mistBreath = 0.5 + 0.5 * sin(uTime * (0.82 + mistSeed * 0.55) + aRand * 17.0);
    float mistRibbon = sin(mistAngle * (1.35 + layerN * 0.55) + uTime * 0.34 + mistSeed * 4.0);
    float glowPick = smoothstep(0.88, 0.997, hash11(aRand * 1501.0 + mistLayer * 17.0));
    float dustPick = 0.34 + glowPick * 0.66;
    vec3 mistPos = vec3(
      cos(mistAngle) * mistR * (1.24 + mistCurl.x * 0.16) + mistCurl.x * 0.72,
      sin(mistAngle * 0.82 + mistRibbon * 0.25) * mistR * (0.56 + layerN * 0.10) + mistCurl.y * 0.62,
      (layerN - 0.5) * 4.85 + mistCurl.x * 0.56 + mistBreath * 0.36 + mistRibbon * 0.24
    );
    vec3 mistCol = mix(vec3(0.62, 0.86, 0.84), vec3(0.36, 0.46, 0.78), mistSeed);
    mistCol = mix(mistCol, vec3(0.94, 1.0, 0.97), glowPick * (0.45 + mistBreath * 0.35));
    vColor = mix(vColor, mistCol, uLoading * 0.78);
    vBright = mix(vBright, 0.20 + mistBreath * 0.18 + abs(mistCurl.x) * 0.06 + glowPick * (0.72 + abs(mistRibbon) * 0.24), uLoading);
    vAlpha = mix(vAlpha, 0.08 + mistBreath * 0.11 + dustPick * 0.11 + glowPick * 0.30, uLoading);
    pos = mix(pos, mistPos, uLoading);
    loadingMistSize = 1.26 + mistBreath * 0.24 + abs(mistRibbon) * 0.14 + glowPick * 0.78;
  }

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 36.0 / max(0.5, -mvPos.z);
  float audioBoost = 1.0 + maxRippleAmp * 0.7 + edgeBoost * 0.55 + uBeat * 0.30 + uBurstAmt * 0.5;
  float sz = clamp(depthSize * audioBoost, 1.05, 4.95);
  if (uPreset > 4.5) {
    float flowDrive = uBass * 0.070 + uMid * 0.046 + uTreble * 0.060 + uBurstAmt * 0.090 + uBeat * 0.055;
    sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);
  } else if (uPreset > 3.5) {
    float ringDrive = uBass * 0.30 + uMid * 0.18 + uTreble * 0.22 + uBeat * 0.30;
    sz = clamp(depthSize * (0.90 + ringDrive * 0.62), 1.05, 3.90);
  }
  // 加载态下粒子稍大
  sz = mix(sz, sz * loadingMistSize, uLoading);
  gl_PointSize = sz * uPixel * uPointScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

// ----- 片元 Shader -----
var fs = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uPreset, uParticleDim;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  vec3 col = vColor * vBright;
  col = mix(col, col * 1.3 + vec3(0.05), vEdgeBoost * 0.35);
  col = mix(col, col * 1.2, vRipple * 0.4);
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float nonBlack = 1.0 - keepBlack;
  float dotDist = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float readableRim = smoothstep(0.44, 0.94, dotDist) * (1.0 - smoothstep(0.94, 1.08, dotDist)) * tex.a;
  float outLum = dot(col, vec3(0.299, 0.587, 0.114));
  float lightParticle = smoothstep(0.50, 0.82, outLum) * nonBlack;
  float darkParticle = (1.0 - smoothstep(0.20, 0.50, outLum)) * nonBlack;
  col = mix(col, vec3(0.0), readableRim * lightParticle * 0.38);
  col = mix(col, vec3(1.0), readableRim * darkParticle * 0.20);
  col = clamp(col, vec3(0.0), vec3(1.6));
  gl_FragColor = vec4(col, tex.a * uAlpha * uParticleDim * vAlpha);
}
`;

var material = new THREE.ShaderMaterial({
  // 主材质负责可读的正常混合粒子层。
  uniforms: uniforms, vertexShader: vs, fragmentShader: fs,
  transparent: true, depthWrite: false, blending: THREE.NormalBlending,
});

// 辉光顶点 shader 复用主顶点逻辑，只额外加入 uBloomSize 放大点尺寸。
var bloomVs = vs
  .replace('uniform float uMouseActive, uPixel, uColorMixT, uLoading;', 'uniform float uMouseActive, uPixel, uColorMixT, uLoading, uBloomSize;')
  .replace('gl_PointSize = sz * uPixel * uPointScale;', 'gl_PointSize = sz * uPixel * uPointScale * uBloomSize;');
// 辉光片元 shader 使用加法混合，给亮点和边缘提供柔光。
var bloomFs = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uBloomStrength, uPreset, uParticleDim;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.01) discard;
  float soft = tex.a * tex.a;
  vec3 col = vColor * (0.55 + vBright * 0.62);
  col = mix(col, col + vec3(0.22, 0.18, 0.10), vEdgeBoost * 0.35);
  col = clamp(col, vec3(0.0), vec3(1.8));
  float pulse = 1.0 + vRipple * 0.65;
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float bloomKeep = 1.0 - keepBlack * 0.92;
  gl_FragColor = vec4(col, soft * uAlpha * uBloomStrength * uParticleDim * pulse * 0.55 * vAlpha * bloomKeep);
}
`;
var bloomMaterial = new THREE.ShaderMaterial({
  // 辉光材质关闭深度测试，让柔光不被主粒子层遮断。
  uniforms: uniforms, vertexShader: bloomVs, fragmentShader: bloomFs,
  transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
});
// 辉光粒子层先渲染，作为主粒子背后的柔光底。
var bloomParticles = new THREE.Points(geo, bloomMaterial);
bloomParticles.frustumCulled = false;
bloomParticles.renderOrder = 0;
scene.add(bloomParticles);
// 主粒子层负责最终可见的封面颜色、形状和可读边缘。
var particles = new THREE.Points(geo, material);
particles.frustumCulled = false;
particles.renderOrder = 1;
scene.add(particles);
// 调试日志保留原样，用于确认主粒子 shell 已经完成初始化。
console.log('v7 shell loaded, JS pending');

// ============================================================
//  浮空粒子层 (独立 Points)
//   v7.1: 速度大幅放慢, 改用 sin/cos 长周期漂移 (优雅而非乱飞)
// ============================================================
// 浮空粒子数量，当前实现保留参数但默认禁用这一层。
var FLOAT_COUNT = 1300;
// 浮空粒子的 Points 容器；为 null 表示未创建或已销毁。
var floatGroup = null;
// 浮空粒子几何数据缓存：当前位置、基准位置、相位和颜色。
var floatPositionsArr = null, floatBaseArr = null, floatPhaseArr = null, floatColorArr = null;

// 创建浮空粒子层；当前函数开头会主动禁用并返回，后续代码作为保留实现存在。
function createFloatLayer() {
  // 强制关闭浮空层配置，避免这一层参与当前视觉。
  fx.floatLayer = false;
  // 同步把 shader 透明度归零。
  uniforms.uFloatAlpha.value = 0;
  // 如果历史上已创建过浮空层，立即销毁。
  if (floatGroup) destroyFloatLayer();
  // 当前版本不继续创建浮空层，下方实现保留以便后续恢复。
  return;
  if (floatGroup) return;
  // 浮空层使用独立几何，避免和封面粒子共享属性。
  var fgeo = new THREE.BufferGeometry();
  // 当前位置数组。
  floatPositionsArr = new Float32Array(FLOAT_COUNT * 3);
  // 基准位置数组，shader 漂移围绕这个位置展开。
  floatBaseArr      = new Float32Array(FLOAT_COUNT * 3);  // 基准位置
  // 每个粒子的三轴相位，控制漂移节奏差异。
  floatPhaseArr     = new Float32Array(FLOAT_COUNT * 3);  // 每粒子相位 (0..2π)
  // 每个粒子的 RGB 颜色。
  floatColorArr     = new Float32Array(FLOAT_COUNT * 3);
  // 每个粒子的随机种子。
  var floatRandArr  = new Float32Array(FLOAT_COUNT);
  // 每个粒子的漂移幅度。
  var floatAmpArr   = new Float32Array(FLOAT_COUNT);      // 漂移幅度 (0.15-0.45)
  for (var i = 0; i < FLOAT_COUNT; i++) {
    // 大部分粒子围绕中心形成光晕，少量粒子散布在更大的空间里。
    var halo = i < FLOAT_COUNT * 0.76;
    // 单个粒子的基准坐标。
    var bx, by, bz;
    if (halo) {
      // 光晕粒子用极坐标分布，形成椭圆环绕效果。
      var a = Math.random() * Math.PI * 2;
      var r = 0.62 + Math.pow(Math.random(), 0.72) * 2.75;
      var lane = (Math.random() - 0.5) * 0.62;
      bx = Math.cos(a) * r;
      by = Math.sin(a) * r * 0.54 + lane;
      bz = (Math.random() - 0.5) * 2.4 - 0.25;
    } else {
      // 非光晕粒子随机填充更大的背景空间。
      bx = (Math.random() - 0.5) * 8.4;
      by = (Math.random() - 0.5) * 5.8;
      bz = (Math.random() - 0.5) * 5.6;
    }
    // 写入基准位置和初始位置。
    floatBaseArr[i*3]   = bx; floatBaseArr[i*3+1] = by; floatBaseArr[i*3+2] = bz;
    floatPositionsArr[i*3]   = bx;
    floatPositionsArr[i*3+1] = by;
    floatPositionsArr[i*3+2] = bz;
    floatPhaseArr[i*3]   = Math.random() * Math.PI * 2;
    floatPhaseArr[i*3+1] = Math.random() * Math.PI * 2;
    floatPhaseArr[i*3+2] = Math.random() * Math.PI * 2;
    floatAmpArr[i] = 0.15 + Math.random() * 0.35;
    // 初始颜色使用接近白色的细微随机值，封面加载后会被替换。
    var white = 0.88 + Math.random() * 0.12;
    floatColorArr[i*3]   = white;
    floatColorArr[i*3+1] = white;
    floatColorArr[i*3+2] = white;
    floatRandArr[i] = Math.random();
  }
  fgeo.setAttribute('position', new THREE.BufferAttribute(floatPositionsArr, 3));
  fgeo.setAttribute('aColor',   new THREE.BufferAttribute(floatColorArr, 3));
  fgeo.setAttribute('aRand',    new THREE.BufferAttribute(floatRandArr, 1));

  // 把 amp + phase 存到 attribute 让 shader 端做漂移 (避免 JS 每帧改 buffer)
  fgeo.setAttribute('aAmp',     new THREE.BufferAttribute(floatAmpArr, 1));
  fgeo.setAttribute('aPhase',   new THREE.BufferAttribute(floatPhaseArr, 3));

  // 浮空层顶点 shader 负责慢速旋转、呼吸和三轴漂移。
  var fvs = `
    precision highp float;
    uniform float uTime, uBass, uPixel, uFloatAlpha;
    attribute vec3 aColor;
    attribute vec3 aPhase;
    attribute float aRand, aAmp;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec3 pos = position;
      float orbit = uTime * (0.030 + aRand * 0.034);
      float cs = cos(orbit), sn = sin(orbit);
      pos.xy = mat2(cs, -sn, sn, cs) * pos.xy;
      float breathe = 1.0 + sin(uTime * 0.34 + aPhase.x) * 0.045;
      pos.xy *= breathe;
      pos.x += sin(uTime * (0.18 + aRand * 0.05) + aPhase.x) * aAmp * 0.34;
      pos.y += cos(uTime * (0.15 + aRand * 0.06) + aPhase.y) * aAmp * 0.30;
      pos.z += sin(uTime * (0.11 + aRand * 0.04) + aPhase.z) * aAmp * 0.68 + uBass * 0.10 * sin(aRand * 12.0);
      vC = aColor;
      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
      float dist = -mvPos.z;
      float twinkle = 0.62 + 0.38 * sin(uTime * (0.42 + aRand * 0.34) + aPhase.z);
      vA = clamp(0.22 + (5.0 - dist) * 0.10, 0.055, 0.58) * twinkle;
      float sz = clamp(40.0 / max(0.5, dist), 1.3, 4.1);
      gl_PointSize = sz * uPixel;
      gl_Position = projectionMatrix * mvPos;
    }
  `;
  // 浮空层片元 shader 只使用圆点纹理控制透明边缘。
  var ffs = `
    precision highp float;
    uniform sampler2D uDotTex;
    uniform float uFloatAlpha;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec4 tex = texture2D(uDotTex, gl_PointCoord);
      if (tex.a < 0.02) discard;
      gl_FragColor = vec4(vC, tex.a * vA * uFloatAlpha);
    }
  `;
  // 浮空层材质复用全局时间、低频、像素比和圆点纹理 uniform。
  var fmat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uBass: uniforms.uBass,
      uPixel: uniforms.uPixel,
      uDotTex: uniforms.uDotTex,
      uFloatAlpha: uniforms.uFloatAlpha,
    },
    vertexShader: fvs, fragmentShader: ffs,
    transparent:true, depthWrite:false, blending: THREE.AdditiveBlending,
  });
  // 创建浮空 Points 并加入主场景。
  floatGroup = new THREE.Points(fgeo, fmat);
  floatGroup.frustumCulled = false;
  scene.add(floatGroup);
}
// 销毁浮空粒子层并释放对应 GPU 资源。
function destroyFloatLayer() {
  // 未创建时无需处理。
  if (!floatGroup) return;
  scene.remove(floatGroup);
  // 几何和材质都由浮空层独占，可以直接释放。
  floatGroup.geometry.dispose(); floatGroup.material.dispose();
  floatGroup = null;
}

// ============================================================
//  安魂 — 3D 粒子建模层
// ============================================================
// 骷髅粒子预设在 fx.preset 中的索引。
var SKULL_PRESET_INDEX = 6;
var SONIC_TOPGRAPHY_INDEX = 7;

// 骷髅模型的基础 X 轴俯仰角。
var SKULL_MODEL_BASE_ROTATION_X = -0.26;
// 骷髅模型的基础 Y 轴朝向角。
var SKULL_MODEL_BASE_ROTATION_Y = 0.00;
// 骷髅模型的默认缩放。
var SKULL_MODEL_SCALE = 2.34;
// 骷髅模型默认摆放位置。
var SKULL_MODEL_BASE_POSITION = { x: 0, y: 0.22, z: 0.10 };
// 音频驱动的整体脉冲缩放缓存。
var skullAmpPulse = 0;
// 节拍闪光强度缓存。
var skullBeatFlash = 0;
// 下颌张开程度缓存。
var skullJawOpen = 0;
// 骷髅专属相机接管混合度。
var skullCameraBlend = 0;
// 当前滚轮缩放值。
var skullWheelZoom = 0;
// 滚轮缩放目标值，逐帧缓动到 skullWheelZoom。
var skullWheelZoomTarget = 0;
// 骷髅相机目标位置。
var skullCameraTargetPos = new THREE.Vector3();
// 骷髅相机目标注视点。
var skullCameraTargetLook = new THREE.Vector3();
// 骷髅普通布局下的相机位置。
var skullCameraBasePos = new THREE.Vector3();
// 骷髅普通布局下的相机注视点。
var skullCameraBaseLook = new THREE.Vector3();
// 歌单架组合布局下的相机位置。
var skullCameraShelfPos = new THREE.Vector3();
// 歌单架组合布局下的相机注视点。
var skullCameraShelfLook = new THREE.Vector3();
// 与轨道相机注视点混合后的实际 lookAt。
var skullCameraMixedLook = new THREE.Vector3();
// 歌单架组合构图混合度。
var skullShelfCameraMix = 0;
// 歌词贴近骷髅嘴部时使用的本地坐标。
var skullLyricMouthLocal = new THREE.Vector3(0.025, -0.72, 0.62);
// 骷髅嘴部在世界坐标中的歌词目标点。
var skullLyricMouthTarget = new THREE.Vector3();
// 骷髅嘴部朝向向量。
var skullLyricMouthForward = new THREE.Vector3();
// 骷髅嘴部朝向四元数。
var skullLyricMouthQuat = new THREE.Quaternion();
// 让嘴部歌词保持可读性的修正四元数。
var skullLyricReadableQuat = new THREE.Quaternion();
// 骷髅粒子的 Points 容器。
var skullParticleGroup = null;
// 骷髅粒子整体透明度缓动值。
var skullParticleOpacity = 0;
// 骷髅粒子二进制资源缓存，避免重复 fetch。
var skullParticleAsset = { data: null, promise: null, failed: false };
// 骷髅默认色板和中性色板。
var skullBaseColors = {
  boneA: new THREE.Color('#b8ae98'),
  boneB: new THREE.Color('#fff4d8'),
  shadow: new THREE.Color('#100d0d'),
  light: new THREE.Color('#ffe3a0'),
  neutralBoneA: new THREE.Color('#9fb7c8'),
  neutralBoneB: new THREE.Color('#eef9ff'),
  neutralShadow: new THREE.Color('#070b12'),
  neutralLight: new THREE.Color('#d6f3ff')
};
// 骷髅调色时复用的 Color 对象，减少每帧分配。
var skullTintScratch = {
  tint: new THREE.Color(),
  soft: new THREE.Color(),
  bright: new THREE.Color(),
  dark: new THREE.Color(),
  boneA: new THREE.Color(),
  boneB: new THREE.Color(),
  shadow: new THREE.Color(),
  light: new THREE.Color()
};

// 计算骷髅预设当前应该使用的色调和强度。
function effectiveSkullVisualTint() {
  // 优先读取舞台歌词从封面提取出的色板。
  var pal = stageLyrics && (stageLyrics.coverPalette || stageLyrics.palette) || {};
  // 自定义色调模式使用用户设置，否则跟随封面色板。
  var custom = fx && fx.visualTintMode === 'custom';
  // 色彩优先级：自定义色、封面辅助色、封面主色、默认色。
  var color = custom
    ? fx.visualTintColor
    : (pal.secondary || pal.primary || fx.visualTintColor || fxDefaults.visualTintColor || '#9db8cf');
  // 统一成合法十六进制颜色，防止无效设置写入 Three.Color。
  color = normalizeHexColor(color || '#9db8cf', '#9db8cf');
  // 自定义色调更强，封面色板只轻度影响骨色。
  var strength = custom ? 0.98 : (pal && (pal.secondary || pal.primary) ? 0.30 : 0.14);
  return { color: color, strength: strength, custom: custom };
}

// 把当前视觉色调同步到骷髅粒子材质。
function syncSkullParticleColors() {
  // 骷髅层还未创建时无需同步。
  if (!skullParticleGroup || !skullParticleGroup.material || !skullParticleGroup.material.uniforms) return;
  // 缓存 uniform 引用，减少重复链式访问。
  var u = skullParticleGroup.material.uniforms;
  // 取得当前有效色调。
  var tint = effectiveSkullVisualTint();
  // 自定义模式会使用更高的色彩替换权重。
  var custom = !!tint.custom;
  // 限制强度范围，避免骨色被完全冲掉。
  var strength = clampRange(Number(tint.strength) || 0, 0, custom ? 0.99 : 0.78);
  // 先把字符串色写入 scratch，再派生柔和、高亮和阴影色。
  skullTintScratch.tint.set(tint.color);
  skullTintScratch.soft.copy(skullTintScratch.tint).lerp(new THREE.Color('#e8f5ff'), custom ? 0.05 : 0.28);
  skullTintScratch.bright.copy(skullTintScratch.tint).lerp(new THREE.Color(custom ? '#f6fbff' : '#fff7d6'), custom ? 0.14 : 0.46);
  skullTintScratch.dark.copy(skullTintScratch.tint).lerp(new THREE.Color('#05070c'), custom ? 0.74 : 0.72);
  skullTintScratch.boneA.copy(custom ? skullBaseColors.neutralBoneA : skullBaseColors.boneA).lerp(skullTintScratch.soft, strength * (custom ? 0.99 : 0.64));
  skullTintScratch.boneB.copy(custom ? skullBaseColors.neutralBoneB : skullBaseColors.boneB).lerp(skullTintScratch.bright, strength * (custom ? 0.94 : 0.46));
  skullTintScratch.shadow.copy(custom ? skullBaseColors.neutralShadow : skullBaseColors.shadow).lerp(skullTintScratch.dark, strength * (custom ? 0.72 : 0.42));
  skullTintScratch.light.copy(custom ? skullBaseColors.neutralLight : skullBaseColors.light).lerp(skullTintScratch.bright, strength * (custom ? 0.98 : 0.76));
  if (u.uColorA) u.uColorA.value.copy(skullTintScratch.boneA);
  if (u.uColorB) u.uColorB.value.copy(skullTintScratch.boneB);
  if (u.uShadow) u.uShadow.value.copy(skullTintScratch.shadow);
  if (u.uLight) u.uLight.value.copy(skullTintScratch.light);
}

// 根据二进制点数据构建骷髅 BufferGeometry。
function buildSkullParticleGeometryFromAsset(points) {
  // 资源每五个 float 描述一个点：x、y、z、kind、seed。
  var count = Math.floor((points && points.length || 0) / 5);
  // 骷髅粒子几何只包含位置、随机种子和部位类型。
  var geo = new THREE.BufferGeometry();
  // 位置数组。
  var positions = new Float32Array(count * 3);
  // 随机种子数组。
  var seeds = new Float32Array(count);
  // 部位类型数组，用于 shader 区分骨面、下颌和细节。
  var kinds = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    positions[i * 3] = points[i * 5];
    positions[i * 3 + 1] = points[i * 5 + 1];
    positions[i * 3 + 2] = points[i * 5 + 2];
    kinds[i] = points[i * 5 + 3];
    seeds[i] = points[i * 5 + 4];
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('kind', new THREE.BufferAttribute(kinds, 1));
  return geo;
}

// 异步加载骷髅粒子二进制资源，并缓存成功或失败状态。
function loadSkullParticleAsset() {
  // 已有数据、正在加载或已失败时复用当前状态，不重复发起请求。
  if (skullParticleAsset.data || skullParticleAsset.promise || skullParticleAsset.failed) return skullParticleAsset.promise || Promise.resolve(skullParticleAsset.data);
  if (typeof fetch !== 'function') {
    // 没有 fetch 的环境无法加载外部二进制资源，标记失败后静默返回。
    skullParticleAsset.failed = true;
    return Promise.resolve(null);
  }
  // 使用 reload 缓存策略确保开发期间能拿到新版点云资源。
  skullParticleAsset.promise = fetch('assets/skull-decimation-points.bin?v=regular-surface-teeth-soften-20260621', { cache: 'reload' })
    .then(function(res){
      // HTTP 状态异常时进入 catch，后续不会反复重试。
      if (!res.ok) throw new Error('skull asset ' + res.status);
      return res.arrayBuffer();
    })
    .then(function(buf){
      // 每个点占 20 字节，长度不匹配说明资源格式错误。
      if (!buf || buf.byteLength < 20 || buf.byteLength % 20 !== 0) throw new Error('invalid skull asset');
      skullParticleAsset.data = new Float32Array(buf);
      skullParticleAsset.promise = null;
      return skullParticleAsset.data;
    })
    .catch(function(err){
      // 资源加载失败只降级为不可用，不阻断主播放器。
      console.warn('skull particle asset load failed:', err);
      skullParticleAsset.failed = true;
      skullParticleAsset.promise = null;
      return null;
    });
  return skullParticleAsset.promise;
}

// 向备用骷髅点数组追加一个点。
function skullPushPoint(pos, seed, kind, x, y, z, k) {
  pos.push(x, y, z);
  // 备用点云使用随机种子驱动 shader 闪烁和微扰。
  seed.push(Math.random() * 1000);
  // kind 缺省为 0，代表普通骨面。
  kind.push(k == null ? 0 : k);
}
// 按参数曲线生成一串备用骷髅点。
function skullPushCurve(pos, seed, kind, count, fn, k, jitter) {
  // jitter 用于打散过于规则的曲线点。
  jitter = jitter == null ? 0.012 : jitter;
  for (var i = 0; i < count; i++) {
    // t 是曲线归一化位置。
    var t = count > 1 ? i / (count - 1) : 0;
    // fn 返回曲线上当前点的三维坐标。
    var p = fn(t);
    skullPushPoint(pos, seed, kind, p.x + (Math.random() - 0.5) * jitter, p.y + (Math.random() - 0.5) * jitter, p.z + (Math.random() - 0.5) * jitter, k);
  }
}
// 创建骷髅粒子层，优先使用外部点云资源，备用代码保留程序化点云生成逻辑。
function createSkullParticleLayer() {
  // 已创建时直接复用。
  if (skullParticleGroup) return skullParticleGroup;
  // 当前主路径要求资源先加载成功。
  var asset = skullParticleAsset.data;
  if (!asset) return null;
  // 备用程序化点云数组；正常资源路径下不会填充。
  var pos = [];
  var seed = [];
  var kind = [];
  if (!asset) {

  // 备用点云中的二维旋转辅助函数。
  function rotate2(x, y, a) {
    var c = Math.cos(a), s = Math.sin(a);
    return { x:x * c - y * s, y:x * s + y * c };
  }
  // 判断备用点是否落入眼眶挖空区域。
  function eyeCut(x, y, z, side) {
    if (z < 0.16) return false;
    var p = rotate2(x - side * 0.38, y - 0.02, side * 0.10);
    var almond = Math.pow(Math.abs(p.x) / 0.34, 1.70) + Math.pow(Math.abs(p.y) / 0.215, 1.34);
    var slantGate = p.y < 0.22 - Math.abs(p.x) * 0.12 && p.y > -0.24 + Math.abs(p.x) * 0.10;
    return almond < 1.0 && slantGate;
  }
  // 判断备用点是否落入鼻孔挖空区域。
  function noseCut(x, y, z) {
    if (z < 0.20 || y > -0.12 || y < -0.62) return false;
    var t = clampRange((-0.12 - y) / 0.50, 0, 1);
    var half = 0.050 + t * 0.185;
    return Math.abs(x) < half && z > 0.38 + t * 0.18;
  }
  // 判断备用点是否落入嘴部空隙。
  function mouthGap(x, y, z) {
    return z > 0.18 && y < -0.66 && y > -1.03 && Math.abs(x) < 0.30;
  }
  // 在椭球表面随机采样备用骷髅点，并排除眼鼻嘴等空洞。
  function addEllipsoidSurface(count, cx, cy, cz, rx, ry, rz, yMin, yMax, k, frontBias) {
    // made 是成功写入数量，guard 防止随机采样陷入无限循环。
    var made = 0, guard = 0;
    while (made < count && guard < count * 8) {
      guard++;
      var theta = frontBias
        ? (-Math.PI * 0.07 + Math.random() * Math.PI * 1.14)
        : (Math.random() * Math.PI * 2);
      var phi = Math.acos(1 - Math.random() * 2);
      var sx = Math.sin(phi) * Math.cos(theta);
      var sy = Math.cos(phi);
      var sz = Math.sin(phi) * Math.sin(theta);
      var x = cx + sx * rx * (0.96 + Math.max(0, -sy) * 0.12);
      var y = cy + sy * ry;
      var z = cz + sz * rz;
      if (y < yMin || y > yMax) continue;
      if (eyeCut(x, y, z, -1) || eyeCut(x, y, z, 1) || noseCut(x, y, z) || mouthGap(x, y, z)) continue;
      // 适度挖掉颧骨区域，让备用模型轮廓更接近骷髅。
      var cheekCarve = z > 0.18 && y < -0.18 && y > -0.66 && Math.abs(x) > 0.26 && Math.abs(x) < 0.58 && Math.random() < 0.36;
      if (cheekCarve) continue;
      skullPushPoint(pos, seed, kind, x, y, z, k + Math.random() * 0.08);
      made++;
    }
  }

  // 备用头骨上半部分。
  addEllipsoidSurface(3150, 0, 0.46, 0.00, 0.93, 0.88, 0.58, -0.16, 1.35, 0.055, true);
  // 备用面部和颌骨主体。
  addEllipsoidSurface(2100, 0, -0.34, 0.10, 0.70, 0.66, 0.46, -0.95, 0.14, 0.10, true);
  // 备用下颌环形点。
  for (var j = 0; j < 1450; j++) {
    var a = Math.random() * Math.PI * 2;
    var v = Math.random();
    var y = -1.16 + v * 0.48;
    var taper = clampRange((y + 1.16) / 0.48, 0, 1);
    var rx = 0.32 + taper * 0.31;
    var rz = 0.22 + taper * 0.18;
    var x = Math.cos(a) * rx;
    var z = 0.22 + Math.sin(a) * rz;
    if (mouthGap(x, y, z)) continue;
    if (y > -0.94 && Math.abs(x) < 0.22 && z > 0.18) continue;
    skullPushPoint(pos, seed, kind, x, y, z, 0.15 + Math.random() * 0.10);
  }

  // 备用眼眶、眉骨和颧骨曲线。
  [-1, 1].forEach(function(side){
    var cx = side * 0.38;
    skullPushCurve(pos, seed, kind, 520, function(t){
      var a = t * Math.PI * 2;
      var px = Math.cos(a) * (0.345 + Math.sin(a * 2.0) * 0.012);
      var py = Math.sin(a) * (0.205 + Math.cos(a * 2.0) * 0.010);
      var r = rotate2(px, py, -side * 0.10);
      return {
        x: cx + r.x,
        y: 0.02 + r.y - Math.max(0, Math.cos(a)) * 0.018,
        z: 0.72 + Math.sin(a * 2.0) * 0.030
      };
    }, 0.96, 0.010);
    skullPushCurve(pos, seed, kind, 330, function(t){
      var x = side * (0.13 + t * 0.58);
      var y = 0.245 - t * 0.085 + Math.sin(t * Math.PI) * 0.055;
      return { x:x, y:y, z:0.66 + Math.sin(t * Math.PI) * 0.055 };
    }, 0.98, 0.010);
    skullPushCurve(pos, seed, kind, 300, function(t){
      return {
        x: side * (0.30 + t * 0.47),
        y: -0.18 - t * 0.25 + Math.sin(t * Math.PI) * 0.070,
        z: 0.69 - t * 0.095
      };
    }, 0.84, 0.012);
    skullPushCurve(pos, seed, kind, 330, function(t){
      return {
        x: side * (0.62 - t * 0.20),
        y: -0.28 - t * 0.55 + Math.sin(t * Math.PI) * 0.065,
        z: 0.50 + Math.sin(t * Math.PI) * 0.070
      };
    }, 0.72, 0.014);
  });

  // 备用额头横向轮廓线。
  skullPushCurve(pos, seed, kind, 360, function(t){
    var x = -0.72 + t * 1.44;
    return { x:x, y:0.235 - Math.abs(x) * 0.055 + Math.sin(t * Math.PI) * 0.035, z:0.62 + Math.sin(t * Math.PI) * 0.040 };
  }, 0.86, 0.012);
  // 备用鼻梁两侧线。
  [-1, 1].forEach(function(side){
    skullPushCurve(pos, seed, kind, 260, function(t){
      return { x:side * (0.035 + t * 0.205), y:-0.15 - t * 0.43, z:0.79 - t * 0.035 };
    }, 0.98, 0.007);
  });
  // 备用上颌和嘴部边界。
  skullPushCurve(pos, seed, kind, 240, function(t){
    var x = -0.25 + t * 0.50;
    return { x:x, y:-0.62 + Math.sin(t * Math.PI) * 0.030, z:0.70 };
  }, 0.86, 0.008);
  // 备用下颌弧线。
  skullPushCurve(pos, seed, kind, 420, function(t){
    var a = Math.PI + t * Math.PI;
    return { x: Math.cos(a) * 0.50, y: -0.98 + Math.sin(a) * 0.205, z: 0.46 + Math.sin(t * Math.PI) * 0.075 };
  }, 0.82, 0.014);
  // 备用上牙床。
  skullPushCurve(pos, seed, kind, 360, function(t){
    var x = -0.39 + t * 0.78;
    return { x:x, y:-0.70 + Math.sin(t * Math.PI) * 0.018, z:0.73 };
  }, 0.96, 0.006);
  // 备用下牙床。
  skullPushCurve(pos, seed, kind, 320, function(t){
    var x = -0.36 + t * 0.72;
    return { x:x, y:-1.005 - Math.sin(t * Math.PI) * 0.018, z:0.70 };
  }, 0.78, 0.008);
  // 备用牙齿竖向线。
  for (var tooth = -4; tooth <= 4; tooth++) {
    var tx = tooth * 0.082;
    var height = tooth === 0 ? 0.30 : (0.25 + (4 - Math.abs(tooth)) * 0.012);
    skullPushCurve(pos, seed, kind, 58, function(t){
      return { x: tx + Math.sin(t * Math.PI) * 0.006, y: -0.715 - t * height, z: 0.735 - t * 0.020 };
    }, 0.94, 0.004);
  }
  // 备用头骨外轮廓弧线。
  skullPushCurve(pos, seed, kind, 520, function(t){
    var a = Math.PI * 0.12 + t * Math.PI * 0.76;
    return { x: Math.cos(a) * 0.98, y: 0.42 + Math.sin(a) * 0.92, z: 0.48 + Math.sin(t * Math.PI) * 0.10 };
  }, 0.70, 0.012);
  // 备用下颌底部椭圆。
  skullPushCurve(pos, seed, kind, 360, function(t){
    var a = t * Math.PI * 2;
    return { x: Math.cos(a) * 0.52, y: -1.19 + Math.sin(a) * 0.082, z: 0.24 + Math.sin(a * 2.0) * 0.028 };
  }, 0.72, 0.010);
  }

  // 正常路径从资源生成几何；备用路径从程序化数组生成几何。
  var geo = asset ? buildSkullParticleGeometryFromAsset(asset) : new THREE.BufferGeometry();
  if (!asset) {
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(new Float32Array(seed), 1));
    geo.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(kind), 1));
  }
  // 骷髅材质包含独立的下颌、闪光和调色 uniform。
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture },
      uTime: uniforms.uTime,
      uPixel: uniforms.uPixel,
      uBass: uniforms.uBass,
      uMid: uniforms.uMid,
      uTreble: uniforms.uTreble,
      uBeat: uniforms.uBeat,
      uJawOpen: { value: 0 },
      uSkullFlash: { value: 0 },
      uPointScale: uniforms.uPointScale,
      uBloomStrength: uniforms.uBloomStrength,
      uColorBoost: uniforms.uColorBoost,
      uOpacity: { value: 0 },
      uColorA: { value: new THREE.Color('#b8ae98') },
      uColorB: { value: new THREE.Color('#fff4d8') },
      uShadow: { value: new THREE.Color('#100d0d') },
      uLight: { value: new THREE.Color('#ffe3a0') }
    },
    vertexShader: [
      'precision highp float;',
      'attribute float seed,kind;',
      'uniform float uTime,uPixel,uPointScale,uBloomStrength,uColorBoost;',
      'uniform float uBass,uMid,uTreble,uBeat,uJawOpen,uSkullFlash;',
      'varying float vKind,vLight,vRim,vAmp,vDensity,vFlash;',
      'void main(){',
      '  vec3 pos = position;',
      '  float jawGroup = step(1.0, kind);',
      '  float boneKind = fract(kind);',
      '  vKind = boneKind;',
      '  vec3 n = normalize(vec3(position.x * 0.82, position.y * 0.68, position.z * 1.22 + 0.16));',
      '  float toothBand = smoothstep(0.48, 0.70, position.z) * (1.0 - smoothstep(0.27, 0.48, abs(position.x))) * (1.0 - smoothstep(0.18, 0.46, abs(position.y + 0.72)));',
      '  float toothNoise = fract(sin(seed * 21.731 + floor((position.x + 0.52) * 21.0) * 5.137) * 43758.5453);',
      '  pos.y += toothBand * (toothNoise - 0.5) * 0.020;',
      '  pos.z += toothBand * (fract(sin(seed * 17.923 + position.y * 31.0) * 24634.6345) - 0.5) * 0.012;',
      '  float jawSidePull = jawGroup * smoothstep(-0.42, -1.06, position.y) * smoothstep(0.24, 0.62, abs(position.x)) * (1.0 - smoothstep(0.78, 1.04, abs(position.x))) * smoothstep(0.16, 0.70, position.z);',
      '  pos.x *= 1.0 - jawSidePull * 0.10;',
      '  float fallbackJaw = smoothstep(-0.48, -0.90, position.y) * smoothstep(0.08, 0.52, position.z) * (1.0 - smoothstep(0.62, 0.96, abs(position.x)));',
      '  float jawMask = jawGroup;',
      '  float jawSideAnchor = smoothstep(0.36, 0.66, abs(position.x)) * (1.0 - smoothstep(0.78, 0.98, abs(position.x))) * smoothstep(-0.34, -0.74, position.y) * (1.0 - smoothstep(0.62, 0.86, position.z));',
      '  float jawMotion = jawMask * (1.0 - jawSideAnchor * 0.32);',
      '  vec2 jawHinge = vec2(-0.45, 0.18);',
      '  float jawAngle = uJawOpen * 0.52 * jawMotion;',
      '  float jc = cos(jawAngle);',
      '  float js = sin(jawAngle);',
      '  vec2 jr = pos.yz - jawHinge;',
      '  vec2 openedJaw = vec2(jr.x * jc - jr.y * js, jr.x * js + jr.y * jc) + jawHinge;',
      '  pos.yz = mix(pos.yz, openedJaw, jawMotion);',
      '  float jawDrop = jawMotion * smoothstep(-0.32, -0.88, position.y) * (0.58 + smoothstep(0.18, 0.62, abs(position.x)) * 0.04);',
      '  float openDrive = clamp(uJawOpen, 0.0, 1.25);',
      '  pos.y -= jawDrop * (0.038 + openDrive * 0.100);',
      '  pos.z += jawDrop * (0.003 + openDrive * 0.014);',
      '  float ampDrive = smoothstep(0.20, 0.82, uBass * 0.44 + uMid * 0.22 + uBeat * 0.72);',
      '  float ampPhase = 0.50 + 0.50 * sin(uTime * (1.05 + uMid * 0.30) + seed * 6.2831);',
      '  vFlash = clamp(uSkullFlash * (0.68 + ampPhase * 0.32), 0.0, 1.0);',
      '  vAmp = clamp(ampDrive * 0.045 + vFlash * 0.92 + uTreble * 0.012, 0.0, 1.0);',
      '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
      '  float dist = max(0.55, -mv.z);',
      '  vec3 vn = normalize(normalMatrix * n);',
      '  vec3 keyDir = normalize(vec3(-0.48, 0.64, 0.60));',
      '  vec3 lowDir = normalize(vec3(-0.10, -0.78, 0.34));',
      '  vec3 fillDir = normalize(vec3(0.36, -0.04, 0.64));',
      '  vec3 rimDir = normalize(vec3(0.88, 0.18, -0.44));',
      '  float key = pow(max(dot(vn, keyDir), 0.0), 1.18);',
      '  float low = pow(max(dot(vn, lowDir), 0.0), 1.34) * 0.10;',
      '  float fill = max(dot(vn, fillDir), 0.0) * 0.055;',
      '  float gothicShadow = smoothstep(-0.10, 0.36, dot(vn, normalize(vec3(0.44, -0.06, -0.58))));',
      '  float dentalLift = smoothstep(0.48, 0.72, position.z) * (1.0 - smoothstep(0.30, 0.54, abs(position.x))) * (1.0 - smoothstep(0.18, 0.48, abs(position.y + 0.70))) * (0.62 + toothNoise * 0.20);',
      '  vRim = pow(max(dot(vn, rimDir), 0.0), 2.50) * (0.24 + uBloomStrength * 0.08 + vFlash * 0.62);',
      '  float dust = fract(sin(seed * 13.871 + position.x * 19.7 + position.y * 7.1) * 43758.5453);',
      '  vDensity = clamp(0.30 + key * 0.70 + vRim * 0.24 - gothicShadow * 0.24 + dust * 0.025 + vFlash * 0.08, 0.16, 1.20);',
      '  vLight = clamp(0.115 + key * 1.02 + low + fill + dentalLift * 0.20 + boneKind * 0.070 + vAmp * 0.56 - gothicShadow * 0.08, 0.035, 1.72);',
      '  float scaleCtl = clamp(uPointScale, 0.48, 2.35);',
      '  float size = (0.035 + boneKind * 0.026) * (0.84 + vDensity * 0.22 + vLight * 0.13 + uBloomStrength * 0.030 + vFlash * 0.18);',
      '  gl_PointSize = clamp(size * uPixel * scaleCtl * 128.0 / dist, 0.95, 7.60);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform vec3 uColorA,uColorB,uShadow,uLight;',
      'uniform float uOpacity,uBloomStrength,uColorBoost;',
      'varying float vKind,vLight,vRim,vAmp,vDensity,vFlash;',
      'void main(){',
      '  vec4 tex = texture2D(uMap, gl_PointCoord);',
      '  if(tex.a < 0.070) discard;',
      '  float contrast = clamp(uColorBoost, 0.50, 2.00);',
      '  float lit = clamp(pow(vLight, mix(1.18, 0.74, (contrast - 0.50) / 1.50)), 0.0, 1.28);',
      '  vec3 bone = mix(uColorA, uColorB, clamp((vKind - 0.34) * 2.0 + lit * 0.18, 0.0, 1.0));',
      '  vec3 col = mix(uShadow, bone, clamp(lit, 0.0, 1.0));',
      '  col = mix(col, uLight, clamp(vRim * (0.14 + uBloomStrength * 0.035 + vFlash * 0.40), 0.0, 0.54));',
      '  col = mix(col, uLight, clamp(vAmp * (0.09 + uBloomStrength * 0.025) + vFlash * 0.56, 0.0, 0.68));',
      '  float alpha = tex.a * uOpacity * clamp(0.20 + lit * 0.44 + vDensity * 0.40 + vRim * 0.10 + vFlash * 0.46, 0.12, 1.56);',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending
  });
  // 创建骷髅粒子对象，默认隐藏，进入预设后再淡入。
  skullParticleGroup = new THREE.Points(geo, mat);
  skullParticleGroup.frustumCulled = false;
  skullParticleGroup.visible = false;
  // 记录点云来源，便于调试资源路径和备用路径。
  skullParticleGroup.userData.source = asset ? 'asset' : 'fallback';
  // 应用基础位置、缩放和旋转。
  skullParticleGroup.position.set(SKULL_MODEL_BASE_POSITION.x, SKULL_MODEL_BASE_POSITION.y, SKULL_MODEL_BASE_POSITION.z);
  skullParticleGroup.scale.setScalar(SKULL_MODEL_SCALE);
  skullParticleGroup.rotation.x = SKULL_MODEL_BASE_ROTATION_X;
  skullParticleGroup.rotation.y = SKULL_MODEL_BASE_ROTATION_Y;
  skullParticleGroup.renderOrder = 32;
  // 创建后立即同步一次当前色调。
  syncSkullParticleColors();
  scene.add(skullParticleGroup);
  return skullParticleGroup;
}
// 判断骷髅预设是否处于歌单架侧边组合构图。
function isSkullShelfCompositionActive() {
  // 只有骷髅预设才进入这套构图判断。
  if (!(fx && fx.preset === SKULL_PRESET_INDEX)) return false;
  // 歌单架必须处于 side 模式。
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  // 固定打开或可见度较高时视为组合构图。
  if (shelfPinnedOpen || shelfVisibility > 0.18) return true;
  // 二级内容打开时也需要给歌单架留出构图空间。
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
// 离开骷髅预设时清理残留的透明度、闪光和下颌状态。
function clearSkullPresetResidue() {
  skullParticleOpacity = 0;
  skullAmpPulse = 0;
  skullBeatFlash = 0;
  skullJawOpen = 0;
  skullCameraBlend = 0;
  // 骷髅层尚未创建时只重置状态即可。
  if (!skullParticleGroup) return;
  skullParticleGroup.visible = false;
  if (skullParticleGroup.material && skullParticleGroup.material.uniforms) {
    if (skullParticleGroup.material.uniforms.uOpacity) skullParticleGroup.material.uniforms.uOpacity.value = 0;
    if (skullParticleGroup.material.uniforms.uJawOpen) skullParticleGroup.material.uniforms.uJawOpen.value = 0;
    if (skullParticleGroup.material.uniforms.uSkullFlash) skullParticleGroup.material.uniforms.uSkullFlash.value = 0;
  }
}
// 重置骷髅预设视图和相关歌词锁定状态。
function resetSkullPresetView(immediate, opts) {
  // opts 控制是否平滑、是否保留歌词锁定。
  opts = opts || {};
  // 非骷髅预设不处理。
  if (!(fx && fx.preset === SKULL_PRESET_INDEX)) return;
  // 重置滚轮缩放目标。
  skullWheelZoomTarget = 0;
  // 非平滑重置时当前缩放也立即归零。
  if (!opts.smooth) skullWheelZoom = 0;
  // 强制相机进入骷髅构图混合。
  skullCameraBlend = Math.max(skullCameraBlend, 1);
  // 需要时解除嘴部歌词锁定，并请求歌词相机快速贴合。
  if (!opts.keepLyricLock && typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.group && stageLyrics.group.userData) stageLyrics.group.userData.skullMouthLocked = false;
  if (!opts.keepLyricLock && typeof requestStageLyricCameraSnap === 'function') requestStageLyricCameraSnap(10);
  if (!immediate || !skullParticleGroup) return;
  // 立即重置时根据当前歌单架状态选择普通或侧边构图。
  var shelfComposition = isSkullShelfCompositionActive();
  skullShelfCameraMix = shelfComposition ? 1 : 0;
  skullParticleGroup.position.set(shelfComposition ? -1.18 : SKULL_MODEL_BASE_POSITION.x, shelfComposition ? 0.32 : SKULL_MODEL_BASE_POSITION.y, SKULL_MODEL_BASE_POSITION.z);
  skullParticleGroup.scale.setScalar(shelfComposition ? 3.02 : SKULL_MODEL_SCALE);
  skullParticleGroup.rotation.set(SKULL_MODEL_BASE_ROTATION_X, SKULL_MODEL_BASE_ROTATION_Y, 0);
  skullParticleGroup.updateMatrixWorld(true);
  if (camera && typeof setSkullCameraTargetVectors === 'function') {
    // 竖屏和横屏使用不同相机目标，保证骷髅位于安全区域。
    var portrait = innerHeight > innerWidth * 1.08;
    setSkullCameraTargetVectors(skullCameraTargetPos, skullCameraTargetLook, portrait, shelfComposition, 0);
    camera.position.copy(skullCameraTargetPos);
    skullCameraMixedLook.copy(skullCameraTargetLook);
    camera.lookAt(skullCameraMixedLook);
    camera.updateProjectionMatrix();
  }
}
// 计算骷髅模型的慢速呼吸漂移。
function skullBreathOffset(t, shelfComposition) {
  // 歌单架组合构图下减少漂移，避免和侧栏产生视觉冲突。
  var strength = shelfComposition ? 0.70 : 1.0;
  return {
    x: strength * (Math.sin(t * 0.33 + 1.7) * 0.028 + Math.sin(t * 0.61 + 0.4) * 0.010),
    y: strength * (Math.sin(t * 0.38 + 0.2) * 0.036 + Math.sin(t * 0.83 + 2.1) * 0.012),
    z: strength * (Math.sin(t * 0.24 + 2.6) * 0.026)
  };
}
// 写入骷髅预设目标相机位置和注视点。
function setSkullCameraTargetVectors(pos, look, portrait, shelfComposition, zoom) {
  // zoom 来自滚轮，缺省为 0。
  zoom = Number(zoom) || 0;
  if (shelfComposition) {
    // 侧边歌单架构图下相机更靠后，并把骷髅留在主视觉安全区。
    pos.set(portrait ? -0.06 : 0.00, portrait ? -2.36 : -2.50, (portrait ? 4.88 : 4.96) + zoom * 0.78);
    look.set(portrait ? -0.04 : 0.00, portrait ? -0.26 : -0.20, 0.03);
    return;
  }
  // 普通构图下骷髅居中，竖屏略微调整高度。
  pos.set(0.00, portrait ? -2.38 : -2.52, (portrait ? 4.92 : 4.98) + zoom);
  look.set(0.00, portrait ? -0.28 : -0.20, 0.02);
}
// 每帧把相机平滑混合到骷髅预设专属构图。
function applySkullCameraPose(dt) {
  // 自由相机正在接管时不覆盖用户视角。
  if (freeCamera && (freeCamera.active || freeCamera.locked || freeCamera.resetTween)) return;
  // 只有骷髅预设激活时相机混合目标为 1。
  var active = fx && fx.preset === SKULL_PRESET_INDEX;
  skullCameraBlend += ((active ? 1 : 0) - skullCameraBlend) * Math.min(1, dt * (active ? 4.8 : 7.2));
  if (skullCameraBlend < 0.002) return;
  // 滚轮缩放使用缓动，避免相机突变。
  skullWheelZoom += (skullWheelZoomTarget - skullWheelZoom) * Math.min(1, dt * 8.0);
  // 根据视口比例选择竖屏参数。
  var portrait = innerHeight > innerWidth * 1.08;
  // 歌单架打开时混合到侧边构图。
  var shelfComposition = isSkullShelfCompositionActive();
  var shelfMixTarget = shelfComposition ? 1 : 0;
  skullShelfCameraMix += (shelfMixTarget - skullShelfCameraMix) * Math.min(1, dt * (shelfMixTarget > skullShelfCameraMix ? 4.6 : 5.8));
  if (Math.abs(skullShelfCameraMix - shelfMixTarget) < 0.002) skullShelfCameraMix = shelfMixTarget;
  setSkullCameraTargetVectors(skullCameraBasePos, skullCameraBaseLook, portrait, false, skullWheelZoom);
  setSkullCameraTargetVectors(skullCameraShelfPos, skullCameraShelfLook, portrait, true, skullWheelZoom);
  // 在普通构图和歌单架构图之间插值。
  skullCameraTargetPos.copy(skullCameraBasePos).lerp(skullCameraShelfPos, skullShelfCameraMix);
  skullCameraTargetLook.copy(skullCameraBaseLook).lerp(skullCameraShelfLook, skullShelfCameraMix);
  camera.position.lerp(skullCameraTargetPos, skullCameraBlend);
  skullCameraMixedLook.set(orbit.lookAt.x, orbit.lookAt.y, orbit.lookAt.z).lerp(skullCameraTargetLook, skullCameraBlend);
  camera.lookAt(skullCameraMixedLook);
  camera.updateProjectionMatrix();
}
// 每帧更新骷髅粒子可见性、下颌、闪光、缩放和旋转。
function updateSkullParticleLayer(dt) {
  // 只在骷髅预设下激活。
  var active = fx && fx.preset === SKULL_PRESET_INDEX;
  if (active && !skullParticleAsset.data && !skullParticleAsset.failed) {
    // 首次进入时异步加载点云资源，本帧先返回。
    loadSkullParticleAsset();
    return;
  }
  // 资源未加载成功时不创建粒子层。
  if (active && !skullParticleAsset.data) return;
  // 激活时按需创建粒子层。
  if (active) createSkullParticleLayer();
  if (!skullParticleGroup) return;
  // 透明度按激活状态缓入缓出。
  var target = active ? 1 : 0;
  skullParticleOpacity += (target - skullParticleOpacity) * Math.min(1, dt * (active ? 3.2 : 2.4));
  if (skullParticleOpacity < 0.006 && !active) {
    skullParticleGroup.visible = false;
    return;
  }
  skullParticleGroup.visible = true;
  // 透明度受全局强度影响，但限制在合理范围。
  skullParticleGroup.material.uniforms.uOpacity.value = skullParticleOpacity * clampRange(0.78 + (fx.intensity || 0.85) * 0.18, 0.56, 1.0);
  // 根据节拍脉冲计算短促闪光。
  var beatTransient = clampRange(Math.max(0, beatPulse - 0.16) / 0.84, 0, 1.35);
  var flashTarget = clampRange(Math.pow(beatTransient, 1.34) * 1.08 + Math.max(0, bass - 0.60) * 0.18 * beatTransient, 0, 1);
  skullBeatFlash += (flashTarget - skullBeatFlash) * Math.min(1, dt * (flashTarget > skullBeatFlash ? 24.0 : 6.2));
  if (skullParticleGroup.material.uniforms.uSkullFlash) skullParticleGroup.material.uniforms.uSkullFlash.value = skullBeatFlash;
  // 下颌张开随低频、节拍闪光和慢速呼吸变化。
  var jawTarget = clampRange(0.60 + (0.5 + 0.5 * Math.sin(uniforms.uTime.value * 0.50)) * 0.050 + bass * 0.060 + skullBeatFlash * 0.090, 0.52, 0.88);
  skullJawOpen += (jawTarget - skullJawOpen) * Math.min(1, dt * (jawTarget > skullJawOpen ? 7.8 : 3.4));
  if (skullParticleGroup.material.uniforms.uJawOpen) skullParticleGroup.material.uniforms.uJawOpen.value = skullJawOpen;
  // 组合构图会改变模型位置和缩放。
  var shelfComposition = isSkullShelfCompositionActive();
  var shelfMix = clampRange(skullShelfCameraMix || (shelfComposition ? 1 : 0), 0, 1);
  var drift = skullBreathOffset(uniforms.uTime.value, shelfComposition);
  // 音频脉冲影响模型整体缩放。
  var ampTarget = clampRange(bass * 0.006 + mid * 0.004 + skullBeatFlash * 0.070, 0, 0.090);
  skullAmpPulse += (ampTarget - skullAmpPulse) * Math.min(1, dt * (ampTarget > skullAmpPulse ? 11.0 : 4.0));
  var shelfScale = 3.02;
  // 缩放同时考虑歌单架构图、音频脉冲和滚轮距离。
  var targetScale = (SKULL_MODEL_SCALE + (shelfScale - SKULL_MODEL_SCALE) * shelfMix) * (1 + skullAmpPulse) * clampRange(1 - skullWheelZoom * 0.055, 0.92, 1.08);
  // 歌单架构图下的目标位置。
  var shelfX = -1.18;
  var shelfY = 0.32;
  // 目标位置叠加呼吸漂移。
  var targetX = (SKULL_MODEL_BASE_POSITION.x + (shelfX - SKULL_MODEL_BASE_POSITION.x) * shelfMix) + drift.x;
  var targetY = (SKULL_MODEL_BASE_POSITION.y + (shelfY - SKULL_MODEL_BASE_POSITION.y) * shelfMix) + drift.y;
  var targetZ = SKULL_MODEL_BASE_POSITION.z + drift.z;
  skullParticleGroup.position.x += (targetX - skullParticleGroup.position.x) * Math.min(1, dt * 4.2);
  skullParticleGroup.position.y += (targetY - skullParticleGroup.position.y) * Math.min(1, dt * 4.8);
  skullParticleGroup.position.z += (targetZ - skullParticleGroup.position.z) * Math.min(1, dt * 4.2);
  skullParticleGroup.scale.x += (targetScale - skullParticleGroup.scale.x) * Math.min(1, dt * 4.6);
  skullParticleGroup.scale.y = skullParticleGroup.scale.x;
  skullParticleGroup.scale.z = skullParticleGroup.scale.x;
  // 非居中锁定时，头部视差和粒子旋转共同影响骷髅朝向。
  var targetRotY = SKULL_MODEL_BASE_ROTATION_Y + (orbit.centerLocked ? 0 : (headParallax.active ? headParallax.x * 0.5 : 0) + particleRotation.y);
  var targetRotX = SKULL_MODEL_BASE_ROTATION_X + (orbit.centerLocked ? 0 : (headParallax.active ? -headParallax.y * 0.35 : 0) + particleRotation.x);
  var rotEase = Math.min(1, dt * 7.4);
  skullParticleGroup.rotation.y += (targetRotY - skullParticleGroup.rotation.y) * rotEase;
  skullParticleGroup.rotation.x += (targetRotX - skullParticleGroup.rotation.x) * rotEase;
  skullParticleGroup.rotation.z += (0 - skullParticleGroup.rotation.z) * Math.min(1, dt * 6.0);
}

// ============================================================
//  封面背面粒子层 (v7.2)
//   - 独立 Points, 放在 z=-1.5 (主封面平面背面)
//   - 颜色取自封面镜像 UV
//   - 慢呼吸 + 小幅 noise 漂移
//   - 跟主粒子同步旋转 (在主循环里赋值)
//   - 视角转到背面才能看到 — 不需要手动控制 visible
// ============================================================
// 封面背面粒子数量。
var BACK_COVER_COUNT = 3000;
// 背面封面 Points 容器。
var backCoverGroup = null;
// 背面封面粒子颜色数组，封面变化时会刷新。
var backCoverColorArr = null;

// 创建封面背面粒子层，用于从背面视角看到专辑颜色云。
function createBackCoverLayer() {
  // 已创建时不重复创建。
  if (backCoverGroup) return;
  // 背面层独立几何，位置、颜色、随机值和镜像 UV 分开存储。
  var bg = new THREE.BufferGeometry();
  // 背面粒子位置。
  var bp = new Float32Array(BACK_COVER_COUNT * 3);
  // 背面粒子颜色。
  var bc = new Float32Array(BACK_COVER_COUNT * 3);
  // 背面粒子随机种子。
  var br = new Float32Array(BACK_COVER_COUNT);
  // 背面粒子镜像 UV。
  var bu = new Float32Array(BACK_COVER_COUNT * 2);  // 镜像 UV 用于采样封面
  for (var i = 0; i < BACK_COVER_COUNT; i++) {
    // 每个粒子随机取封面上的一个 UV。
    var u = Math.random();
    var v = Math.random();
    // 在 PLANE_SIZE 范围内分布
    bp[i*3]   = (u - 0.5) * PLANE_SIZE;
    bp[i*3+1] = (v - 0.5) * PLANE_SIZE;
    bp[i*3+2] = -1.5 - Math.random() * 0.4;  // 在主平面后方
    bu[i*2]   = 1.0 - u;  // 镜像 X
    bu[i*2+1] = v;
    br[i] = Math.random();
    bc[i*3] = 0.7; bc[i*3+1] = 0.6; bc[i*3+2] = 0.8;  // 占位
  }
  bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
  bg.setAttribute('aColor',   new THREE.BufferAttribute(bc, 3));
  bg.setAttribute('aRand',    new THREE.BufferAttribute(br, 1));
  bg.setAttribute('aUv',      new THREE.BufferAttribute(bu, 2));

  // 背面层顶点 shader 负责慢速呼吸和低频扰动。
  var vs = `
    precision highp float;
    uniform float uTime, uBass, uPixel, uAlpha;
    attribute vec3 aColor;
    attribute vec2 aUv;
    attribute float aRand;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec3 pos = position;
      // 缓慢呼吸
      pos.x += sin(uTime * 0.20 + aRand * 8.0) * 0.20;
      pos.y += cos(uTime * 0.18 + aRand * 6.0) * 0.22;
      pos.z += sin(uTime * 0.12 + aRand * 5.0) * 0.18 + uBass * 0.12 * sin(aRand * 11.0);
      vC = aColor;
      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
      float dist = -mvPos.z;
      vA = clamp(0.30 + 0.4 * sin(uTime * 0.6 + aRand * 5.0), 0.10, 0.65);
      float sz = clamp(46.0 / max(0.5, dist), 1.4, 4.5);
      gl_PointSize = sz * uPixel;
      gl_Position = projectionMatrix * mvPos;
    }
  `;
  // 背面层片元 shader 复用圆点纹理并乘以整体透明度。
  var fs = `
    precision highp float;
    uniform sampler2D uDotTex;
    uniform float uAlpha;
    varying vec3 vC;
    varying float vA;
    void main(){
      vec4 tex = texture2D(uDotTex, gl_PointCoord);
      if (tex.a < 0.02) discard;
      gl_FragColor = vec4(vC, tex.a * vA * uAlpha);
    }
  `;
  // 背面层材质使用正常混合，避免背面粒子过亮。
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uBass: uniforms.uBass,
      uPixel: uniforms.uPixel,
      uDotTex: uniforms.uDotTex,
      uAlpha: uniforms.uAlpha,
    },
    vertexShader: vs, fragmentShader: fs,
    transparent:true, depthWrite:false, blending: THREE.NormalBlending,
  });
  // 创建背面粒子对象并缓存颜色数组引用。
  backCoverGroup = new THREE.Points(bg, mat);
  backCoverGroup.frustumCulled = false;
  backCoverColorArr = bc;
  scene.add(backCoverGroup);
}

// 销毁封面背面粒子层并释放资源。
function destroyBackCoverLayer() {
  // 未创建时无需处理。
  if (!backCoverGroup) return;
  scene.remove(backCoverGroup);
  // 背面层几何和材质独占，可以直接释放。
  backCoverGroup.geometry.dispose(); backCoverGroup.material.dispose();
  backCoverGroup = null; backCoverColorArr = null;
}

// 从封面 canvas 重新采样背面粒子颜色。
function refreshBackCoverColorsFromCanvas(coverCanvas) {
  // 背面层未创建或没有封面数据时跳过。
  if (!backCoverGroup || !coverCanvas || !backCoverColorArr) return;
  // 读取封面像素数据用于 CPU 侧取色。
  var ctx = coverCanvas.getContext('2d');
  var img = ctx.getImageData(0, 0, coverCanvas.width, coverCanvas.height).data;
  // 缓存宽高，避免循环内重复访问 canvas 属性。
  var w = coverCanvas.width, h = coverCanvas.height;
  // 取得几何 attribute，刷新 aColor 后需要标记 needsUpdate。
  var attr = backCoverGroup.geometry.attributes;
  var uvA = attr.aUv.array;
  for (var i = 0; i < BACK_COVER_COUNT; i++) {
    // 使用创建时保存的镜像 UV 定位封面像素。
    var u = uvA[i*2], v = uvA[i*2+1];
    var sx = Math.floor(u * w);
    var sy = Math.floor(v * h);
    var di = (sy * w + sx) * 4;
    backCoverColorArr[i*3]   = img[di]   / 255 * 0.85;
    backCoverColorArr[i*3+1] = img[di+1] / 255 * 0.85;
    backCoverColorArr[i*3+2] = img[di+2] / 255 * 0.85;
  }
  attr.aColor.needsUpdate = true;
}
// 浮空粒子漂移在 shader 中完成，此函数保留给主循环调用。
function updateFloatLayer(dt) {
  // 漂移已在 shader 中完成, JS 不需要每帧改 buffer
}
// 从封面随机采样颜色并刷新浮空粒子色彩。
function refreshFloatColorsFromCover(coverCanvas) {
  // 浮空层未启用或没有封面时跳过。
  if (!floatGroup || !coverCanvas) return;
  // 读取封面像素，用随机点给浮空粒子上色。
  var ctx = coverCanvas.getContext('2d');
  var img = ctx.getImageData(0, 0, coverCanvas.width, coverCanvas.height).data;
  // 缓存封面尺寸。
  var w = coverCanvas.width, h = coverCanvas.height;
  for (var i = 0; i < FLOAT_COUNT; i++) {
    // 每个浮空粒子随机取一个封面像素。
    var sx = Math.floor(Math.random() * w);
    var sy = Math.floor(Math.random() * h);
    var di = (sy * w + sx) * 4;
    floatColorArr[i*3]   = img[di]   / 255 * 0.95;
    floatColorArr[i*3+1] = img[di+1] / 255 * 0.95;
    floatColorArr[i*3+2] = img[di+2] / 255 * 0.95;
  }
  floatGroup.geometry.attributes.aColor.needsUpdate = true;
}
// 将浮空粒子颜色恢复成空闲白色系。
function resetFloatColorsToIdle() {
  // 浮空层未创建时无需恢复。
  if (!floatGroup || !floatColorArr) return;
  for (var i = 0; i < FLOAT_COUNT; i++) {
    // 用索引生成稳定的轻微明度差异，避免全白过平。
    var white = 0.88 + (i % 17) / 17 * 0.12;
    floatColorArr[i*3] = white;
    floatColorArr[i*3+1] = white;
    floatColorArr[i*3+2] = white;
  }
  floatGroup.geometry.attributes.aColor.needsUpdate = true;
}


