// ===== js/09-account-ui.js =====

// ============================================================
//  模态动画工具
// ============================================================
// 使用 GSAP 打开模态遮罩。
function openGsapModal(mask) {
  if (!mask) return;
  // 模态内容面板。
  var panel = mask.querySelector('.modal');
  mask.classList.add('show');
  if (window.gsap) {
    // 遮罩和面板分别播放淡入与上浮动画。
    window.gsap.killTweensOf(mask);
    if (panel) window.gsap.killTweensOf(panel);
    window.gsap.set(mask, { display: 'flex', visibility: 'visible' });
    window.gsap.fromTo(mask,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.38, ease: 'power2.out', overwrite: true }
    );
    if (panel) {
      window.gsap.fromTo(panel,
        { autoAlpha: 0, y: 26, scale: 0.965, filter: 'blur(12px)' },
        { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.68, ease: 'expo.out', overwrite: true }
      );
    }
  } else {
    // 无 GSAP 时直接显示。
    mask.style.display = 'flex';
    mask.style.visibility = 'visible';
    mask.style.opacity = '1';
  }
}
// 使用 GSAP 关闭模态遮罩。
function closeGsapModal(mask, afterClose) {
  if (!mask || !mask.classList.contains('show')) {
    if (afterClose) afterClose();
    return;
  }
  // 模态内容面板。
  var panel = mask.querySelector('.modal');
  // 关闭完成后的收尾。
  function finish() {
    mask.classList.remove('show');
    if (window.gsap) {
      window.gsap.set(mask, { clearProps: 'display,visibility,opacity' });
      if (panel) window.gsap.set(panel, { clearProps: 'opacity,visibility,transform,filter' });
    } else {
      mask.style.display = '';
      mask.style.visibility = '';
      mask.style.opacity = '';
    }
    if (afterClose) afterClose();
  }
  if (window.gsap) {
    // 面板先淡出下沉，遮罩随后整体淡出。
    window.gsap.killTweensOf(mask);
    if (panel) {
      window.gsap.killTweensOf(panel);
      window.gsap.to(panel, { autoAlpha: 0, y: 18, scale: 0.976, filter: 'blur(8px)', duration: 0.28, ease: 'power2.in', overwrite: true });
    }
    window.gsap.to(mask, { autoAlpha: 0, duration: 0.34, ease: 'power2.inOut', overwrite: true, onComplete: finish });
  } else {
    finish();
  }
}
// 绑定模态遮罩点击背景关闭逻辑。
function bindModalBackdropClose() {
  [
  ].forEach(function(pair){
    // 遮罩节点。
    var mask = document.getElementById(pair[0]);
    // 关闭函数。
    var close = pair[1];
    if (!mask || mask.__backdropCloseBound) return;
    mask.__backdropCloseBound = true;
    mask.addEventListener('click', function(e){
      if (e.target === mask) close();
    });
  });
}

