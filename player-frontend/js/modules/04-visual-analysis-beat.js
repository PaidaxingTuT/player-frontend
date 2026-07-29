// ===== js/04-visual-analysis-beat.js =====

// ============================================================
//  涟漪触发系统 — 3×3 九宫格 + bass 上升沿
// ============================================================
// 下一个要复用的涟漪槽位索引。
var rippleIdx = 0;
// 上一次触发涟漪的时间。
var lastRippleAt = 0;
// 上一帧低频是否处于上升沿状态。
var lastBassRising = false;
// 触发低频涟漪的阈值。
var BASS_THRESHOLD = 0.30;
// 涟漪触发冷却时间，避免低频连续抖动生成过多涟漪。
var RIPPLE_COOLDOWN = 0.32;

// 九宫格涟漪候选区域。
var regions = [];
// 按 3×3 网格生成平面上的候选中心点。
for (var ry = 0; ry < 3; ry++) for (var rx = 0; rx < 3; rx++) {
  regions.push({
    x: (rx / 2 - 0.5) * PLANE_SIZE * 0.72,
    y: (ry / 2 - 0.5) * PLANE_SIZE * 0.72,
  });
}

// 在指定坐标触发一个涟漪。
function triggerRipple(x, y, strength) {
  // 复用当前槽位对象。
  var r = ripples[rippleIdx];
  // 重置涟漪位置、年龄和强度。
  r.x = x; r.y = y; r.age = 0; r.str = strength;
  // 环形推进槽位索引。
  rippleIdx = (rippleIdx + 1) % RIPPLE_MAX;
}

// 更新涟漪生命周期，并把数据写入 DataTexture。
function updateRipples(dt) {
  // 低频从阈值下方跨过阈值时触发一次涟漪。
  var isBassHit = bass > BASS_THRESHOLD && !lastBassRising;
  // 使用较低阈值释放上升沿锁定，形成迟滞。
  lastBassRising = bass > BASS_THRESHOLD * 0.75;
  // 使用 shader 时间作为涟漪触发时间基准。
  var now = uniforms.uTime.value;
  if (isBassHit && (now - lastRippleAt) > RIPPLE_COOLDOWN) {
    // 记录触发时间并随机触发 2 到 3 个区域。
    lastRippleAt = now;
    var count = 2 + (Math.random() < 0.5 ? 0 : 1);
    // 本次触发已使用的九宫格区域。
    var used = {};
    for (var k = 0; k < count; k++) {
      // 随机挑一个尽量未使用的区域。
      var idx, tries = 0;
      do { idx = Math.floor(Math.random() * 9); tries++; } while (used[idx] && tries < 12);
      used[idx] = true;
      // 区域中心加一点随机偏移，避免每次位置完全相同。
      var reg = regions[idx];
      var jx = reg.x + (Math.random() - 0.5) * 0.7;
      var jy = reg.y + (Math.random() - 0.5) * 0.7;
      var str = 0.65 + bass * 1.4 + Math.random() * 0.25;
      triggerRipple(jx, jy, str);
    }
  }

  for (var i = 0; i < RIPPLE_MAX; i++) {
    // 更新每个涟漪槽位的生命周期。
    var r = ripples[i];
    if (r.str > 0.005) {
      r.age += dt;
      if (r.age > 2.0) { r.str = 0; r.age = -10; }
    }
    // 每个涟漪写入四个通道：x、y、age、strength。
    var off = i * 4;
    rippleData[off]   = r.x;
    rippleData[off+1] = r.y;
    rippleData[off+2] = r.age;
    rippleData[off+3] = r.str;
  }
  // 通知 Three.js 上传新的 DataTexture。
  rippleTex.needsUpdate = true;

  // 统计当前仍有效的涟漪数量。
  var active = 0;
  for (var i = 0; i < RIPPLE_MAX; i++) if (ripples[i].str > 0.005) active++;
  uniforms.uRippleCount.value = active;
}

// ============================================================
//  封面 + 边缘 + 启发式深度 处理 (CPU 端)
//   生成 256×256 RGBA 纹理: R=depth G=edge B=fg-mask A=lum
// ============================================================
function coverDepthCacheId(raw) {
  // 从封面 URL 或缓存键中提取文件名（不含后缀）作为 hash。
  var str = String(raw || '')
  if (!str) return ''
  // 去掉 |tex=NxN 尺寸后缀
  var pure = str.split('|')[0]
  // 取最后一段作为文件名
  var name = pure.split('/').pop()
  if (!name) return ''
  // 去掉扩展名
  var dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function buildEdgeAndDepth(srcCanvas) {
  // CPU 端从封面生成四通道辅助纹理：R=深度，G=边缘，B=前景遮罩，A=亮度。
  // shader 后续用这张纹理做粒子位移、边缘提亮和封面前景层次，不需要每帧重复分析图片。
  // 输出尺寸和像素总数。
  var W = 256, H = 256, N = W * H;
  // 先把任意尺寸封面规整到 256×256。
  var normalized = document.createElement('canvas');
  normalized.width = W;
  normalized.height = H;
  var sctx = normalized.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(srcCanvas, 0, 0, W, H);
  // 读取规整后的像素。
  var src = sctx.getImageData(0, 0, W, H).data;
  // 亮度、模糊结果和临时缓冲。
  var lum = new Float32Array(N), blur = new Float32Array(N), tmp = new Float32Array(N);
  // 1) Luminance
  for (var i = 0; i < N; i++) {
    var di = i * 4;
    lum[i] = (src[di] * 0.299 + src[di+1] * 0.587 + src[di+2] * 0.114) / 255;
  }
  // 2) Box blur 2 次 (深度基础)
  // 横向盒模糊。
  function blurH(s, d, r) {
    for (var y = 0; y < H; y++) {
      var sum = 0;
      for (var x = -r; x <= r; x++) sum += s[y * W + Math.max(0, Math.min(W-1, x))];
      for (var x = 0; x < W; x++) {
        d[y * W + x] = sum / (2*r + 1);
        var xR = Math.min(W-1, x + r + 1), xL = Math.max(0, x - r);
        sum += s[y * W + xR] - s[y * W + xL];
      }
    }
  }
  // 纵向盒模糊。
  function blurV(s, d, r) {
    for (var x = 0; x < W; x++) {
      var sum = 0;
      for (var y = -r; y <= r; y++) sum += s[Math.max(0, Math.min(H-1, y)) * W + x];
      for (var y = 0; y < H; y++) {
        d[y * W + x] = sum / (2*r + 1);
        var yD = Math.min(H-1, y + r + 1), yU = Math.max(0, y - r);
        sum += s[yD * W + x] - s[yU * W + x];
      }
    }
  }
  blurH(lum, tmp, 4); blurV(tmp, blur, 4);

  // 3) Sobel 边缘 (在 blur 上做 - 减少噪声)
  // edge 保存 Sobel 边缘强度。
  var edge = new Float32Array(N);
  for (var y = 1; y < H-1; y++) for (var x = 1; x < W-1; x++) {
    var gx = -blur[(y-1)*W + (x-1)] - 2*blur[y*W + (x-1)] - blur[(y+1)*W + (x-1)]
            + blur[(y-1)*W + (x+1)] + 2*blur[y*W + (x+1)] + blur[(y+1)*W + (x+1)];
    var gy = -blur[(y-1)*W + (x-1)] - 2*blur[(y-1)*W + x] - blur[(y-1)*W + (x+1)]
            + blur[(y+1)*W + (x-1)] + 2*blur[(y+1)*W + x] + blur[(y+1)*W + (x+1)];
    edge[y*W + x] = Math.min(1.0, Math.sqrt(gx*gx + gy*gy) * 1.4);
  }
  // 4) 启发式深度:亮度 + 中心 mask + 边缘累积
  // depth 保存启发式景深。
  var depth = new Float32Array(N);
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var i = y*W + x;
    // 归一化到中心为 0 的坐标。
    var cx = (x / (W-1) - 0.5) * 2.0;
    var cy = (y / (H-1) - 0.5) * 2.0;
    var rr = Math.sqrt(cx*cx + cy*cy);
    var centerBias = 1.0 - Math.min(1, rr * 0.75);
    var bright = blur[i];
    depth[i] = Math.min(1.0, bright * 0.45 + centerBias * 0.55);
  }
  // 5) fg-mask: 中心 + 高对比区
  // fg 前景遮罩由深度和边缘混合得到。
  var fg = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    var d = depth[i];
    var e = edge[i];
    fg[i] = Math.min(1.0, d * 0.6 + e * 0.5);
  }

  // 输出 256×256 RGBA
  // 创建输出 canvas 和 ImageData。
  var out = document.createElement('canvas'); out.width = W; out.height = H;
  var octx = out.getContext('2d', { willReadFrequently: true }), imgOut = octx.createImageData(W, H);
  for (var i = 0; i < N; i++) {
    var di = i * 4;
    imgOut.data[di]   = Math.round(depth[i] * 255);
    imgOut.data[di+1] = Math.round(edge[i] * 255);
    imgOut.data[di+2] = Math.round(fg[i] * 255);
    imgOut.data[di+3] = Math.round(lum[i] * 255);
  }
  octx.putImageData(imgOut, 0, 0);
  return out;
}

