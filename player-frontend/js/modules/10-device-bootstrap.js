// ===== js/10-device-bootstrap.js =====

// ============================================================
//  粒子鼠标拖拽旋转
// ============================================================
// 物理旋转: 给粒子一个角速度, 每帧衰减
var particleSpin = { vx: 0, vy: 0, damping: 0.90 };
// 鼠标拖拽驱动的总旋转累计角度
var particleRotation = { x: 0, y: 0 };
// 指针 Y 位移转 X 轴旋转的系数。
var PARTICLE_POINTER_SPIN_X = 0.0032;
// 指针 X 位移转 Y 轴旋转的系数。
var PARTICLE_POINTER_SPIN_Y = 0.0034;
// 粒子惯性旋转最大角速度。
var PARTICLE_SPIN_MAX = 6.2;

// 夹紧粒子惯性旋转速度。
function clampParticleSpinVelocity(v) {
  if (!isFinite(v)) return 0;
  return Math.max(-PARTICLE_SPIN_MAX, Math.min(PARTICLE_SPIN_MAX, v));
}

// 将一次拖拽位移应用到粒子旋转目标和惯性速度。
function applyParticleSpinDrag(dx, dy, dt) {
  // X 轴旋转增量。
  var rx = dy * PARTICLE_POINTER_SPIN_X;
  // Y 轴旋转增量。
  var ry = dx * PARTICLE_POINTER_SPIN_Y;
  particleRotation.x += rx;
  particleRotation.y += ry;
  if (dt > 0) {
    // 根据时间差换算惯性角速度。
    particleSpin.vx = clampParticleSpinVelocity(rx / dt * 0.46);
    particleSpin.vy = clampParticleSpinVelocity(ry / dt * 0.46);
  }
}

function resetParticleRotationTarget(syncVisual) {
  // 恢复粒子旋转目标时同步清零惯性速度；必要时也把所有可视层的当前旋转立即对齐。
  particleRotation.x = 0;
  particleRotation.y = 0;
  particleSpin.vx = 0;
  particleSpin.vy = 0;
  if (syncVisual && particles) {
    particles.rotation.set(0, 0, 0);
    if (bloomParticles) bloomParticles.rotation.set(0, 0, 0);
    if (floatGroup) floatGroup.rotation.set(0, 0, 0);
    if (backCoverGroup) backCoverGroup.rotation.set(0, 0, 0);
  }
}

function rebaseParticleRotationAxis(axis) {
  // 长时间拖拽或惯性旋转会让角度持续增长，定期按 2π 回基，避免浮点误差影响插值和射线命中。
  var limit = Math.PI * 10;
  if (Math.abs(particleRotation[axis]) < limit) return;
  var offset = Math.round(particleRotation[axis] / (Math.PI * 2)) * Math.PI * 2;
  particleRotation[axis] -= offset;
  if (particles) particles.rotation[axis] -= offset;
  if (bloomParticles) bloomParticles.rotation[axis] -= offset;
  if (floatGroup) floatGroup.rotation[axis] -= offset;
  if (backCoverGroup) backCoverGroup.rotation[axis] -= offset;
  if (skullParticleGroup) skullParticleGroup.rotation[axis] -= offset;
  if (stageLyrics.group) stageLyrics.group.rotation[axis] -= offset;
}

function rebaseParticleRotationIfNeeded() {
  rebaseParticleRotationAxis('x');
  rebaseParticleRotationAxis('y');
}

// 每帧推进粒子拖拽惯性。
function tickParticleSpin(dt) {
  // 松手后的粒子惯性在这里按帧衰减，粒子、辉光层、浮空层和背面封面层会在主循环里同步到同一旋转。
  if (Math.abs(particleSpin.vx) > 0.0001 || Math.abs(particleSpin.vy) > 0.0001) {
    // 本帧 X 轴旋转增量。
    var rx = particleSpin.vx * dt;
    // 本帧 Y 轴旋转增量。
    var ry = particleSpin.vy * dt;
    particleRotation.x += rx;
    particleRotation.y += ry;
    rebaseParticleRotationIfNeeded();
  }
  particleSpin.vx *= Math.pow(particleSpin.damping, dt * 60);
  particleSpin.vy *= Math.pow(particleSpin.damping, dt * 60);
  if (Math.abs(particleSpin.vx) < 0.01) particleSpin.vx = 0;
  if (Math.abs(particleSpin.vy) < 0.01) particleSpin.vy = 0;
}