// ============================================================
//  空场待机引导
// ============================================================
// 待机引导 canvas。
var idleGuideCanvas = null;
// 待机引导 canvas 绘制上下文。
var idleGuideCtx = null;
// 待机引导画布宽高和 DPR。
var idleGuideW = 0, idleGuideH = 0, idleGuideDpr = 1;
// 待机引导粒子列表。
var idleGuideParticles = [];
// 待机引导拖尾轨迹。
var idleGuideTrails = [[], [], [], []];
// 待机引导启动时间。
var idleGuideStartedAt = performance.now();
// 待机引导是否可见。
var idleGuideVisible = false;
// 待机引导上一帧时间。
var idleGuideLastFrameAt = performance.now();
// 待机引导延迟显示定时器。
var idleGuideDelayTimer = null;
// Keep Wallpaper as the only startup idle background.
// 是否启用待机引导背景；当前关闭，仅保留壁纸启动背景。
var IDLE_GUIDE_BACKGROUND_ENABLED = false;
// 待机引导交互状态。
var idleGuideInteraction = {
  // 绕中心旋转角。
  angle: 0,
  // 当前旋转速度。
  velocity: 0,
  // X 轴旋转。
  rotX: -0.12,
  // Y 轴旋转。
  rotY: 0,
  // X 轴惯性旋转速度。
  spinX: 0,
  // Y 轴惯性旋转速度。
  spinY: 0,
  // 当前缩放。
  zoom: 1,
  // 目标缩放。
  zoomTarget: 1,
  // 缩放脉冲。
  zoomPulse: 0,
  // 是否正在拖拽。
  dragging: false,
  // 上一次指针 X。
  lastX: 0,
  // 上一次指针 Y。
  lastY: 0,
  // 上一次指针时间。
  lastT: 0,
  // 指针归一化 X。
  pointerX: 0.5,
  // 指针归一化 Y。
  pointerY: 0.5,
  // 指针是否活跃。
  pointerActive: false,
  // 指针聚焦强度。
  focus: 0,
  // 按压强度。
  press: 0,
  // 视差倾斜 X。
  tiltX: 0,
  // 视差倾斜 Y。
  tiltY: 0
};
// 设置待机引导可见状态和交互状态。
function setIdleGuideVisible(show, interactive) {
  document.body.classList.toggle('idle-guide-on', show);
  document.body.classList.toggle('idle-guide-interactive', !!interactive);
  if (!interactive) document.body.classList.remove('idle-guide-dragging');
  if (idleGuideVisible === show) return;
  idleGuideVisible = show;
}
// 判断当前是否应显示待机引导。
function shouldShowIdleGuide() {
  if (!IDLE_GUIDE_BACKGROUND_ENABLED) return false;
  if (immersiveMode) return false;
  if (playing) return false;
  if (document.querySelector('.modal-mask.show')) return false;
  if (uniforms && uniforms.uHasCover && uniforms.uHasCover.value > 0.5) return false;
  return true;
}
// 判断是否应显示歌单架悬停提示。
function shouldShowShelfHoverCue(value) {
  if (document.querySelector('.modal-mask.show')) return false;
  if (shelfPinnedOpen) return false;
  if (!shelfManager || !shelfManager.canInteract || !shelfManager.canInteract()) return false;
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  if (!shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  return shelfHoverCue.target > 0 || (value || shelfHoverCue.value) > 0.015;
}
// 判断指针事件是否应交给待机引导处理。
function shouldHandleIdleGuidePointer(e) {
  if (!idleGuideCanvas || !shouldShowIdleGuide()) return false;
  if (isPointerOverUi(e)) return false;
  return true;
}
// 夹紧待机引导旋转速度。
function clampIdleGuideSpin(v) {
  if (!isFinite(v)) return 0;
  return Math.max(-4.8, Math.min(4.8, v));
}
// 待机引导指针按下处理。
function idleGuidePointerDown(e) {
  if (!shouldHandleIdleGuidePointer(e)) return;
  idleGuideInteraction.dragging = true;
  idleGuideInteraction.pointerActive = true;
  // 记录拖拽起点。
  idleGuideInteraction.lastX = e.clientX;
  idleGuideInteraction.lastY = e.clientY;
  idleGuideInteraction.lastT = performance.now();
  idleGuideInteraction.pointerX = e.clientX / Math.max(1, idleGuideW || innerWidth);
  idleGuideInteraction.pointerY = e.clientY / Math.max(1, idleGuideH || innerHeight);
  document.body.classList.add('idle-guide-dragging');
}
// 待机引导指针移动处理。
function idleGuidePointerMove(e) {
  if (!idleGuideCanvas) return;
  // 非拖拽时也允许指针悬停影响待机引导。
  var canReact = shouldHandleIdleGuidePointer(e) || idleGuideInteraction.dragging;
  idleGuideInteraction.pointerActive = canReact;
  if (canReact) {
    idleGuideInteraction.pointerX = e.clientX / Math.max(1, idleGuideW || innerWidth);
    idleGuideInteraction.pointerY = e.clientY / Math.max(1, idleGuideH || innerHeight);
  }
  if (!idleGuideInteraction.dragging) return;
  // 当前时间。
  var now = performance.now();
  // 帧间隔。
  var dt = Math.max(1 / 120, Math.min(0.08, (now - idleGuideInteraction.lastT) / 1000 || 1 / 60));
  // 指针 X 位移。
  var dx = e.clientX - idleGuideInteraction.lastX;
  // 指针 Y 位移。
  var dy = e.clientY - idleGuideInteraction.lastY;
  // X 轴旋转增量。
  var rx = -dy * 0.0032;
  // Y 轴旋转增量。
  var ry = dx * 0.0034;
  idleGuideInteraction.rotX += rx;
  idleGuideInteraction.rotY += ry;
  idleGuideInteraction.angle += ry * 0.22;
  idleGuideInteraction.spinX = clampIdleGuideSpin(rx / dt * 0.46);
  idleGuideInteraction.spinY = clampIdleGuideSpin(ry / dt * 0.46);
  idleGuideInteraction.velocity = Math.sqrt(idleGuideInteraction.spinX * idleGuideInteraction.spinX + idleGuideInteraction.spinY * idleGuideInteraction.spinY);
  idleGuideInteraction.lastX = e.clientX;
  idleGuideInteraction.lastY = e.clientY;
  idleGuideInteraction.lastT = now;
}
// 待机引导指针抬起处理。
function idleGuidePointerUp() {
  if (!idleGuideInteraction.dragging) return;
  idleGuideInteraction.dragging = false;
  document.body.classList.remove('idle-guide-dragging');
}
// 待机引导指针离开处理。
function idleGuidePointerLeave() {
  if (!idleGuideInteraction.dragging) idleGuideInteraction.pointerActive = false;
}
// 待机引导滚轮缩放处理。
function idleGuideWheel(e) {
  if (!shouldHandleIdleGuidePointer(e)) return false;
  // 交互状态引用。
  var guide = idleGuideInteraction;
  guide.pointerActive = true;
  guide.pointerX = e.clientX / Math.max(1, idleGuideW || innerWidth);
  guide.pointerY = e.clientY / Math.max(1, idleGuideH || innerHeight);
  // 目标缩放采用指数滚轮曲线。
  var nextZoom = guide.zoomTarget * Math.exp(-e.deltaY * 0.0012);
  guide.zoomTarget = Math.max(0.58, Math.min(1.82, nextZoom));
  guide.zoomPulse = Math.min(1, guide.zoomPulse + Math.min(0.28, Math.abs(e.deltaY) * 0.0014));
  return true;
}
// 调整待机引导 canvas 尺寸并重建粒子。
function resizeIdleGuideCanvas() {
  if (!idleGuideCanvas) return;
  // 限制 DPR，避免待机背景占用过高。
  idleGuideDpr = Math.min(window.devicePixelRatio || 1, 1.6);
  idleGuideW = window.innerWidth;
  idleGuideH = window.innerHeight;
  idleGuideCanvas.width = Math.max(1, Math.floor(idleGuideW * idleGuideDpr));
  idleGuideCanvas.height = Math.max(1, Math.floor(idleGuideH * idleGuideDpr));
  idleGuideCanvas.style.width = idleGuideW + 'px';
  idleGuideCanvas.style.height = idleGuideH + 'px';
  idleGuideCtx.setTransform(idleGuideDpr, 0, 0, idleGuideDpr, 0, 0);
  idleGuideParticles = [];
  resetIdleGuideTrails();
  if (!IDLE_GUIDE_BACKGROUND_ENABLED) return;
  // 视口短边。
  var minDim = Math.min(idleGuideW, idleGuideH);
  // 视口长边。
  var maxDim = Math.max(idleGuideW, idleGuideH);
  // 粒子数量。
  var count = idleGuideW < 800 ? 150 : 240;
  for (var i = 0; i < count; i++) {
    // 多数粒子分布在环形区域，少数作为远处漂浮层。
    var ring = i < count * 0.76;
    // 初始角度。
    var a = Math.random() * Math.PI * 2;
    // 半径。
    var r = ring
      ? (minDim * 0.035 + Math.pow(Math.random(), 0.58) * minDim * 0.335)
      : (Math.pow(Math.random(), 0.82) * maxDim * 0.58);
    // 摆动幅度。
    var wobbleAmp = minDim * (ring ? (0.012 + Math.random() * 0.035) : (0.010 + Math.random() * 0.055));
    idleGuideParticles.push({
      a: a,
      r: r,
      cx: ring ? 0.5 : Math.random(),
      cy: ring ? 0.5 : Math.random(),
      size: ring ? (0.30 + Math.random() * 0.62) : (0.18 + Math.random() * 0.44),
      speed: ((ring ? 0.018 : 0.010) + Math.random() * (ring ? 0.045 : 0.030)) * (Math.random() < 0.5 ? -1 : 1),
      phase: Math.random() * Math.PI * 2,
      wobbleAmp: wobbleAmp,
      wobbleSpeed: 0.18 + Math.random() * 0.76,
      oval: 0.56 + Math.random() * 0.36,
      zAmp: 0.34 + Math.random() * 0.82,
      driftX: (Math.random() * 2 - 1) * wobbleAmp * 0.75,
      driftY: (Math.random() * 2 - 1) * wobbleAmp * 0.75,
      layer: Math.random(),
      z: (Math.random() * 2 - 1) * (ring ? minDim * 0.28 : maxDim * 0.42),
      ring: ring
    });
  }
}
// 将待机引导 3D 点投影到 2D 屏幕。
function projectIdleGuidePoint(x, y, z, rot, cx, cy, depth) {
  // 绕 Y 轴旋转后的 X。
  var x1 = x * rot.cy + z * rot.sy;
  // 绕 Y 轴旋转后的 Z。
  var z1 = -x * rot.sy + z * rot.cy;
  // 绕 X 轴旋转后的 Y。
  var y1 = y * rot.cx - z1 * rot.sx;
  // 绕 X 轴旋转后的 Z。
  var z2 = y * rot.sx + z1 * rot.cx;
  // 透视缩放。
  var scale = depth / (depth - z2 * 0.72);
  scale = Math.max(0.52, Math.min(1.74, scale));
  return {
    x: cx + x1 * scale,
    y: cy + y1 * scale,
    z: z2,
    scale: scale
  };
}
// 重置待机引导拖尾数组。
function resetIdleGuideTrails() {
  idleGuideTrails = [[], [], [], []];
}
// 向指定待机引导拖尾写入一个点。
function pushIdleGuideTrail(index, pt, alpha, now) {
  // 目标拖尾数组。
  var trail = idleGuideTrails[index];
  if (!trail) trail = idleGuideTrails[index] = [];
  // 上一个拖尾点。
  var last = trail[trail.length - 1];
  // 与上一个点的 X 距离。
  var dx = last ? pt.x - last.x : 999;
  // 与上一个点的 Y 距离。
  var dy = last ? pt.y - last.y : 999;
  if (!last || Math.sqrt(dx * dx + dy * dy) > 1.4 || now - last.t > 42) {
    // 点间距或时间超过阈值时写入新拖尾点。
    trail.push({ x: pt.x, y: pt.y, scale: pt.scale || 1, alpha: alpha || 1, t: now });
  }
  // 限制单条拖尾长度。
  while (trail.length > 26) trail.shift();
}
// 绘制一条待机引导拖尾。
function drawIdleGuideTrail(ctx, trail, now, alpha, energy) {
  if (!trail || trail.length < 2) return;
  // 移除过旧的拖尾点。
  while (trail.length && now - trail[0].t > 680) trail.shift();
  if (trail.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (var i = 1; i < trail.length; i++) {
    // 上一个拖尾点。
    var prev = trail[i - 1];
    // 当前拖尾点。
    var cur = trail[i];
    // 当前点生命周期进度。
    var age = (now - cur.t) / 680;
    // 当前点在拖尾序列中的顺序权重。
    var order = i / Math.max(1, trail.length - 1);
    // 叠加年龄和顺序后的透明度。
    var fade = Math.max(0, 1 - age) * order;
    if (fade <= 0) continue;
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * fade * (0.18 + energy * 0.24)).toFixed(3) + ')';
    ctx.lineWidth = (0.7 + cur.scale * 0.9 + energy * 1.2) * fade;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    // 二次贝塞尔中点。
    var mx = (prev.x + cur.x) * 0.5;
    // 二次贝塞尔中点 Y。
    var my = (prev.y + cur.y) * 0.5;
    ctx.quadraticCurveTo(mx, my, cur.x, cur.y);
    ctx.stroke();
  }
  ctx.restore();
}
// 调度下一帧待机引导绘制。
function scheduleIdleGuideFrame(delay) {
  if (idleGuideDelayTimer) {
    clearTimeout(idleGuideDelayTimer);
    idleGuideDelayTimer = null;
  }
  if (delay && delay > 0) {
    // 不需要高频刷新时延迟下一帧，降低待机成本。
    idleGuideDelayTimer = setTimeout(function(){
      idleGuideDelayTimer = null;
      requestAnimationFrame(drawIdleGuideFrame);
    }, delay);
  } else {
    requestAnimationFrame(drawIdleGuideFrame);
  }
}
// 绘制待机引导和歌单架边缘提示。
function drawIdleGuideFrame() {
  if (!idleGuideCanvas || !idleGuideCtx) return;
  // 画布上下文。
  var ctx = idleGuideCtx;
  // 当前帧时间。
  var nowFrame = performance.now();
  // 帧间隔秒数。
  var dtFrame = Math.max(1 / 120, Math.min(0.05, (nowFrame - idleGuideLastFrameAt) / 1000 || 1 / 60));
  idleGuideLastFrameAt = nowFrame;
  // 是否显示待机背景。
  var idleShow = shouldShowIdleGuide();
  // 歌单架悬停提示强度。
  var shelfCueValue = tickShelfHoverCue(dtFrame);
  // 是否显示歌单架提示。
  var shelfCueShow = shouldShowShelfHoverCue(shelfCueValue);
  // 本帧是否需要显示任何待机画面。
  var show = idleShow || shelfCueShow;
  setIdleGuideVisible(show, idleShow);
  if (!show) {
    // 完全隐藏时清空画布并低频轮询。
    idleGuideCtx.clearRect(0, 0, idleGuideW, idleGuideH);
    resetIdleGuideTrails();
    scheduleIdleGuideFrame(140);
    return;
  }
  // 待机引导运行秒数。
  var t = (nowFrame - idleGuideStartedAt) / 1000;
  if (!idleShow) {
    // 不显示待机背景时，仅绘制歌单架提示。
    ctx.clearRect(0, 0, idleGuideW, idleGuideH);
    resetIdleGuideTrails();
    ctx.globalCompositeOperation = 'lighter';
    drawShelfGuideCue(ctx, t, shelfCueValue);
    ctx.globalCompositeOperation = 'source-over';
    scheduleIdleGuideFrame(0);
    return;
  }
  // 画布中心 X。
  var cx = idleGuideW * 0.5;
  // 画布中心 Y。
  var cy = idleGuideH * 0.50;
  // 交互状态引用。
  var guide = idleGuideInteraction;
  if (!guide.dragging) {
    // 非拖拽状态下应用惯性旋转和阻尼。
    guide.rotX += guide.spinX * dtFrame;
    guide.rotY += guide.spinY * dtFrame;
    guide.spinX *= Math.pow(0.90, dtFrame * 60);
    guide.spinY *= Math.pow(0.90, dtFrame * 60);
    if (Math.abs(guide.spinX) < 0.01) guide.spinX = 0;
    if (Math.abs(guide.spinY) < 0.01) guide.spinY = 0;
  }
  guide.rotY += 0.012 * dtFrame;
  guide.angle += guide.spinY * dtFrame * 0.20 + 0.010 * dtFrame;
  guide.velocity = Math.sqrt(guide.spinX * guide.spinX + guide.spinY * guide.spinY);
  // 指针目标聚焦值。
  var targetFocus = guide.pointerActive ? 1 : 0;
  // 拖拽目标按压值。
  var targetPress = guide.dragging ? 1 : 0;
  guide.focus += (targetFocus - guide.focus) * 0.10;
  guide.press += (targetPress - guide.press) * 0.16;
  guide.zoom += (guide.zoomTarget - guide.zoom) * 0.13;
  guide.zoomPulse *= Math.pow(0.84, dtFrame * 60);
  if (guide.zoomPulse < 0.002) guide.zoomPulse = 0;
  guide.tiltX += (((guide.pointerX - 0.5) * 0.26) - guide.tiltX) * 0.08;
  guide.tiltY += (((guide.pointerY - 0.5) * 0.18) - guide.tiltY) * 0.08;
  ctx.clearRect(0, 0, idleGuideW, idleGuideH);
  ctx.globalCompositeOperation = 'lighter';

  // 呼吸动画强度。
  var breathe = 0.5 + 0.5 * Math.sin(t * 0.72);
  // 当前缩放。
  var zoom = guide.zoom;
  // 滚轮缩放脉冲。
  var zoomBoost = guide.zoomPulse;
  // 背景中心光晕。
  var halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(idleGuideW, idleGuideH) * ((0.36 + breathe * 0.035 + guide.press * 0.018) * zoom));
  halo.addColorStop(0, 'rgba(255,255,255,' + (0.034 + breathe * 0.020 + guide.focus * 0.014 + guide.press * 0.018 + zoomBoost * 0.018).toFixed(3) + ')');
  halo.addColorStop(0.44, 'rgba(255,255,255,' + (0.014 + guide.focus * 0.010).toFixed(3) + ')');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, idleGuideW, idleGuideH);

  // 环形粒子投影点列表，后续用于连线。
  var ringPts = [];
  // 指针屏幕 X。
  var pointerX = guide.pointerX * idleGuideW;
  // 指针屏幕 Y。
  var pointerY = guide.pointerY * idleGuideH;
  // 拖拽/惯性带来的能量。
  var spinEnergy = Math.min(1, guide.velocity / 1.5 + guide.press * 0.42);
  // 当前旋转三角函数缓存。
  var rot = {
    sx: Math.sin(guide.rotX),
    cx: Math.cos(guide.rotX),
    sy: Math.sin(guide.rotY),
    cy: Math.cos(guide.rotY)
  };
  // 透视深度基准。
  var depth = Math.max(520, Math.min(idleGuideW, idleGuideH) * 0.92);
  for (var i = 0; i < idleGuideParticles.length; i++) {
    // 当前粒子。
    var p = idleGuideParticles[i];
    // 粒子当前角度。
    var localA = p.a + t * p.speed;
    // 粒子摆动相位。
    var wanderA = p.phase + t * p.wobbleSpeed;
    // 粒子摆动位移。
    var wobble = Math.sin(wanderA) * p.wobbleAmp + Math.sin(t * (p.wobbleSpeed * 0.57 + 0.11) + p.phase * 1.7) * p.wobbleAmp * 0.45;
    // 粒子屏幕 X/Y。
    var x, y;
    // 3D 投影结果。
    var projected = null;
    // 点大小缩放。
    var pointScale = 1;
    if (p.ring) {
      // 环形粒子在 3D 环上运动。
      var rr = (p.r + wobble + breathe * 12) * zoom * (1 + guide.press * 0.030 + zoomBoost * 0.018);
      var baseX = Math.cos(localA) * rr + Math.sin(wanderA * 0.73) * p.wobbleAmp * 0.54 + p.driftX;
      var baseY = Math.sin(localA + Math.sin(wanderA) * 0.10) * rr * p.oval + Math.sin(t * 0.33 + p.phase) * p.wobbleAmp * 0.68 + p.driftY;
      var baseZ = (Math.sin(localA * 0.84 + p.phase * 0.31) * rr * p.zAmp + p.z * 0.54 + Math.cos(wanderA * 0.91) * p.wobbleAmp) * zoom;
      projected = projectIdleGuidePoint(baseX, baseY, baseZ, rot, cx, cy, depth);
      pointScale = projected.scale;
      x = projected.x + guide.tiltX * projected.z * 0.020;
      y = projected.y + guide.tiltY * projected.z * 0.018;
      var nDx = pointerX - x, nDy = pointerY - y;
      var near = guide.focus * Math.max(0, 1 - Math.sqrt(nDx * nDx + nDy * nDy) / 210);
      x += nDx * near * 0.040;
      y += nDy * near * 0.040;
      ringPts.push({ x:x, y:y, z:projected.z, scale:projected.scale, alpha:0.08 + breathe * 0.04 + near * 0.08 });
    } else {
      // 远场粒子在更大的空间里漂移。
      var driftX = ((p.cx - 0.5) * idleGuideW * 0.92 + Math.cos(localA) * (12 + p.wobbleAmp * 0.28) + wobble * 0.28) * zoom;
      var driftY = ((p.cy - 0.5) * idleGuideH * 0.72 + Math.sin(localA * 0.8 + p.phase * 0.2) * (12 + p.wobbleAmp * 0.24)) * zoom;
      var driftZ = (p.z + Math.sin(localA + p.phase) * (32 + p.wobbleAmp * 0.32)) * zoom;
      var fieldPt = projectIdleGuidePoint(driftX, driftY, driftZ, rot, cx, cy, depth * 1.16);
      pointScale = fieldPt.scale;
      x = fieldPt.x;
      y = fieldPt.y;
    }
    // 深度影响光点透明度。
    var depthGlow = p.ring && projected ? (0.66 + projected.scale * 0.20) : 1;
    // 粒子透明度。
    var aP = p.ring ? ((0.070 + breathe * 0.065 + Math.sin(t * (0.8 + p.layer) + p.phase) * 0.024 + spinEnergy * 0.032) * depthGlow) : (0.034 + guide.focus * 0.010);
    ctx.beginPath();
    ctx.arc(x, y, p.size * pointScale * Math.sqrt(zoom) * (1 + spinEnergy * (p.ring ? 0.24 : 0.08) + zoomBoost * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + Math.max(0, aP).toFixed(3) + ')';
    ctx.fill();
  }

  ctx.lineWidth = 1;
  for (var j = 0; j < ringPts.length; j += 3) {
    // 连线起点。
    var aPt = ringPts[j];
    // 连线终点。
    var bPt = ringPts[(j + 7) % ringPts.length];
    if (!aPt || !bPt) continue;
    // 点间距离。
    var dx = aPt.x - bPt.x, dy = aPt.y - bPt.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > Math.min(idleGuideW, idleGuideH) * 0.17) continue;
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.018 + breathe * 0.020 + guide.focus * 0.012 + spinEnergy * 0.018).toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(aPt.x, aPt.y);
    ctx.lineTo(bPt.x, bPt.y);
    ctx.stroke();
  }

  if (guide.focus > 0.03 || spinEnergy > 0.05) {
    // 交互锚点轨道半径。
    var orbitR = Math.min(idleGuideW, idleGuideH) * (0.305 + guide.press * 0.018) * zoom;
    // 锚点透明度。
    var anchorAlpha = Math.min(0.68, 0.16 + guide.focus * 0.24 + spinEnergy * 0.38);
    for (var k = 0; k < 4; k++) {
      // 锚点角度。
      var anchorA = guide.angle + t * 0.08 + k * 1.72 + (k === 2 ? 0.38 : 0);
      // 锚点投影位置。
      var anchorPt = projectIdleGuidePoint(
        Math.cos(anchorA) * orbitR,
        Math.sin(anchorA) * orbitR * 0.52,
        Math.sin(anchorA + k * 0.54) * orbitR * 0.48,
        rot, cx, cy, depth
      );
      pushIdleGuideTrail(k, anchorPt, anchorAlpha, nowFrame);
      drawIdleGuideTrail(ctx, idleGuideTrails[k], nowFrame, anchorAlpha, spinEnergy);
      ctx.beginPath();
      ctx.arc(anchorPt.x, anchorPt.y, (2.0 + spinEnergy * 1.8 + (k === 0 ? guide.press * 1.8 : 0)) * anchorPt.scale, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + anchorAlpha.toFixed(3) + ')';
      ctx.fill();
    }
  }

  if (guide.focus > 0.03) {
    // 指针交互手柄角度。
    var handleA = guide.angle + t * 0.36;
    // 指针交互手柄半径。
    var handleR = Math.min(idleGuideW, idleGuideH) * (0.315 + breathe * 0.012 + guide.press * 0.012) * zoom;
    // 手柄投影位置。
    var handlePt = projectIdleGuidePoint(
      Math.cos(handleA) * handleR,
      Math.sin(handleA) * handleR * 0.52,
      Math.sin(handleA + 0.62) * handleR * 0.48,
      rot, cx, cy, depth
    );
    // 手柄屏幕 X。
    var hx = handlePt.x;
    // 手柄屏幕 Y。
    var hy = handlePt.y;
    // 手柄光晕。
    var handleGlow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 28 + guide.press * 12);
    handleGlow.addColorStop(0, 'rgba(255,255,255,' + (0.22 * guide.focus + 0.16 * guide.press).toFixed(3) + ')');
    handleGlow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = handleGlow;
    ctx.beginPath();
    ctx.arc(hx, hy, 28 + guide.press * 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 2.4 + guide.press * 1.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.54 * guide.focus + 0.24 * guide.press).toFixed(3) + ')';
    ctx.fill();
  }

  // 有歌单架提示时叠加边缘提示。
  if (shelfCueShow) drawShelfGuideCue(ctx, t, shelfCueValue);
  ctx.globalCompositeOperation = 'source-over';
  scheduleIdleGuideFrame(0);
}
// 绘制圆角矩形路径，兼容不支持 roundRect 的环境。
function idleRoundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  // 限制圆角半径不超过宽高一半。
  r = Math.min(r || 0, Math.abs(w) * 0.5, Math.abs(h) * 0.5);
  // 右下角坐标。
  var x2 = x + w, y2 = y + h;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x2 - r, y);
  ctx.quadraticCurveTo(x2, y, x2, y + r);
  ctx.lineTo(x2, y2 - r);
  ctx.quadraticCurveTo(x2, y2, x2 - r, y2);
  ctx.lineTo(x + r, y2);
  ctx.quadraticCurveTo(x, y2, x, y2 - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}