// AI 深度估计 (Xenova/depth-anything-small) - 异步加载, 失败回退
async function ensureAIDepthPipeline() {
  // AI 深度模型按需懒加载；失败时保持启发式深度可用，避免封面切换链路被模型加载阻断。
  if (aiDepthReady && aiDepthPipeline) return aiDepthPipeline;
  // 已有加载任务时不并发启动第二个模型加载。
  if (aiDepthBusy) return null;
  aiDepthBusy = true;
  try {
    // 首次加载会下载模型，UI 上显示短提示。
    showAIDepthChip('加载 AI 深度模型 (首次需下载 50MB)…');
    // 从 CDN 动态导入 transformers.js。
    var mod = await import('./vendor/transformers.min.js');
    // 禁用本地模型查找，直接走远端资源。
    mod.env.allowLocalModels = false;
    // 限制 wasm 线程，降低播放器内嵌环境压力。
    if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) mod.env.backends.onnx.wasm.numThreads = 1;
    // 创建深度估计 pipeline。
    aiDepthPipeline = await mod.pipeline('depth-estimation', 'Xenova/depth-anything-small-hf');
    aiDepthReady = true;
    return aiDepthPipeline;
  } catch (e) {
    // 加载失败时只记录警告，封面仍使用启发式深度。
    console.warn('AI depth pipeline failed:', e);
    return null;
  } finally {
    aiDepthBusy = false;
  }
}

// 为 AI 深度估计生成较小的输入 canvas。
function makeAIDepthInputCanvas(srcCanvas) {
  // 没有源 canvas 时直接返回。
  if (!srcCanvas) return srcCanvas;
  // 小尺寸输入可显著降低模型推理耗时。
  var size = 160;
  // 规整输入 canvas。
  var cv = document.createElement('canvas');
  cv.width = cv.height = size;
  var ctx = cv.getContext('2d');
  try {
    // 把源封面缩放绘制到 160×160。
    ctx.drawImage(srcCanvas, 0, 0, size, size);
    return cv;
  } catch (e) {
    return srcCanvas;
  }
}

// 使用 AI 模型估计封面深度图。
async function estimateAIDepth(srcCanvas, token) {
  // token 在模型加载前后都要校验，防止上一张封面的异步结果覆盖当前封面。
  if (!isLocalAIDepthMode()) return null;
  // 近期失败后进入冷却，避免频繁重试。
  if (performance.now() < aiDepthFailUntil) return null;
  showAIDepthChip('后台增强封面深度…');
  try {
    // 确保模型 pipeline 可用。
    var pipe = await ensureAIDepthPipeline();
    if (!pipe) { hideAIDepthChip(); return null; }
    if (token !== coverProcessToken) { hideAIDepthChip(); return null; }
    // 缩小输入尺寸。
    var inputCanvas = makeAIDepthInputCanvas(srcCanvas);
    // transformers.js 可以接受 data URL，优先转成 JPEG 字符串。
    var input = inputCanvas;
    try {
      if (inputCanvas && inputCanvas.toDataURL) input = inputCanvas.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      input = inputCanvas;
    }
    // 执行推理。
    var result = await pipe(input);
    if (token !== coverProcessToken) { hideAIDepthChip(); return null; }
    // 兼容不同返回字段。
    var raw = result && (result.depth || result.predicted_depth || result);
    var rawCv = raw && raw.toCanvas ? await raw.toCanvas() : raw;
    hideAIDepthChip();
    return rawCv;
  } catch (e) {
    // 推理失败后冷却两分钟，再回退启发式深度。
    console.warn('AI depth estimation failed:', e);
    aiDepthFailUntil = performance.now() + 120000;
    hideAIDepthChip();
    return null;
  }
}