// ============================================================
//  Resize / 快捷键
// ============================================================
// 刷新主渲染器视口和相机投影。
function refreshMainRendererViewport(reason) {
  // 视口刷新只处理主相机和渲染功耗；歌词相机在全屏下额外请求多帧校准以避开宿主窗口尺寸抖动。
  if (typeof camera !== 'undefined' && camera) {
    camera.aspect = Math.max(1, innerWidth) / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
  }
  applyRendererPowerMode();
  if (typeof requestStageLyricCameraSnap === 'function' && desktopRuntimeState.fullscreen) {
    requestStageLyricCameraSnap(reason === 'resize' ? 4 : 10);
  }
}
// 排队多次刷新主渲染视口，用于覆盖宿主窗口动画和 DPI 延迟。
function scheduleMainRendererViewportRefresh(reason) {
  // resize 后连续排几次刷新，覆盖桌面宿主窗口动画、DPI 变化和 iframe 尺寸延迟更新。
  refreshMainRendererViewport(reason || 'sync');
  [48, 140, 320].forEach(function(delay){
    setTimeout(function(){ refreshMainRendererViewport(reason || 'sync'); }, delay);
  });
}
// 浏览器窗口尺寸变化时刷新渲染视口。
window.addEventListener('resize', function(){
  scheduleMainRendererViewportRefresh('resize');
});
// 全局播放快捷键。
document.addEventListener('keydown', function(e){
  if (isTypingTarget(e.target)) return;
  if (e.code === 'Space') {
    // 空格切换播放；自由相机使用空格时不触发播放。
    if (freeCamera && freeCamera.active) { e.preventDefault(); return; }
    e.preventDefault(); togglePlay();
  }
  else if (e.code === 'ArrowUp') { e.preventDefault(); adjustVolumeByKeyboard(0.05); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); adjustVolumeByKeyboard(-0.05); }
  else if (e.code === 'ArrowRight') nextTrack();
  else if (e.code === 'ArrowLeft')  prevTrack();
  else if (e.code === 'Escape')     {
    if (wallpaperRuntimeMode) {
      e.preventDefault();
      forceWallpaperImmersiveLock();
      return;
    }
    if (immersiveMode) {
      e.preventDefault();
      setImmersiveMode(false);
      return;
    }
    if (miniQueueOpen) { closeMiniQueue(); return; }
    if (shelfManager && shelfManager.hasOpenContent()) { safeShelfCloseContent('escape-key'); return; }
  }
  else if (e.code === 'KeyL') { if (!immersiveMode) toggleLyricsPanel(); }
  else if (e.code === 'KeyI') toggleImmersiveMode();
  else if (e.code === 'KeyF') toggleFullscreen();
});