// 绘制歌单架侧边悬停提示。
function drawShelfGuideCue(ctx, t, strength) {
  strength = Math.max(0, Math.min(1, strength == null ? shelfHoverCue.value : strength));
  if (strength <= 0.01) return;
  // 提示热区矩形。
  var r = shelfCueRect();
  // 提示中心点。
  var c = shelfCueCenter();
  // 呼吸脉冲。
  var pulse = 0.5 + 0.5 * Math.sin(t * 1.55);
  // 提示整体上下浮动。
  var floatY = Math.sin(t * 0.92) * 8 * strength;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // 右侧边缘线性辉光。
  var glow = ctx.createLinearGradient(r.left, 0, r.right, 0);
  glow.addColorStop(0, 'rgba(255,255,255,0)');
  glow.addColorStop(0.58, 'rgba(255,255,255,' + (0.010 * strength).toFixed(3) + ')');
  glow.addColorStop(0.82, 'rgba(244,210,138,' + (0.024 * strength + pulse * 0.012 * strength).toFixed(3) + ')');
  glow.addColorStop(1, 'rgba(255,255,255,' + (0.035 * strength).toFixed(3) + ')');
  ctx.fillStyle = glow;
  ctx.fillRect(r.left, r.top - 26, r.width + 18, r.height + 52);

  // 提示中心径向光晕。
  var halo = ctx.createRadialGradient(c.x + r.width * 0.18, c.y + floatY, 0, c.x + r.width * 0.18, c.y + floatY, r.width * 0.62);
  halo.addColorStop(0, 'rgba(244,210,138,' + (0.070 * strength + pulse * 0.026 * strength).toFixed(3) + ')');
  halo.addColorStop(0.45, 'rgba(255,255,255,' + (0.020 * strength).toFixed(3) + ')');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(r.left, r.top - 40, r.width, r.height + 80);

  for (var i = 0; i < 10; i++) {
    // 粒子随机种子。
    var seed = i * 19.17;
    // 粒子闪烁相位。
    var phase = (t * (0.10 + (i % 4) * 0.014) + i * 0.113) % 1;
    // 粒子 X 坐标。
    var x = r.left + r.width * (0.45 + (i % 4) * 0.13) + Math.sin(t * 0.44 + seed) * 12;
    // 粒子 Y 坐标。
    var y = r.top + r.height * (0.18 + ((i * 0.137 + Math.sin(seed)) % 0.64)) + floatY * (0.42 + (i % 3) * 0.10);
    // 粒子透明度。
    var alpha = (0.035 + Math.sin(Math.PI * phase) * 0.050) * strength;
    if (alpha <= 0) continue;
    ctx.beginPath();
    ctx.arc(x, y, 0.9 + (i % 3) * 0.26 + pulse * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(244,210,138,' + alpha.toFixed(3) + ')';
    ctx.fill();
  }
  ctx.restore();
}
// 初始化待机引导 canvas 和绘制循环。
function initIdleGuideCanvas() {
  idleGuideCanvas = document.getElementById('idle-guide-canvas');
  if (!idleGuideCanvas) return;
  idleGuideCtx = idleGuideCanvas.getContext('2d');
  if (!idleGuideCtx) return;
  idleGuideStartedAt = performance.now();
  resizeIdleGuideCanvas();
  window.addEventListener('resize', resizeIdleGuideCanvas);
  drawIdleGuideFrame();
}

// ============================================================
//  toast
// ============================================================
// toast 自动关闭定时器。
var toastTimer = null;
// 显示底部 toast 提示。
function showToast(msg) {
  // toast 节点。
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2600);
}