// 将深度图 dataUrl 解码为 canvas，供后续合并到辅助纹理。
function depthDataUrlToCanvas(dataUrl) {
  return new Promise(function(resolve){
    if (!dataUrl) { resolve(null); return; }
    var img = new Image();
    img.onload = function(){
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      if (!w || !h) { resolve(null); return; }
      var cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      try {
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = function(){ resolve(null); };
    img.src = dataUrl;
  });
}

// 请求云端深度服务，hash 固定使用宿主 SQLite 深度缓存同一个 key。
async function fetchCloudAIDepth(hash, token) {
  if (!isCloudAIDepthMode()) return null;
  hash = String(hash || '').trim();
  if (!hash) return null;
  var api = normalizeAIDepthCloudApi(fx.aiDepthCloudApi);
  if (!api) return null;
  showAIDepthChip('请求云端封面深度…');
  try {
    var resp = await fetch(api + '/depth/' + encodeURIComponent(hash), {
      headers: { 'User-Agent': cloudDepthUserAgent() }
    });
    if (token !== coverProcessToken) { hideAIDepthChip(); return null; }
    var body = null;
    try { body = await resp.json(); } catch (e) {}
    if (!resp.ok) {
      throw new Error((body && body.error) || ('HTTP ' + resp.status));
    }
    if (!body || !body.dataUrl) throw new Error('云端响应缺少 dataUrl');
    var cv = await depthDataUrlToCanvas(body.dataUrl);
    hideAIDepthChip();
    return cv;
  } catch (e) {
    console.warn('Cloud AI depth failed:', e);
    aiDepthFailUntil = performance.now() + 45000;
    hideAIDepthChip();
    return null;
  }
}

// 按当前模式获取 AI 深度图，云端 hash 与本地数据库 hash 保持一致。
async function estimateAIDepthByMode(srcCanvas, token, cacheSeed) {
  var mode = normalizeAIDepthMode(fx.aiDepthMode);
  if (mode === 'local') return estimateAIDepth(srcCanvas, token);
  if (mode === 'cloud') return fetchCloudAIDepth(coverDepthCacheId(cacheSeed), token);
  return null;
}

function mergeAIDepthIntoEdgeTexture(heuristicCanvas, aiCanvas) {
  // 把 AI 深度 (灰度) 写入 R 通道, 保留启发式的 G/B/A
  // 只替换 R 通道是为了复用启发式边缘和前景遮罩，AI 结果只承担更准确的景深层次。
  // 输出纹理尺寸。
  var W = heuristicCanvas.width || 256, H = heuristicCanvas.height || 256;
  // 读取启发式纹理。
  var hctx = heuristicCanvas.getContext('2d', { willReadFrequently: true });
  var hImg = hctx.getImageData(0, 0, W, H);

  // 把 AI 深度图缩放到启发式纹理尺寸。
  var aiTmp = document.createElement('canvas'); aiTmp.width = W; aiTmp.height = H;
  var actx = aiTmp.getContext('2d', { willReadFrequently: true });
  actx.drawImage(aiCanvas, 0, 0, W, H);
  var aData = actx.getImageData(0, 0, W, H).data;

  // 归一化 AI 深度
  // aiVals 保存灰度深度值，min/max 用于归一化。
  var aiVals = new Float32Array(W * H), minV = 1, maxV = 0;
  for (var i = 0; i < aiVals.length; i++) {
    var di = i * 4;
    var v = (aData[di] * 0.299 + aData[di+1] * 0.587 + aData[di+2] * 0.114) / 255;
    aiVals[i] = v; if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  // 深度取值范围，避免除零。
  var range = Math.max(0.001, maxV - minV);
  // 判断是否反相 (中心应该比边缘深, 表示前景在中)
  // 分别统计中心区域和边缘区域平均深度。
  var centerSum = 0, centerCount = 0, edgeSum = 0, edgeCount = 0;
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var i = y * W + x;
    var cx = x / (W-1) - 0.5, cy = y / (H-1) - 0.5;
    var rr = Math.sqrt(cx*cx + cy*cy);
    if (rr < 0.22) { centerSum += aiVals[i]; centerCount++; }
    else if (rr > 0.46) { edgeSum += aiVals[i]; edgeCount++; }
  }
  var invert = (centerSum / Math.max(1, centerCount)) < (edgeSum / Math.max(1, edgeCount));

  for (var i = 0; i < aiVals.length; i++) {
    // 归一化深度并按需要反相。
    var n = (aiVals[i] - minV) / range;
    if (invert) n = 1.0 - n;
    hImg.data[i*4] = Math.round(n * 255);
  }
  hctx.putImageData(hImg, 0, 0);
  return heuristicCanvas;
}

// 判断辅助纹理是否足够大，防止初始化 4×4 占位图进入深度缓存链路。
function isUsableDepthAuxCanvas(canvas) {
  return !!canvas &&
    (canvas.width || 0) >= EPF_MIN_DEPTH_CACHE_SIZE &&
    (canvas.height || 0) >= EPF_MIN_DEPTH_CACHE_SIZE;
}

// 从合并后的辅助纹理导出安全缓存图：RGB 全部写深度，A 固定不透明。
function buildOpaqueDepthCacheCanvas(edgeCanvas) {
  if (!isUsableDepthAuxCanvas(edgeCanvas)) return null;
  var W = edgeCanvas.width, H = edgeCanvas.height;
  var srcCtx = edgeCanvas.getContext('2d', { willReadFrequently: true });
  var srcImg = srcCtx.getImageData(0, 0, W, H);
  var out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  var outCtx = out.getContext('2d');
  var outImg = outCtx.createImageData(W, H);
  for (var i = 0; i < W * H; i++) {
    var di = i * 4;
    var depth = srcImg.data[di];
    outImg.data[di] = depth;
    outImg.data[di + 1] = depth;
    outImg.data[di + 2] = depth;
    outImg.data[di + 3] = 255;
  }
  outCtx.putImageData(outImg, 0, 0);
  return out;
}

// 把新版缓存中的灰度深度合回当前封面的辅助纹理，只替换 R 通道。
function mergeCachedDepthIntoEdgeTexture(heuristicCanvas, depthCanvas) {
  if (!heuristicCanvas || !depthCanvas) return heuristicCanvas;
  var W = heuristicCanvas.width || 256, H = heuristicCanvas.height || 256;
  var hctx = heuristicCanvas.getContext('2d', { willReadFrequently: true });
  var hImg = hctx.getImageData(0, 0, W, H);
  var depthTmp = document.createElement('canvas');
  depthTmp.width = W;
  depthTmp.height = H;
  var dctx = depthTmp.getContext('2d', { willReadFrequently: true });
  dctx.drawImage(depthCanvas, 0, 0, W, H);
  var dData = dctx.getImageData(0, 0, W, H).data;
  for (var i = 0; i < W * H; i++) {
    var di = i * 4;
    hImg.data[di] = Math.round(dData[di] * 0.299 + dData[di + 1] * 0.587 + dData[di + 2] * 0.114);
  }
  hctx.putImageData(hImg, 0, 0);
  return heuristicCanvas;
}

function queueAIDepthForCover(srcCanvas, edgeCanvas, token, opts, cacheSeed, force) {
  // AI 增强排到空闲时段执行，并在每个等待点检查 token 和封面来源，避免后台任务抢占交互帧。
  opts = opts || {};
  var mode = normalizeAIDepthMode(fx.aiDepthMode);
  // 缺少开关或输入时不排队。
  if (mode === 'off' || !srcCanvas || !edgeCanvas) return;
  // 拒绝 4×4 初始化占位图，避免生成低分辨率深度缓存。
  if (!isUsableDepthAuxCanvas(edgeCanvas)) return;
  // 云端模式必须配置基础地址，并且 hash 固定来自当前本地深度缓存 key。
  if (mode === 'cloud' && (!normalizeAIDepthCloudApi(fx.aiDepthCloudApi) || !coverDepthCacheId(cacheSeed))) return;
  // 后台优化释放资源时不启动非强制 AI 任务。
  if (!force && isHiddenForBackgroundOptimization()) return;
  // 模型失败冷却或忙碌中直接跳过。
  if (performance.now() < aiDepthFailUntil || (mode === 'local' && aiDepthBusy)) return;
  // 限制非强制 AI 深度任务频率。
  var now = performance.now();
  if (!force && now - aiDepthLastRunAt < aiDepthMinGapMs) return;
  aiDepthLastRunAt = now;
  scheduleVisualApply(async function(){
    // 所有异步阶段都校验 token 和封面来源。
    if (normalizeAIDepthMode(fx.aiDepthMode) !== mode || token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    await yieldToIdle(force ? 900 : 2600);
    if (normalizeAIDepthMode(fx.aiDepthMode) !== mode || token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    // 推理成功后合并到当前 edgeCanvas。
    var aiCanvas = await estimateAIDepthByMode(srcCanvas, token, cacheSeed);
    if (!aiCanvas || token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    mergeAIDepthIntoEdgeTexture(edgeCanvas, aiCanvas);
    coverEdgeTex.image = edgeCanvas;
    coverEdgeTex.needsUpdate = true;
    currentCoverEdgeCacheSeed = cacheSeed;
    // 更新深度状态和缓存。
    setCoverDepthState(1, 1.0, 360);
    (async function(){
      var hash = coverDepthCacheId(cacheSeed);
      var cacheCanvas = buildOpaqueDepthCacheCanvas(edgeCanvas);
      if (!cacheCanvas) return;
      var dataUrl = cacheCanvas.toDataURL('image/png');
      console.log('[深度缓存] 写入 AI 深度:', { hash: hash, id: cacheSeed, width: cacheCanvas.width, height: cacheCanvas.height, format: EPF_DEPTH_CACHE_FORMAT, dataUrl: dataUrl, timestamp: Date.now() });
      await putDepthToStorage(hash, dataUrl, cacheCanvas.width, cacheCanvas.height, EPF_DEPTH_CACHE_FORMAT);
    })();
    showToast(mode === 'cloud' ? '云端深度已后台增强' : 'AI 深度已后台增强');
  }, force ? 240 : 1800, force ? 1200 : 3000);
}

// 对当前封面强制排队一次 AI 深度增强。
function queueAIDepthForCurrentCover(force) {
  // 当前封面或深度纹理不可用时跳过。
  if (!coverTex || !coverTex.image || !coverEdgeTex || !coverEdgeTex.image) return;
  if (!uniforms.uHasCover.value) return;
  if (!currentCoverDepthCacheSeed) return;
  var edgeCanvas = coverEdgeTex.image;
  if (!isUsableDepthAuxCanvas(edgeCanvas) || currentCoverEdgeCacheSeed !== currentCoverDepthCacheSeed) {
    try {
      edgeCanvas = buildEdgeAndDepth(coverTex.image);
      coverEdgeTex.image = edgeCanvas;
      coverEdgeTex.needsUpdate = true;
      currentCoverEdgeCacheSeed = currentCoverDepthCacheSeed;
    } catch (e) {
      console.warn('[深度缓存] 当前封面辅助纹理重建失败', e);
      return;
    }
  }
  if (!isUsableDepthAuxCanvas(edgeCanvas)) return;
  queueAIDepthForCover(coverTex.image, edgeCanvas, coverProcessToken, {}, currentCoverDepthCacheSeed, !!force);
}

// 颜色渐变 tween (切歌时旧封面→新封面)
// 当前封面颜色混合动画句柄。
var colorMixTween = null;
// 启动新旧封面颜色混合动画。
function startColorMixTween(durationMs) {
  // 取消上一轮混合动画。
  if (colorMixTween) cancelAnimationFrame(colorMixTween.raf);
  // 动画时长至少 1ms。
  durationMs = Math.max(1, durationMs || 1);
  // 记录起点时间。
  var start = performance.now();
  // 从旧封面开始混合。
  uniforms.uColorMixT.value = 0;
  // requestAnimationFrame 步进函数。
  function step(now) {
    // 计算 0..1 进度。
    var t = Math.min(1, (now - start) / durationMs);
    // 使用视觉缓动曲线。
    t = visualEase(t);
    uniforms.uColorMixT.value = t;
    if (t < 1) colorMixTween = { raf: requestAnimationFrame(step) };
    else colorMixTween = null;
  }
  colorMixTween = { raf: requestAnimationFrame(step) };
}

// 粒子整体透明度 tween (启动 fade-in)
// 主粒子透明度动画句柄。
var alphaTween = null;
// 浮空粒子透明度动画句柄。
var floatAlphaTween = null;
// 空闲粒子目标透明度，当前默认关闭。
var IDLE_PARTICLE_ALPHA = 0;
// 缓动主粒子整体透明度。
function tweenParticleAlpha(from, to, durationMs) {
  // 取消上一轮透明度动画。
  if (alphaTween) cancelAnimationFrame(alphaTween.raf);
  // 记录起点时间。
  var start = performance.now();
  // requestAnimationFrame 步进函数。
  function step(now) {
    // smoothstep 进度。
    var t = Math.min(1, (now - start) / durationMs);
    t = t * t * (3 - 2 * t);
    uniforms.uAlpha.value = from + (to - from) * t;
    if (t < 1) alphaTween = { raf: requestAnimationFrame(step) };
    else alphaTween = null;
  }
  alphaTween = { raf: requestAnimationFrame(step) };
}
// 缓动浮空粒子透明度。
function tweenFloatAlpha(from, to, durationMs) {
  // 取消上一轮浮空透明度动画。
  if (floatAlphaTween) cancelAnimationFrame(floatAlphaTween.raf);
  // 记录起点时间。
  var start = performance.now();
  function step(now) {
    var t = Math.min(1, (now - start) / durationMs);
    t = t * t * (3 - 2 * t);
    uniforms.uFloatAlpha.value = from + (to - from) * t;
    if (t < 1) floatAlphaTween = { raf: requestAnimationFrame(step) };
    else floatAlphaTween = null;
  }
  floatAlphaTween = { raf: requestAnimationFrame(step) };
}
// 显示空闲粒子；当前版本会清空浮空层并保持透明。
function revealIdleParticles(target, durationMs) {
  // uniform 不存在时跳过。
  if (!uniforms || !uniforms.uFloatAlpha) return;
  // 取消浮空透明度动画并归零。
  if (floatAlphaTween) { cancelAnimationFrame(floatAlphaTween.raf); floatAlphaTween = null; }
  uniforms.uFloatAlpha.value = 0;
  if (floatGroup) destroyFloatLayer();
}
// 显示用户选择的视觉预设粒子层。
function revealUserPresetParticles(opts) {
  // opts 支持 instant、alpha、duration 等控制。
  opts = opts || {};
  if (!uniforms || !uniforms.uAlpha) return;
  // 用户预设出现时关闭浮空层。
  if (uniforms.uFloatAlpha) uniforms.uFloatAlpha.value = 0;
  if (floatGroup) destroyFloatLayer();
  if (typeof syncFxUniforms === 'function') syncFxUniforms();
  if (typeof SKULL_PRESET_INDEX !== 'undefined' && fx && fx.preset === SKULL_PRESET_INDEX && typeof loadSkullParticleAsset === 'function') {
    // 骷髅预设提前加载点云资源。
    loadSkullParticleAsset();
  }
  // 主粒子目标透明度。
  var target = typeof opts.alpha === 'number' ? opts.alpha : 0.96;
  // 当前透明度。
  var current = uniforms.uAlpha.value || 0;
  if (opts.instant) {
    // instant 模式直接设置目标透明度。
    if (alphaTween) { cancelAnimationFrame(alphaTween.raf); alphaTween = null; }
    uniforms.uAlpha.value = target;
    return;
  }
  if (current < target - 0.01) tweenParticleAlpha(current, target, opts.duration || 920);
}

// 加载形态 tween (uLoading 0..1)
// 加载动画句柄。
var loadingTween = null;
// 加载态显示开始时间。
var loadingShownAt = 0;
// 加载态延迟隐藏定时器，用于避免封面快速切换时 loading 闪烁。
var loadingHideTimer = null;
// 封面深度与 AI 增强强度的补间动画句柄。
var coverDepthTween = null;
// 视觉补间通用缓动函数，把线性进度压成平滑的 0..1 曲线。
function visualEase(t) {
  // 先把进度夹在合法区间内，避免动画超界导致 uniform 数值漂移。
  t = Math.max(0, Math.min(1, t));
  // smoothstep 曲线，起止速度为 0，适合 loading 和深度状态的短动画。
  return t * t * (3 - 2 * t);
}
// 将粒子材质的加载态 uniform 补间到指定值。
function tweenLoading(to, durationMs, onComplete) {
  // 新 loading 动画开始前取消旧帧，保证同一时间只有一个补间写 uLoading。
  if (loadingTween) cancelAnimationFrame(loadingTween.raf);
  // 最小持续时间为 1ms，避免除以 0。
  durationMs = Math.max(1, durationMs || 1);
  // 后台省电或深度后台模式不跑动画，直接落到目标值并回调。
  if (isHiddenForBackgroundOptimization() || isDeepBackgroundMode()) {
    uniforms.uLoading.value = to;
    loadingTween = null;
    if (onComplete) onComplete();
    return;
  }
  // 记录补间起点时间和值，后续帧只根据时间差推进。
  var start = performance.now();
  var from = uniforms.uLoading.value;
  // requestAnimationFrame 驱动的逐帧补间逻辑。
  function step(now) {
    // 当前帧归一化进度。
    var t = Math.min(1, (now - start) / durationMs);
    // 平滑后的进度。
    var eased = visualEase(t);
    // 根据起点和目标值写入 loading 强度。
    uniforms.uLoading.value = from + (to - from) * eased;
    if (t < 1) loadingTween = { raf: requestAnimationFrame(step) };
    else {
      // 结束帧强制对齐目标值，消除浮点误差。
      uniforms.uLoading.value = to;
      loadingTween = null;
      if (onComplete) onComplete();
    }
  }
  // 保存动画帧句柄，便于后续封面切换或后台恢复时取消。
  loadingTween = { raf: requestAnimationFrame(step) };
}
// 隐藏封面加载态，并保留极短最小显示时间减少闪烁。
function hideLoading() {
  // 重复调用时重置上一次延迟隐藏任务。
  if (loadingHideTimer) clearTimeout(loadingHideTimer);
  // 后台场景直接收敛 loading，不再排队动画。
  if (isHiddenForBackgroundOptimization() || isDeepBackgroundMode()) {
    forceLoadingSettled('background-hide');
    return;
  }
  // 计算 loading 已显示多久，至少显示约一帧以上再隐藏。
  var elapsed = loadingShownAt ? performance.now() - loadingShownAt : 999;
  // 短等待用于防止封面刚开始加载就结束时出现肉眼可见闪动。
  var wait = Math.max(0, 72 - elapsed);
  loadingHideTimer = setTimeout(function(){
    loadingHideTimer = null;
    // 根据当前 loading 强度决定是否需要补间淡出。
    var current = uniforms.uLoading.value || 0;
    if (current <= 0.015 || isHiddenForBackgroundOptimization() || isDeepBackgroundMode()) {
      // 已经接近 0 或进入后台时，取消补间并直接清零。
      if (loadingTween) {
        cancelAnimationFrame(loadingTween.raf);
        loadingTween = null;
      }
      uniforms.uLoading.value = 0;
      return;
    }
    // loading 越明显，淡出时间略长，避免突然跳变。
    tweenLoading(0, current > 0.38 ? 126 : 96);
  }, wait);
}
// 强制让加载态进入稳定关闭状态，通常用于后台恢复或异常收尾。
function forceLoadingSettled(reason) {
  // 清理延迟隐藏定时器。
  if (loadingHideTimer) {
    clearTimeout(loadingHideTimer);
    loadingHideTimer = null;
  }
  // 清理正在进行的 loading 补间。
  if (loadingTween) {
    cancelAnimationFrame(loadingTween.raf);
    loadingTween = null;
  }
  // 直接关闭 shader loading 状态并重置显示起点。
  uniforms.uLoading.value = 0;
  loadingShownAt = 0;
  // 调试开关开启时输出收敛原因，默认不影响控制台。
  if (reason && window.__mineradioDebugLoading) console.log('[LoadingSettled]', reason);
}
// 页面从后台或省电状态恢复后，修复渲染器、视口与 loading 残留状态。
function recoverVisualsAfterBackground(reason) {
  // 重新按当前可见性和性能策略应用渲染功耗模式。
  applyRendererPowerMode();
  // 如果主渲染视口刷新函数已经加载，则请求一次恢复刷新。
  if (typeof scheduleMainRendererViewportRefresh === 'function') scheduleMainRendererViewportRefresh(reason || 'restore');
  // 播放中恢复时，如果 loading 仍挂起，直接收敛，避免画面卡在加载形态。
  if (audio && audio.src && !audio.paused && ((uniforms.uLoading.value || 0) > 0.015 || loadingTween || loadingHideTimer)) {
    forceLoadingSettled(reason || 'restore');
  }
  // 背景恢复视为一次交互窗口，短时间提高渲染响应。
  if (typeof markRenderInteraction === 'function') markRenderInteraction('restore', 1100);
}

// 平滑切换封面深度贴图有效性和 AI 深度增强强度。
function setCoverDepthState(depthTo, aiTo, durationMs) {
  // 目标值统一夹在 0..1，避免外部调用传入异常数值。
  depthTo = Math.max(0, Math.min(1, Number(depthTo) || 0));
  aiTo = Math.max(0, Math.min(1, Number(aiTo) || 0));
  // 新的深度状态动画开始前取消旧动画。
  if (coverDepthTween) {
    cancelAnimationFrame(coverDepthTween.raf);
    coverDepthTween = null;
  }
  // 标准化动画时长。
  durationMs = Math.max(1, durationMs || 1);
  // 记录当前 shader 中的深度和 AI 增强强度。
  var depthFrom = uniforms.uHasDepth.value || 0;
  var aiFrom = uniforms.uAiBoost.value || 0;
  // 极短动画或目标几乎未变时直接写入，避免无意义 RAF。
  if (durationMs <= 1 || (Math.abs(depthFrom - depthTo) < 0.001 && Math.abs(aiFrom - aiTo) < 0.001)) {
    uniforms.uHasDepth.value = depthTo;
    uniforms.uAiBoost.value = aiTo;
    return;
  }
  // 记录动画起点时间。
  var start = performance.now();
  // 逐帧推进深度状态补间。
  function step(now) {
    // 当前补间进度。
    var t = Math.min(1, (now - start) / durationMs);
    // 平滑后的补间进度。
    var eased = visualEase(t);
    // 同步写入普通深度和 AI 增强两个 uniform。
    uniforms.uHasDepth.value = depthFrom + (depthTo - depthFrom) * eased;
    uniforms.uAiBoost.value = aiFrom + (aiTo - aiFrom) * eased;
    if (t < 1) coverDepthTween = { raf: requestAnimationFrame(step) };
    else {
      // 结束帧强制对齐目标值并释放句柄。
      uniforms.uHasDepth.value = depthTo;
      uniforms.uAiBoost.value = aiTo;
      coverDepthTween = null;
    }
  }
  // 保存 RAF 句柄，供后续封面切换取消。
  coverDepthTween = { raf: requestAnimationFrame(step) };
}

// 判断当前封面处理任务是否仍对应最新曲目，防止异步加载串歌。
function coverApplyStillCurrent(opts) {
  opts = opts || {};
  return !opts.trackToken || opts.trackToken === trackSwitchToken;
}

// 更新底部控制条中的封面缩略图背景。
function setControlCoverSrc(src) {
  // 控制条封面节点可能在不同布局下不存在。
  var cover = document.getElementById('control-cover');
  if (!cover) return;
  if (!src) {
    // 无封面时清空背景并标记为空态。
    cover.style.backgroundImage = '';
    cover.classList.add('cover-empty');
    return;
  }
  // 作为 CSS url 写入时转义双引号，避免路径中引号破坏样式。
  cover.style.backgroundImage = 'url("' + String(src).replace(/"/g, '\\"') + '")';
  cover.classList.remove('cover-empty');
}

// 更新底部控制条中的曲名和歌手。
function updateControlTrackInfo(song) {
  song = song || {};
  // 曲名文本节点。
  var title = document.getElementById('control-title');
  // 歌手文本节点。
  var artist = document.getElementById('control-artist');
  if (title) title.textContent = song.name || '';
  if (artist) artist.textContent = song.artist || '';
}

// 把已经解码并缩放好的封面 canvas 应用到主粒子材质、UI 缩略图和相关缓存。
function applyCoverCanvas(cv, thumbSrc, opts) {
  opts = opts || {};
  if (!cv || !coverApplyStillCurrent(opts)) return;
  var token = ++coverProcessToken;
  if (opts.coverSource && opts.coverSourceKind) {
    currentCoverSource = { kind: opts.coverSourceKind, src: opts.coverSource };
  }
  var cacheSeed = (opts.coverKey || thumbSrc || '') + '|tex=' + (cv.width || 0) + 'x' + (cv.height || 0);
  currentCoverDepthCacheSeed = cacheSeed;
  currentCoverEdgeCacheSeed = '';

  if (uniforms.uHasCover.value > 0.5 && coverTex.image) {
    var prevW = coverTex.image.width || 256;
    var prevH = coverTex.image.height || 256;
    var prevScale = Math.min(1, 256 / Math.max(prevW, prevH, 1));
    var prevCv = document.createElement('canvas');
    prevCv.width = Math.max(1, Math.round(prevW * prevScale));
    prevCv.height = Math.max(1, Math.round(prevH * prevScale));
    try {
      prevCv.getContext('2d').drawImage(coverTex.image, 0, 0, prevCv.width, prevCv.height);
      prevCoverTex.image = prevCv;
      prevCoverTex.needsUpdate = true;
    } catch (e) {}
  }
  coverTex.image = cv; coverTex.needsUpdate = true;
  coverPickerCanvas = cv;
  uniforms.uHasCover.value = 1;
  // 初始状态设为平面，等待异步深度缓存或启发式生成
  setCoverDepthState(0, 0, opts.deferHeavy ? 120 : 1);

  if (thumbSrc) {
    document.getElementById('thumb-cover').src = thumbSrc;
    setControlCoverSrc(thumbSrc);
  }
  if (shelfManager) shelfManager.onCoverChange(thumbSrc);

  var colorMixMs = opts.colorMixDuration || (fx.preset === 0 ? 520 : 1400);
  startColorMixTween(opts.fromResolutionChange ? (fx.preset === 0 ? 300 : 520) : colorMixMs);

  function refreshCoverDependentColors() {
    if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    if (floatGroup) refreshFloatColorsFromCover(cv);
    if (backCoverGroup) refreshBackCoverColorsFromCanvas(cv);
    updateLyricPaletteFromCover(cv);
  }

  function runHeavyCoverWork() {
    if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    if (opts.deferHeavy && typeof isRenderInteractionActive === 'function' && isRenderInteractionActive()) {
      scheduleVisualApply(runHeavyCoverWork, 420, 1800);
      return;
    }
    var edgeCv = buildEdgeAndDepth(cv);
    if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return;
    coverEdgeTex.image = edgeCv; coverEdgeTex.needsUpdate = true;
    currentCoverEdgeCacheSeed = cacheSeed;
    refreshCoverDependentColors();
    queueAIDepthForCover(cv, edgeCv, token, opts, cacheSeed, false);
  }

  // 从插件数据库异步加载深度缓存；关闭模式不读取 AI 深度缓存。
  if (isAIDepthEnabled()) {
    var depthCacheMode = normalizeAIDepthMode(fx.aiDepthMode);
    var scheduleDepthCacheFallback = function() {
      var heavyDelay = opts.deferHeavy ? (opts.delay || 620) : (opts.delay || 120)
      var heavyTimeout = opts.deferHeavy ? (opts.timeout || 1800) : (opts.timeout || 900)
      scheduleVisualApply(runHeavyCoverWork, heavyDelay, heavyTimeout)
    };
    (async function(){
      var hash = coverDepthCacheId(cacheSeed)
      var cachedDepth = await getDepthFromStorage(hash)
      if (normalizeAIDepthMode(fx.aiDepthMode) !== depthCacheMode) {
        scheduleDepthCacheFallback()
        return
      }
      if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return
      if (cachedDepth && cachedDepth.dataUrl && cachedDepth.width && cachedDepth.height) {
        if (cachedDepth.format === EPF_DEPTH_CACHE_FORMAT) {
          var depthCv = await depthDataUrlToCanvas(cachedDepth.dataUrl)
          if (normalizeAIDepthMode(fx.aiDepthMode) !== depthCacheMode) {
            scheduleDepthCacheFallback()
            return
          }
          if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return
          if (!depthCv) {
            scheduleDepthCacheFallback()
            return
          }
          var mergedEdgeCv = null
          try {
            mergedEdgeCv = buildEdgeAndDepth(cv)
            mergeCachedDepthIntoEdgeTexture(mergedEdgeCv, depthCv)
          } catch (e) {
            console.warn('[深度缓存] 新格式读取失败', e)
            scheduleDepthCacheFallback()
            return
          }
          if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return
          coverEdgeTex.image = mergedEdgeCv
          coverEdgeTex.needsUpdate = true
          currentCoverEdgeCacheSeed = cacheSeed
          setCoverDepthState(1, 1.0, opts.deferHeavy ? 180 : 120)
          scheduleVisualApply(refreshCoverDependentColors, opts.deferHeavy ? 260 : 90, opts.deferHeavy ? 1200 : 700)
          return
        }
        var img = new Image()
        img.src = cachedDepth.dataUrl
        await new Promise(function(resolve){ img.onload = resolve; img.onerror = resolve })
        if (normalizeAIDepthMode(fx.aiDepthMode) !== depthCacheMode) {
          scheduleDepthCacheFallback()
          return
        }
        if (token !== coverProcessToken || !coverApplyStillCurrent(opts)) return
        var edgeCv = document.createElement('canvas')
        edgeCv.width = cachedDepth.width
        edgeCv.height = cachedDepth.height
        edgeCv.getContext('2d').drawImage(img, 0, 0)
        coverEdgeTex.image = edgeCv
        coverEdgeTex.needsUpdate = true
        currentCoverEdgeCacheSeed = cacheSeed
        // 数据库深度条目均为 AI 深度，直接激活立体效果。
        setCoverDepthState(1, 1.0, opts.deferHeavy ? 180 : 120)
        scheduleVisualApply(refreshCoverDependentColors, opts.deferHeavy ? 260 : 90, opts.deferHeavy ? 1200 : 700)
        return
      }
      scheduleDepthCacheFallback()
    })().catch(function(e){ console.warn('[深度缓存] 异步加载失败', e) })
  } else {
    var heavyDelay = opts.deferHeavy ? (opts.delay || 620) : (opts.delay || 120)
    var heavyTimeout = opts.deferHeavy ? (opts.timeout || 1800) : (opts.timeout || 900)
    scheduleVisualApply(runHeavyCoverWork, heavyDelay, heavyTimeout)
  }
}

// ============================================================
//  插件端节奏分析已移除
//    频谱、节拍和波形只来自 EchoMusic 宿主推送。
// ============================================================
// 生成节拍图缓存键，用于把宿主推送的节拍数据和当前歌曲关联。
function beatMapSongKey(song) {
  // 无歌曲时没有可缓存的 key。
  if (!song) return '';
  // 本地歌曲优先使用 localKey，避免同名歌曲冲突。
  if (song.type === 'local' && song.localKey) return 'local:' + song.localKey;
  // QQ 音乐歌曲优先使用 mid/songmid/id，最后才退回歌名和歌手。
  if (songProviderKey(song) === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  // 其他来源有稳定 id 时使用通用 song 前缀。
  if (song.id != null && song.id !== '') return 'song:' + song.id;
  return '';
}

// 隐藏节拍状态提示胶囊。
function hideBeatChip() {
  document.getElementById('beat-chip').classList.remove('show');
}

// 每帧调用 — 按 beatMap 触发预演鼓点
// 根据当前播放时间同步普通节拍图游标，并可选择保留当前视觉状态。
function syncBeatMapPlaybackCursor(t, preserveVisualState) {
  // DJ 模式使用独立节拍图和游标。
  if (djMode.active) {
    syncDjBeatMapCursor(t, preserveVisualState);
    return;
  }
  // 播放时间归一化，非法值按 0 处理。
  t = isFinite(t) ? t : 0;
  // 从头扫描到当前时间对应的下一个脉冲位置。
  beatMapNextIdx = 0;
  // 优先使用脉冲节拍，兼容旧数据中的 kicks。
  var pulseEvents = currentBeatMap && (currentBeatMap.pulseBeats || currentBeatMap.kicks);
  if (pulseEvents) {
    while (beatMapNextIdx < pulseEvents.length && beatEventTime(pulseEvents[beatMapNextIdx]) < t) beatMapNextIdx++;
  }
  // 保留视觉状态时只对齐相机游标，否则把相机同步到当前时间。
  if (preserveVisualState) alignBeatCameraCursorToTime(t);
  else syncBeatCameraToTime(t);
}

// 根据当前播放时间同步 DJ 模式节拍图游标。
function syncDjBeatMapCursor(t, preserveVisualState) {
  // 播放时间归一化。
  t = isFinite(t) ? t : 0;
  // DJ 相机节拍游标。
  djBeatMapNextIdx = 0;
  // DJ 粒子脉冲游标。
  djBeatPulseNextIdx = 0;
  if (currentDjBeatMap) {
    // 相机节拍兼容 cameraBeats、beats、kicks 三种字段。
    var beatEvents = currentDjBeatMap.cameraBeats || currentDjBeatMap.beats || currentDjBeatMap.kicks || [];
    // 相机节拍略微提前对齐，避免视觉动作落后听感。
    var camSyncTime = Math.max(0, t - 0.025);
    while (djBeatMapNextIdx < beatEvents.length && beatEventTime(beatEvents[djBeatMapNextIdx]) < camSyncTime) djBeatMapNextIdx++;
    // 脉冲节拍兼容 pulseBeats 和 kicks。
    var pulseEvents = currentDjBeatMap.pulseBeats || currentDjBeatMap.kicks || [];
    // 脉冲也略微提前对齐，让切换后立即落在正确节拍窗口。
    var pulseSyncTime = Math.max(0, t - 0.035);
    while (djBeatPulseNextIdx < pulseEvents.length && beatEventTime(pulseEvents[djBeatPulseNextIdx]) < pulseSyncTime) djBeatPulseNextIdx++;
  }
  // 不保留视觉状态时重置相机节拍同步状态。
  if (!preserveVisualState) resetBeatCameraSync(t);
}

// 播放中按 DJ 节拍图触发相机动作和粒子脉冲。
function tickDjBeatMap() {
  // 仅在 DJ 模式、有节拍图且音频播放中工作。
  if (!djMode.active || !currentDjBeatMap || !audio || audio.paused) return;
  // 当前播放时间。
  var t = audio.currentTime || 0;
  // 部分节拍图只覆盖前段，超过覆盖区和预读窗口后停止调度。
  if (currentDjBeatMap.partialUntilSec && t > currentDjBeatMap.partialUntilSec + beatCam.lookahead) return;
  // 相机节拍事件列表。
  var beatEvents = currentDjBeatMap.cameraBeats || currentDjBeatMap.beats || currentDjBeatMap.kicks || [];
  // 粒子脉冲事件列表。
  var pulseEvents = currentDjBeatMap.pulseBeats || currentDjBeatMap.kicks || [];
  // 在预读窗口内提前调度相机动作。
  while (djBeatMapNextIdx < beatEvents.length) {
    // 当前待调度相机节拍。
    var beat = beatEvents[djBeatMapNextIdx];
    // 当前节拍时间。
    var beatTime = beatEventTime(beat);
    if (beatTime > t + beatCam.lookahead) break;
    scheduleBeatCamera(beat, 'djmap');
    djBeatMapNextIdx++;
  }
  // 到达当前时间的脉冲立即触发。
  while (djBeatPulseNextIdx < pulseEvents.length && beatEventTime(pulseEvents[djBeatPulseNextIdx]) <= t) {
    triggerScheduledBeat(pulseEvents[djBeatPulseNextIdx]);
    djBeatPulseNextIdx++;
  }
}

// 播放中按普通节拍图触发相机动作和粒子脉冲。
function tickBeatMap() {
  // DJ 模式由 tickDjBeatMap 接管。
  if (djMode.active) return;
  // 无节拍图或未播放时不调度。
  if (!currentBeatMap || !audio || audio.paused) return;
  // 当前播放时间。
  var t = audio.currentTime;
  // 相机节拍事件列表。
  var beatEvents = currentBeatMap.cameraBeats || currentBeatMap.beats || currentBeatMap.kicks || [];
  // 粒子脉冲事件列表。
  var pulseEvents = currentBeatMap.pulseBeats || currentBeatMap.kicks || [];
  // 宿主节拍网格可信且数量足够时，优先按网格驱动。
  var gridTimingLocked = currentBeatMap.tempoSource === 'host' && beatEvents.length >= 4;
  // 实时节拍锁定的新鲜窗口，超过窗口说明实时节拍暂时不可靠。
  var liveFreshWindow = Math.max(0.50, rtBeat.tempoGap ? rtBeat.tempoGap * 1.18 : 0.50);
  // 实时节拍是否仍处于锁定状态。
  var realtimeHasLock = rtBeat.lastHitAt > 0 && (t - rtBeat.lastHitAt) < liveFreshWindow;
  // 在预读窗口内调度相机节拍。
  while (beatCam.nextIdx < beatEvents.length) {
    // 当前待调度相机节拍。
    var beat = beatEvents[beatCam.nextIdx];
    // 支持数字节拍和对象节拍两种格式。
    var beatTime = typeof beat === 'number' ? beat : beat.time;
    if (beatTime > t + beatCam.lookahead) break;
    // 若实时节拍仍锁定且宿主网格不可靠，则避免重复触发相机动作。
    if (gridTimingLocked || !realtimeHasLock) scheduleBeatCamera(beat, 'map');
    beatCam.nextIdx++;
  }
  // 到达当前时间的脉冲节拍触发粒子冲击。
  while (beatMapNextIdx < pulseEvents.length && beatEventTime(pulseEvents[beatMapNextIdx]) <= t) {
    // 触发预演冲击
    if (gridTimingLocked || !realtimeHasLock) triggerScheduledBeat(pulseEvents[beatMapNextIdx]);
    beatMapNextIdx++;
  }
}

// 把节拍事件转换为下一帧 shader 可消费的脉冲强度。
function triggerScheduledBeat(beat) {
  // 节拍基础强度，数字节拍直接使用默认或数字值，对象节拍读取 strength。
  var strength = typeof beat === 'number' ? 0.42 : Math.max(0, Math.min(1, beat && beat.strength != null ? beat.strength : 0.42));
  // impact 表示视觉冲击强度，缺省回退到 strength。
  var impact = typeof beat === 'number' ? strength : Math.max(0, Math.min(1, beat && beat.impact != null ? beat.impact : strength));
  // 过弱事件不触发，减少微小误检导致的画面抖动。
  if (impact < 0.18 && strength < 0.52) return;
  // 动态缩放很低时进一步过滤弱事件，避免安静歌曲视觉过度。
  if ((cinemaTrackProfile.scale || 1) < 0.52 && impact < 0.46 && strength < 0.74) return;
  // body 表示低频身体感，用于增加粒子脉冲厚度。
  var body = typeof beat === 'number' ? 0 : Math.max(0, Math.min(1, beat && beat.body != null ? beat.body : 0));
  // combo 描述下拍、drop 等组合节拍。
  var combo = typeof beat === 'number' ? null : beat && beat.combo;
  // 特殊组合节拍给少量额外抬升。
  var comboLift = combo === 'downbeat' ? 0.08 : (combo === 'drop' ? 0.04 : 0);
  // 根据当前电影化曲线缩放脉冲强度。
  var dynScale = cameraDynamicsScale(0.88 + impact * 0.16);
  // DJ 节拍采用单独的强度上限和权重。
  var djPulse = beat && beat.dj;
  // 综合多个节拍维度得到最终脉冲候选值。
  var pulse = (0.14 + strength * 0.46 + impact * 0.18 + body * 0.08 + comboLift) * dynScale;
  if (djPulse) pulse = (0.12 + strength * 0.50 + impact * 0.28 + comboLift * 0.70) * clampRange(dynScale, 0.78, 1.18);
  // 控制普通和 DJ 脉冲上限。
  pulse = Math.min(djPulse ? 0.92 : 0.78, pulse);
  // 同一帧内多个事件取最大脉冲。
  scheduledBeatPulse = Math.max(scheduledBeatPulse, pulse);
  // 标记下一帧需要消费节拍脉冲。
  scheduledBeatFlag = true;
}
// 下一帧待消费的节拍脉冲强度。
var scheduledBeatPulse = 0;
// 下一帧是否存在待消费节拍脉冲。
var scheduledBeatFlag = false;

// 显示 AI 深度处理状态提示。
function showAIDepthChip(text) {
  document.getElementById('ai-depth-text').textContent = text || 'AI 深度估计…';
  document.getElementById('ai-depth-chip').classList.add('show');
}
// 隐藏 AI 深度处理状态提示。
function hideAIDepthChip() {
  document.getElementById('ai-depth-chip').classList.remove('show');
}

// 从远程 URL 加载封面，裁剪成方形 canvas 后交给封面应用链路。
function loadCoverFromUrl(directUrl, opts) {
  // URL 封面加载会先走代理以规避跨域 canvas 污染；失败后再尝试原始地址作为降级。
  opts = opts || {};
  if (!directUrl || typeof directUrl !== 'string' || !/^https?:\/\//i.test(directUrl)) {
    // 空封面也要递增 token，这样已经在途的旧图片或旧 AI 深度结果不会回写到空状态。
    if (!coverApplyStillCurrent(opts)) return;
    // 清除当前封面来源记录。
    currentCoverSource = null;
    currentCoverDepthCacheSeed = '';
    currentCoverEdgeCacheSeed = '';
    // 递增封面处理 token，让旧异步任务失效。
    coverProcessToken++;
    // 关闭封面和深度状态。
    uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
    // 浮空粒子回到空闲配色。
    resetFloatColorsToIdle();
    // 隐藏背景封面。
    document.getElementById('album-bg').classList.remove('visible');
    // 清空底部缩略图。
    document.getElementById('thumb-cover').removeAttribute('src');
    // 清空控制条封面。
    setControlCoverSrc('');
    return;
  }
  // 先用原始地址更新背景图，背景不需要读像素，因此不受 canvas 跨域限制。
  document.getElementById('album-bg').style.backgroundImage = "url(" + directUrl + ")";
  document.getElementById('album-bg').classList.add('visible');
  // 生成代理 URL，供后续 canvas 读像素和深度处理使用。
  var proxiedUrl = coverProxySrc(directUrl);
  if (!proxiedUrl) {
    // 没有可用代理时关闭封面纹理，只保留背景图降级。
    uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
    currentCoverDepthCacheSeed = '';
    currentCoverEdgeCacheSeed = '';
    resetFloatColorsToIdle();
    setControlCoverSrc('');
    return;
  }
  // 通过代理加载可跨域读取像素的图片。
  var img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
  img.onload = function() {
    // 图片加载完成后再裁剪为正方形 canvas，供封面纹理和深度流水线共用。
    if (!coverApplyStillCurrent(opts)) return;
    // 根据当前封面分辨率偏好决定纹理尺寸。
    var size = coverTextureSizeForResolution(fx.coverResolution);
    // 创建方形封面 canvas。
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    // 方形封面绘制上下文。
    var cx = cv.getContext('2d');
    // 原图尺寸和中心裁剪边长。
    var iw = img.naturalWidth, ih = img.naturalHeight, s = Math.min(iw, ih);
    cx.drawImage(img, (iw-s)/2, (ih-s)/2, s, s, 0, 0, size, size);
    // 进入统一封面应用链路，并保留原始 URL 作为缓存 key。
    applyCoverCanvas(cv, proxiedUrl || directUrl, Object.assign({}, opts, { coverKey: directUrl || proxiedUrl || '', coverSourceKind: 'url', coverSource: directUrl }));
  };
  img.onerror = function() {
    // 代理加载失败时回退到原始地址加载。
    var img2 = new Image(); img2.crossOrigin = 'anonymous'; img2.decoding = 'async';
    img2.onload = function() {
      // 回退图片加载完成后仍要防串。
      if (!coverApplyStillCurrent(opts)) return;
      // 回退路径使用同一封面尺寸。
      var size = coverTextureSizeForResolution(fx.coverResolution);
      // 创建方形封面 canvas。
      var cv = document.createElement('canvas'); cv.width = cv.height = size;
      cv.getContext('2d').drawImage(img2, 0, 0, size, size);
      // 回退路径进入统一封面应用链路。
      applyCoverCanvas(cv, directUrl, Object.assign({}, opts, { coverKey: directUrl || '', coverSourceKind: 'url', coverSource: directUrl }));
    };
    img2.onerror = function() {
      // 两次加载都失败时，只清空可读封面纹理和相关 UI。
      if (!coverApplyStillCurrent(opts)) return;
      currentCoverSource = null;
      currentCoverDepthCacheSeed = '';
      currentCoverEdgeCacheSeed = '';
      uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
      resetFloatColorsToIdle();
      setControlCoverSrc('');
    };
    // 启动原始地址回退加载。
    img2.src = directUrl;
  };
  // 启动代理地址加载。
  img.src = proxiedUrl;
}

// 设置页面背景层的封面图显示状态。
function setAlbumBackground(src) {
  // 背景节点可能在精简布局中不存在。
  var bg = document.getElementById('album-bg');
  if (!bg) return;
  if (!src) {
    // 无地址时隐藏背景并清空背景图。
    bg.classList.remove('visible');
    bg.style.backgroundImage = '';
    return;
  }
  // 有地址时写入背景图并显示。
  bg.style.backgroundImage = "url(" + src + ")";
  bg.classList.add('visible');
}

// 将任意图片绘制为指定尺寸的方形封面 canvas。
function makeSquareCoverCanvas(img, size, crop) {
  // 默认输出 512 像素方图。
  size = size || 512;
  // 输出封面 canvas。
  var cv = document.createElement('canvas');
  cv.width = cv.height = size;
  // 输出 canvas 绘制上下文。
  var cx = cv.getContext('2d');
  cx.clearRect(0, 0, size, size);
  // 图片原始宽度。
  var iw = img.naturalWidth || img.width;
  // 图片原始高度。
  var ih = img.naturalHeight || img.height;
  if (crop) {
    // 调用方已指定裁剪区域时直接按指定区域裁切。
    cx.drawImage(img, crop.sx, crop.sy, crop.sSize, crop.sSize, 0, 0, size, size);
  } else {
    // 未指定裁剪时取中心最大正方形区域。
    var s = Math.min(iw, ih);
    cx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, size, size);
  }
  return cv;
}

// 应用宿主直接传入的 dataURL 封面。
function applyCoverDataUrl(dataUrl, opts) {
  // 宿主可能直接推送内联封面，dataUrl 路径不需要代理，但仍必须走同一套 token 校验和 canvas 处理。
  opts = opts || {};
  if (!dataUrl) return;
  // dataURL 图片对象。
  var img = new Image();
  img.decoding = 'async';
  img.onload = function() {
    // 解码完成后防串。
    if (!coverApplyStillCurrent(opts)) return;
    // 按当前封面分辨率生成方形 canvas。
    var cv = makeSquareCoverCanvas(img, coverTextureSizeForResolution(fx.coverResolution));
    // dataURL 可直接用于背景层。
    setAlbumBackground(dataUrl);
    // 进入统一封面应用链路，并记录来源为 data。
    applyCoverCanvas(cv, dataUrl, Object.assign({}, opts, { coverSourceKind: 'data', coverSource: dataUrl }));
  };
  // 启动 dataURL 解码。
  img.src = dataUrl;
}