// ============================================================
//  UI 半隐藏 v8 — 面板触发/隐藏体验统一
// ============================================================
// 半隐藏面板离开后的隐藏延迟。
var PEEK_HIDE_DELAY = 170;
// 控制台 peek 隐藏定时器。
var peekTimers = { fx:null };
// 设置面板 peek 半展开状态。
function setPeek(el, on, key) {
  if (!el) return;
  if (on) {
    if (peekTimers[key]) { clearTimeout(peekTimers[key]); peekTimers[key] = null; }
    if (key === 'fx') el.classList.remove('closing');
    el.classList.add('peek');
    if (key === 'fx') {
      // 控制台 peek 时同步悬浮按钮。
      var fabOn = document.getElementById('fx-fab');
      if (fabOn) fabOn.classList.add('active');
    }
  } else {
    // 关闭使用延迟，避免指针跨边界时闪烁。
    if (peekTimers[key]) clearTimeout(peekTimers[key]);
    peekTimers[key] = setTimeout(function(){
      el.classList.remove('peek');
      if (key === 'fx') {
        var fabOff = document.getElementById('fx-fab');
        if (fabOff && !el.classList.contains('show')) fabOff.classList.remove('active');
      }
      peekTimers[key] = null;
    }, PEEK_HIDE_DELAY);
  }
}
// 全局鼠标移动负责歌单架 hover 和焦点区切换。
window.addEventListener('mousemove', function(e){
  // 指针坐标和视口尺寸。
  var ex = e.clientX, ey = e.clientY, H = innerHeight;
  if (immersiveMode) {
    // 沉浸模式下只保留必要面板和焦点交互。
    updateShelfHoverCueFromPointer(e);
    updateShelfCardHoverSelection(e);
    updateControlsAutoHideFromPointer(ex, ey);
    // 歌单架是否可成为焦点。
    var shelfCanFocusImm = !!(shelfManager && shelfManager.canInteract && shelfManager.canInteract());
    // 新焦点区。
    var newFocusImm = null;
    // 侧边歌单架 hover 焦点。
    var shelfHoverFocusImm = !!(shelfCanFocusImm && isSideShelfFocusHit(e));
    if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) newFocusImm = 'shelf-detail';
    else if (shelfHoverFocusImm) newFocusImm = 'shelf-side';
    else if (shelfCanFocusImm && shelfManager.getMode() === 'stage' && ey > H * 0.55) newFocusImm = 'shelf-stage';
    setFocusZone(newFocusImm, false);
    return;
  }
  updateShelfHoverCueFromPointer(e);
  updateShelfCardHoverSelection(e);

  // 歌单架镜头跟拍触发判断。
  // 歌单架是否可成为焦点。
  var shelfCanFocus = !!(shelfManager && shelfManager.canInteract && shelfManager.canInteract());
  if (!shelfCanFocus && !(shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent())) {
    shelfPinnedOpen = false;
  }

  // 新焦点区。
  var newFocus = null;
  // 侧边歌单架 hover 焦点是否活跃。
  var shelfHoverFocus = !!(shelfCanFocus && isSideShelfFocusHit(e));
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    newFocus = 'shelf-detail';
  } else if (shelfHoverFocus) {
    newFocus = 'shelf-side';
  } else if (shelfCanFocus && shelfManager.getMode() === 'stage' && ey > H * 0.55) {
    newFocus = 'shelf-stage';
  }
  setFocusZone(newFocus, false);
});

// 推送壁纸状态到宿主；当前桥接实现为空。
function pushWallpaperState() {}
// 应用壁纸模式状态；当前只做开发锁归一化。
function applyWallpaperModeState() {
  normalizeDevelopmentLockedFxState();
}
// 同步桌面覆盖层状态；当前桥接实现为空。
function syncDesktopOverlayState() {}

// 全屏
// 请求宿主切换全屏。
function toggleFullscreen() {
  sendEchoHostCommand('window-control', { action: 'fullscreen' });
}

// ============================================================
//  启动
// ============================================================
// 绑定视觉控制台。
bindFxPanel();
// 应用保存的歌词色板。
applySavedLyricPaletteState();
// 绑定音量控件。
bindVolumeControls();
// 初始化控制条玻璃效果。
initControlGlassSurface();
// 绑定播放控制按钮动画。
bindPlayerControlAnimations();
scheduleUiWarmTask(function(){
  // 启动后延迟刷新玻璃位移贴图，并预编译当前 Three.js 场景。
  updateControlGlassDisplacementMap();
  try {
    if (renderer && renderer.compile && scene && camera) renderer.compile(scene, camera);
  } catch (e) {}
}, 900);
// 应用控制条自动隐藏偏好。
applyControlsAutoHidePreference();
// 应用壁纸模式初始状态。
applyWallpaperModeState(false);
// 初始化歌单架模式。
setShelfMode(fx.shelf);
// 按保存配置创建可选视觉层。
if (fx.floatLayer) createFloatLayer();
if (fx.particleLyrics) createLyricsParticles();
if (fx.backCover) createBackCoverLayer();
// 初始化待机引导。
initIdleGuideCanvas();
// 启动时渲染迷你队列。
renderMiniQueuePanel();


