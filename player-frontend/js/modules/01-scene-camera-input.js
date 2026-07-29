// ===== js/01-scene-camera-input.js =====

// ============================================================
//  Three.js 场景
// ============================================================
// 主 Three.js 场景，所有粒子、歌词、歌单架和辅助层最终都挂到这里。
var scene = new THREE.Scene();
// 背景保持透明，由 DOM 背景和封面背景层负责呈现。
scene.background = null;
// 主透视相机，默认 45 度视野，后续由轨道相机、电影镜头或自由相机驱动。
var camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
// 前台渲染 DPR 上限，防止高 DPI 屏幕带来过高像素成本。
var RENDER_DPR_CAP = 1.35;
// 前台渲染像素预算，实际 DPR 会按窗口面积动态下调。
var RENDER_PIXEL_BUDGET = 5200000;
// 前台最低 DPR，保证省电时仍保留基本清晰度。
var RENDER_MIN_DPR = 0.72;
// 0 = display vsync. Keep visible playback high-refresh capable instead of capping 120Hz+ screens to 60/72.
// 可见播放时是否跟随显示器 vsync；true 表示不主动限帧。
var RENDER_VISIBLE_VSYNC = true;
// 普通前台目标帧率，0 表示不限制。
var RENDER_ACTIVE_FPS = 0;
// 大视口前台目标帧率，0 表示不限制。
var RENDER_LARGE_FPS = 0;
// 超大视口前台目标帧率，0 表示不限制。
var RENDER_HUGE_FPS = 0;
// 交互期间普通视口目标帧率，0 表示不限制。
var RENDER_INTERACTION_FPS = 0;
// 交互期间大视口目标帧率，0 表示不限制。
var RENDER_INTERACTION_LARGE_FPS = 0;
// 交互期间超大视口目标帧率，0 表示不限制。
var RENDER_INTERACTION_HUGE_FPS = 0;
// 一次交互后保持提帧的时长。
var RENDER_INTERACTION_HOLD_MS = 900;
// 交互提帧截止时间戳。
var renderInteractionBoostUntil = 0;
// 最近一次触发交互提帧的原因，供性能快照诊断。
var renderInteractionReason = '';
// 根据用户选择的质量档位返回 DPR 上限、下限和像素预算。
function renderQualityProfile() {
  // 档位来自视觉控制台，normalizePerformanceQuality 负责兼容非法值。
  var quality = normalizePerformanceQuality(fx && fx.performanceQuality);
  // 省电档位降低 DPR 和像素预算。
  if (quality === 'eco') return { cap: 0.95, min: 0.56, budget: 2400000 };
  // 平衡档位介于省电和高质量之间。
  if (quality === 'balanced') return { cap: 1.12, min: 0.66, budget: 3800000 };
  // 超高档位允许更高 DPR 和像素预算。
  if (quality === 'ultra') return { cap: 1.75, min: 0.85, budget: 7800000 };
  // 默认高质量档位使用全局默认预算。
  return { cap: RENDER_DPR_CAP, min: RENDER_MIN_DPR, budget: RENDER_PIXEL_BUDGET };
}
// 计算当前 renderer 应使用的 DPR。
function getRenderPixelRatio() {
  // 基础 DPR 来自设备像素比。
  var device = window.devicePixelRatio || 1;
  // 深度后台模式强制压低 DPR。
  if (isDeepBackgroundMode()) return Math.min(device, 0.30);
  // 按 CSS 像素面积和预算反推最大 DPR。
  var cssPixels = Math.max(1, innerWidth * innerHeight);
  var quality = renderQualityProfile();
  var budgetCap = Math.sqrt(quality.budget / cssPixels);
  // DPR 同时受质量档位 cap 和像素预算 cap 限制。
  var cap = Math.min(quality.cap, budgetCap);
  return Math.max(quality.min, Math.min(device, cap));
}
// 计算当前理论渲染像素数，用于判断负载档位。
function getRenderPixelLoad() {
  var ratio = getRenderPixelRatio();
  return Math.max(1, innerWidth * innerHeight) * ratio * ratio;
}
// 标记一段用户交互，主循环可以据此临时提高渲染活跃度。
function markRenderInteraction(reason, holdMs) {
  // 后台深度睡眠时不提帧，避免隐藏窗口被交互标记唤醒。
  if (isDeepBackgroundMode()) return;
  var now = performance.now();
  // 多次交互取更晚的截止时间。
  renderInteractionBoostUntil = Math.max(renderInteractionBoostUntil, now + (holdMs || RENDER_INTERACTION_HOLD_MS));
  renderInteractionReason = reason || renderInteractionReason || 'interaction';
  // 立即允许下一帧渲染，避免限帧模式下交互反馈延迟。
  if (typeof renderPerfState !== 'undefined' && renderPerfState) renderPerfState.lastRenderAt = 0;
}
// 判断当前是否仍处于交互提帧窗口。
function isRenderInteractionActive(now) {
  return (now || performance.now()) < renderInteractionBoostUntil;
}
// 根据窗口面积和实际渲染像素量给当前负载分档。
function getRenderLoadTier() {
  // cssPixels 表示布局面积，renderPixels 表示乘上 DPR 后的实际像素量。
  var cssPixels = Math.max(1, innerWidth * innerHeight);
  var renderPixels = (typeof getRenderPixelLoad === 'function') ? getRenderPixelLoad() : cssPixels;
  // 2 表示超大负载，1 表示大负载，0 表示普通负载。
  if (cssPixels >= 7200000 || renderPixels >= 5000000) return 2;
  if (cssPixels >= 3200000 || renderPixels >= 3600000) return 1;
  return 0;
}
// WebGL 渲染器；关闭抗锯齿以减少粒子场景的成本，透明背景用于叠加 DOM 背景层。
var renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
// 清屏颜色透明，避免覆盖 album-bg 等 DOM 背景。
renderer.setClearColor(0x000000, 0);
// 初始 DPR 和尺寸使用当前质量策略，后续 resize/后台状态会重新应用。
renderer.setPixelRatio(getRenderPixelRatio());
renderer.setSize(innerWidth, innerHeight);
// canvas 样式保持全屏透明块元素。
renderer.domElement.style.background = 'transparent';
renderer.domElement.style.display = 'block';
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
// 允许 canvas 接收焦点，便于后续键盘/指针交互。
renderer.domElement.tabIndex = 0;
// 把 WebGL canvas 挂到页面容器。
document.getElementById('canvas-container').appendChild(renderer.domElement);

// ============================================================
//  相机系统 v7.1 — 分离 user offset / cinema offset
//   - userOrbit: 用户拖拽的目标 (永久保留, 不会被电影模式覆盖)
//   - cinemaOffset: 电影模式的微偏移 (始终叠加, 即使用户在拖)
//   - 最终 theta = userOrbit.theta + cinemaOffset.theta
//   - 回正按钮 / 双击屏幕: 让 userOrbit 缓慢归零
// ============================================================
// 轨道相机状态：用户旋转、电影镜头偏移、焦点跟随和发光跟随都汇总在这个对象里。
var orbit = {
  userTheta: 0.0, userPhi: 0.08, userRadius: 6.6,
  cineTheta: 0.0, cinePhi: 0.0, cineRadius: 0.0,
  theta: 0.0, phi: 0.08, radius: 6.6,
  minPhi: -Math.PI*0.45, maxPhi: Math.PI*0.45,
  minRadius: 2.4, maxRadius: 14.0,
  baselineTheta: 0.0, baselinePhi: 0.08, baselineRadius: 6.6,
  rotating: false, last:{x:0,y:0},
  recentering: false,
  centerLocked: false,
  // v8: 镜头跟拍 (hover shelf / queue 时)
  lookAt: new THREE.Vector3(0,0,0),
  focus: {
    active: false,
    type: null,        // 'shelf-side' | 'shelf-stage' | 'queue'
    theta: 0.0, phi: 0.08, radius: 6.6,
    lookAt: new THREE.Vector3(0,0,0),
  },
  glowFollowX: 0,
  glowFollowY: 0,
  glowFollowRoll: 0,
  beatGlow: 0,
};
// 复用的零向量，避免热点路径重复分配。
var ZERO_VEC = new THREE.Vector3(0,0,0);
// 默认相机视野角。
var BASE_FOV = 45;
// 节拍镜头冲击强度。
var camPunch = 0;
// 电影镜头内部时间，用于持续微动。
var cinemaT = 0;
// 创建自由相机默认状态。
function defaultFreeCameraState() {
  return {
    // active 表示当前由自由相机接管主相机。
    active: false,
    // locked 表示保存了自由相机状态但不一定正在激活。
    locked: false,
    position: new THREE.Vector3(0, 0, 6.6),
    yaw: 0,
    pitch: 0,
    roll: 0,
    fov: BASE_FOV,
    velocity: new THREE.Vector3(),
    keys: {},
    resetTween: null
  };
}
// 从本地存储读取自由相机状态，并对位置、角度和 FOV 做范围限制。
function readFreeCameraState() {
  // 先创建默认值，读取失败时直接返回默认状态。
  var state = defaultFreeCameraState();
  try {
    // 存档结构可能来自旧版本，所有字段都逐项保护。
    var raw = (persistedStateSnapshot && persistedStateSnapshot.freeCamera) || {};
    if (raw.position) {
      // 位置限制在合理范围内，避免错误存档把相机丢到不可见区域。
      state.position.set(
        clampRange(Number(raw.position.x) || 0, -80, 80),
        clampRange(Number(raw.position.y) || 0, -80, 80),
        clampRange(Number(raw.position.z) || 6.6, -80, 80)
      );
    }
    state.yaw = clampRange(Number(raw.yaw) || 0, -Math.PI * 8, Math.PI * 8);
    // pitch 限制在接近上下 90 度以内，避免万向节极端状态。
    state.pitch = clampRange(Number(raw.pitch) || 0, -Math.PI * 0.49, Math.PI * 0.49);
    state.roll = clampRange(Number(raw.roll) || 0, -Math.PI, Math.PI);
    state.fov = clampRange(Number(raw.fov) || BASE_FOV, 26, 72);
    // 旧版本可能保存 active，这里只恢复 locked，不在启动时直接进入自由相机。
    state.locked = !!(raw.locked || raw.active);
    state.active = false;
  } catch (e) {}
  return state;
}
// 当前自由相机状态。
var freeCamera = readFreeCameraState();
// 自由相机移动方向临时向量。
var FREE_CAMERA_MOVE = new THREE.Vector3();
// 自由相机目标速度临时向量。
var FREE_CAMERA_TARGET_VEL = new THREE.Vector3();
// 自由相机震动方向临时向量。
var FREE_CAMERA_SHAKE_DIR = new THREE.Vector3();
// 自由相机欧拉角复用对象，使用 YXZ 顺序适配 yaw/pitch/roll。
var FREE_CAMERA_EULER = new THREE.Euler(0, 0, 0, 'YXZ');
// 重置自由相机时用到的 lookAt 矩阵。
var FREE_CAMERA_RESET_MAT = new THREE.Matrix4();
// 重置自由相机时用到的旋转四元数。
var FREE_CAMERA_RESET_QUAT = new THREE.Quaternion();
// 自由相机世界上方向。
var FREE_CAMERA_UP = new THREE.Vector3(0, 1, 0);
// 自由相机指针输入状态。
var freeCameraPointer = { seen: false, x: 0, y: 0 };
// 自由相机延迟保存计时器。
var freeCameraDeferredSaveTimer = 0;
// 保存自由相机状态到宿主数据库状态。
function saveFreeCameraState() {
  // 状态未初始化时无需保存。
  if (!freeCamera) return;
  try {
    // 只保存可序列化的基础字段，Vector3 拆成普通对象。
    saveStatePatch({ freeCamera: {
      locked: !!freeCamera.locked,
      active: !!freeCamera.active,
      position: { x: freeCamera.position.x, y: freeCamera.position.y, z: freeCamera.position.z },
      yaw: freeCamera.yaw,
      pitch: freeCamera.pitch,
      roll: freeCamera.roll,
      fov: freeCamera.fov
    } });
  } catch (e) {}
}
// 延迟保存自由相机状态，避免拖拽或连续按键时频繁写数据库。
function scheduleFreeCameraStateSave(delay) {
  // 已经有等待中的保存任务时不重复排队。
  if (freeCameraDeferredSaveTimer) return;
  freeCameraDeferredSaveTimer = setTimeout(function(){
    freeCameraDeferredSaveTimer = 0;
    saveFreeCameraState();
  }, delay || 720);
}
// 三次缓出曲线，输入会先限制到 0..1。
function easeOutCubic01(t) {
  t = clamp01(t);
  return 1 - Math.pow(1 - t, 3);
}
// 计算从 from 到 to 的最短角度差，处理跨越 -π/π 的情况。
function shortestAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}
// 获取自由相机重置目标位姿，骷髅预设下会对齐骷髅专用相机构图。
function getDefaultFreeCameraResetPose() {
  // 默认位姿与普通轨道相机初始构图一致。
  var pose = {
    position: new THREE.Vector3(0, 0, 6.6),
    yaw: 0,
    pitch: 0,
    roll: 0,
    fov: BASE_FOV
  };
  if (typeof SKULL_PRESET_INDEX !== 'undefined' && fx && fx.preset === SKULL_PRESET_INDEX && typeof setSkullCameraTargetVectors === 'function') {
    // 骷髅预设需要从专用目标点反推出 yaw/pitch/roll。
    var look = new THREE.Vector3();
    var shelfComposition = typeof isSkullShelfCompositionActive === 'function' && isSkullShelfCompositionActive();
    setSkullCameraTargetVectors(pose.position, look, innerHeight > innerWidth * 1.08, shelfComposition, 0);
    FREE_CAMERA_RESET_MAT.lookAt(pose.position, look, FREE_CAMERA_UP);
    FREE_CAMERA_RESET_QUAT.setFromRotationMatrix(FREE_CAMERA_RESET_MAT);
    FREE_CAMERA_EULER.setFromQuaternion(FREE_CAMERA_RESET_QUAT, 'YXZ');
    pose.pitch = FREE_CAMERA_EULER.x;
    pose.yaw = FREE_CAMERA_EULER.y;
    pose.roll = FREE_CAMERA_EULER.z;
  }
  return pose;
}
// 把当前主相机位姿捕获到自由相机状态中。
function captureFreeCameraFromCurrent() {
  // 自由相机状态不存在时先补一个默认状态。
  if (!freeCamera) freeCamera = defaultFreeCameraState();
  // 确保相机世界矩阵是最新的，再读取位置和旋转。
  camera.updateMatrixWorld(true);
  freeCamera.position.copy(camera.position);
  FREE_CAMERA_EULER.setFromQuaternion(camera.quaternion, 'YXZ');
  freeCamera.pitch = FREE_CAMERA_EULER.x;
  freeCamera.yaw = FREE_CAMERA_EULER.y;
  freeCamera.roll = FREE_CAMERA_EULER.z;
  freeCamera.fov = clampRange(camera.fov || BASE_FOV, 26, 72);
}
// 如果自由相机处于激活或锁定状态，把自由相机状态应用到主相机。
function applyFreeCameraToCamera() {
  if (!freeCamera || !(freeCamera.active || freeCamera.locked)) return false;
  // 自由相机仍叠加少量电影震动，避免锁定后画面完全静止。
  var cameraShake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  // 自由相机位置作为基础位置。
  camera.position.copy(freeCamera.position);
  // 使用 YXZ 顺序，保证 yaw/pitch/roll 和保存格式一致。
  camera.rotation.order = 'YXZ';
  camera.rotation.set(
    freeCamera.pitch + beatCam.phiKick * cameraShake * 0.45,
    freeCamera.yaw + beatCam.thetaKick * cameraShake * 0.45,
    freeCamera.roll + beatCam.rollKick * cameraShake
  );
  if (cameraShake > 0 && Math.abs(beatCam.radiusKick) > 0.0001) {
    // 半径方向冲击沿当前相机前向移动，形成节拍推进或回弹感。
    FREE_CAMERA_SHAKE_DIR.set(0, 0, -1).applyEuler(camera.rotation);
    camera.position.addScaledVector(FREE_CAMERA_SHAKE_DIR, beatCam.radiusKick * cameraShake * 0.52);
  }
  // camPunch 和 beatCam.punch 共同影响 FOV，节拍强时略微收窄视野。
  var cameraPunch = Math.max(camPunch * 0.55, beatCam.punch * 0.54 + beatCam.radiusKick * 0.16) * cameraShake;
  var targetFov = clampRange(freeCamera.fov || BASE_FOV, 26, 72) - cameraPunch * 1.75;
  camera.fov += (targetFov - camera.fov) * (targetFov < camera.fov ? 0.24 : 0.12);
  camera.updateProjectionMatrix();
  camPunch *= 0.86;
  return true;
}
// 更新自由相机提示条显示状态。
function updateFreeCameraHint() {
  var el = document.getElementById('free-camera-hint');
  if (el) el.classList.toggle('show', !!(freeCamera && freeCamera.active));
}
// 将自由相机平滑重置到默认构图。
function resetFreeCameraToDefault() {
  // 未初始化自由相机时无需处理。
  if (!freeCamera) return;
  if (freeCameraDeferredSaveTimer) {
    // 重置前取消延迟保存，避免旧位置在动画中途写回。
    clearTimeout(freeCameraDeferredSaveTimer);
    freeCameraDeferredSaveTimer = 0;
  }
  // 保存当前位姿作为重置动画起点。
  var fromPos = freeCamera.position ? freeCamera.position.clone() : new THREE.Vector3(0, 0, 6.6);
  // 根据当前预设得到目标位姿。
  var resetPose = getDefaultFreeCameraResetPose();
  // resetTween 由 updateFreeCamera 每帧消费。
  freeCamera.resetTween = {
    start: performance.now(),
    duration: 620,
    from: {
      position: fromPos,
      yaw: Number(freeCamera.yaw) || 0,
      pitch: Number(freeCamera.pitch) || 0,
      roll: Number(freeCamera.roll) || 0,
      fov: Number(freeCamera.fov) || BASE_FOV
    },
    to: {
      position: resetPose.position,
      yaw: resetPose.yaw,
      pitch: resetPose.pitch,
      roll: resetPose.roll,
      fov: resetPose.fov
    }
  };
  // 重置动画期间不接受自由相机主动移动，但保持 locked 以继续接管相机。
  freeCamera.active = false;
  freeCamera.locked = true;
  // 清空按键和速度，避免动画结束后继续移动。
  freeCamera.keys = {};
  if (freeCamera.velocity) freeCamera.velocity.set(0, 0, 0);
  try { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); } catch (e) {}
  updateFreeCameraHint();
  showToast('自由镜头正在平滑回正');
}
// 切换自由相机模式：激活时从当前主相机捕获位姿，关闭时固定当前位置。
function toggleFreeCamera() {
  if (!freeCamera) freeCamera = defaultFreeCameraState();
  if (freeCamera.active) {
    // 再次切换时退出主动移动，但保留 locked，画面停在当前位置。
    freeCamera.active = false;
    freeCamera.locked = true;
    freeCamera.keys = {};
    if (freeCamera.velocity) freeCamera.velocity.set(0, 0, 0);
    try { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); } catch (e) {}
    saveFreeCameraState();
    updateFreeCameraHint();
    showToast('自由镜头已固定');
    return;
  }
  // 开启时以当前相机位置为起点，避免画面跳变。
  captureFreeCameraFromCurrent();
  freeCamera.active = true;
  freeCamera.locked = true;
  freeCamera.resetTween = null;
  freeCamera.keys = {};
  freeCameraPointer.seen = false;
  if (!freeCamera.velocity) freeCamera.velocity = new THREE.Vector3();
  try { renderer.domElement.focus && renderer.domElement.focus({ preventScroll: true }); } catch (e) {
    // 旧浏览器不支持 preventScroll 时降级为普通 focus。
    try { renderer.domElement.focus && renderer.domElement.focus(); } catch (ignore) {}
  }
  saveFreeCameraState();
  updateFreeCameraHint();
  try {
    // 指针锁定让鼠标移动可以持续控制相机视角。
    var lockResult = renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock();
    if (lockResult && lockResult.catch) lockResult.catch(function(){ freeCameraPointer.seen = false; });
  } catch (e) {
    freeCameraPointer.seen = false;
  }
  showToast('自由镜头: WASD 移动 · 鼠标转向 · K 回正');
}
// 每帧更新自由相机位置、重置动画和键盘移动。
function updateFreeCamera(dt) {
  if (!freeCamera) return;
  if (freeCamera.resetTween) {
    // 正在执行回正动画时，按缓出曲线插值位置、角度和 FOV。
    var tw = freeCamera.resetTween;
    var t = easeOutCubic01((performance.now() - tw.start) / Math.max(1, tw.duration || 620));
    freeCamera.position.copy(tw.from.position).lerp(tw.to.position, t);
    freeCamera.yaw = tw.from.yaw + shortestAngleDelta(tw.from.yaw, tw.to.yaw) * t;
    freeCamera.pitch = tw.from.pitch + (tw.to.pitch - tw.from.pitch) * t;
    freeCamera.roll = tw.from.roll + shortestAngleDelta(tw.from.roll, tw.to.roll) * t;
    freeCamera.fov = tw.from.fov + (tw.to.fov - tw.from.fov) * t;
    if (t >= 0.999) {
      // 动画结束后写入精确目标值，并释放自由相机接管。
      freeCamera.position.copy(tw.to.position);
      freeCamera.yaw = tw.to.yaw;
      freeCamera.pitch = tw.to.pitch;
      freeCamera.roll = tw.to.roll;
      freeCamera.fov = tw.to.fov;
      freeCamera.resetTween = null;
      freeCamera.active = false;
      freeCamera.locked = false;
      saveFreeCameraState();
      updateFreeCameraHint();
      recenterCamera();
      showToast('自由镜头已回正');
    }
    return;
  }
  // 未激活时只保留 locked 应用，不处理键盘移动。
  if (!freeCamera.active) return;
  // keys 由键盘事件维护，这里只把按键状态转换为移动向量。
  var keys = freeCamera.keys || {};
  FREE_CAMERA_MOVE.set(0, 0, 0);
  if (keys.KeyW) FREE_CAMERA_MOVE.z -= 1;
  if (keys.KeyS) FREE_CAMERA_MOVE.z += 1;
  if (keys.KeyA) FREE_CAMERA_MOVE.x -= 1;
  if (keys.KeyD) FREE_CAMERA_MOVE.x += 1;
  if (keys.Space) FREE_CAMERA_MOVE.y += 1;
  if (keys.ControlLeft || keys.ControlRight) FREE_CAMERA_MOVE.y -= 1;
  if (!freeCamera.velocity) freeCamera.velocity = new THREE.Vector3();
  var targetVel = FREE_CAMERA_TARGET_VEL.set(0, 0, 0);
  if (FREE_CAMERA_MOVE.lengthSq() > 0) {
    // 归一化后按当前 yaw/pitch 旋转到世界方向。
    FREE_CAMERA_MOVE.normalize();
    FREE_CAMERA_EULER.set(freeCamera.pitch, freeCamera.yaw, 0, 'YXZ');
    FREE_CAMERA_MOVE.applyEuler(FREE_CAMERA_EULER);
    var speed = (keys.ShiftLeft || keys.ShiftRight ? 6.2 : 2.35);
    targetVel.copy(FREE_CAMERA_MOVE).multiplyScalar(speed);
  }
  // 有输入时加速较慢，松手时阻尼更快，手感更稳。
  var ease = targetVel.lengthSq() > 0 ? 8.2 : 13.5;
  freeCamera.velocity.lerp(targetVel, clampRange(ease * Math.max(0.001, dt || 1 / 60), 0, 1));
  if (freeCamera.velocity.lengthSq() < 0.0004) freeCamera.velocity.set(0, 0, 0);
  freeCamera.position.addScaledVector(freeCamera.velocity, Math.max(0.001, dt || 1 / 60));
  // Q/E 控制 roll，限制在 -π..π。
  var rollDir = (keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0);
  if (rollDir) freeCamera.roll = clampRange(freeCamera.roll + rollDir * dt * 0.9, -Math.PI, Math.PI);
  scheduleFreeCameraStateSave(720);
}
// 页面卸载或隐藏前持久化视觉设置和自由相机状态。
function flushPersistentVisualState() {
  try { saveLyricLayout(); } catch (e) {}
  try { saveFreeCameraState(); } catch (e) {}
}
// beforeunload 和 pagehide 都注册保存，覆盖普通关闭、路由切换和移动端页面冻结。
window.addEventListener('beforeunload', flushPersistentVisualState);
window.addEventListener('pagehide', flushPersistentVisualState);

// 重置节拍镜头同步状态，通常在切歌、seek 或重新对齐 beatMap 时调用。
function resetBeatCameraSync(t) {
  // 清空预解析节拍队列和当前冲击包络。
  beatCam.nextIdx = 0;
  beatCam.events.length = 0;
  beatCam.punch = 0;
  beatCam.lastTriggerAt = -10;
  beatCam.lastRealtimeAt = -10;
  beatCam.thetaKick = 0;
  beatCam.phiKick = 0;
  beatCam.radiusKick = 0;
  beatCam.rollKick = 0;
  beatCam.prevAudioTime = isFinite(t) ? t : -1;
  camPunch = 0;
  // 统计归零，避免跨歌曲累积。
  beatCam.stats.map = 0;
  beatCam.stats.live = 0;
  beatCam.stats.merged = 0;
  beatCam.stats.liveBlocked = 0;
  liveCamAvg = 0;
  liveCamPeak = 0.28;
  liveCamLastRaw = 0;
  resetRealtimeBeatEngine();
}

// 把节拍镜头游标同步到指定播放时间。
function syncBeatCameraToTime(t) {
  resetBeatCameraSync(t);
  // 没有当前 beatMap 时只做状态重置。
  if (!currentBeatMap) return;
  alignBeatCameraCursorToTime(t);
}

// 将 beatCam.nextIdx 前移到当前时间之后的第一个可预判节拍。
function alignBeatCameraCursorToTime(t) {
  if (!currentBeatMap) return;
  // 兼容不同 beatMap 字段命名。
  var beats = currentBeatMap.cameraBeats || currentBeatMap.beats || currentBeatMap.kicks || [];
  beatCam.nextIdx = 0;
  while (beatCam.nextIdx < beats.length) {
    // beat 项既可能是数字，也可能是 { time } 对象。
    var bt = typeof beats[beatCam.nextIdx] === 'number' ? beats[beatCam.nextIdx] : beats[beatCam.nextIdx].time;
    if (bt >= t + beatCam.lookahead) break;
    beatCam.nextIdx++;
  }
}

// 节拍镜头使用的 smoothstep 缓动。
function easeBeatCamera(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}

// 根据当前原始能量和低频能量更新电影镜头动态缩放。
function updateCinemaDynamics(rawEnergy, rawLow) {
  // 输入归一化，避免异常频谱值污染长期包络。
  var e = clamp01(rawEnergy || 0);
  var l = clamp01(rawLow || 0);
  var isDj = djMode.active;
  // DJ 模式更重视低频，普通模式更重视总能量。
  var composite = clamp01(e * (isDj ? 0.52 : 0.62) + l * (isDj ? 0.48 : 0.38));
  if (isDj) {
    // DJ 模式额外跟踪段落能量变化，用于更明显的镜头跃迁。
    var prevEnergy = djMode.sectionEnergy || 0;
    var prevLow = djMode.sectionLow || 0;
    djMode.sectionEnergy += (e - djMode.sectionEnergy) * (e > djMode.sectionEnergy ? 0.030 : 0.010);
    djMode.sectionLow += (l - djMode.sectionLow) * (l > djMode.sectionLow ? 0.036 : 0.012);
    var change = Math.abs(e - prevEnergy) * 0.46 + Math.abs(l - prevLow) * 0.62;
    djMode.sectionChange += (change - djMode.sectionChange) * (change > djMode.sectionChange ? 0.055 : 0.018);
    djMode.visualPulse *= Math.pow(0.30, 1 / 60);
  }
  // avg/lowAvg/peak 是慢速自适应基线，避免不同歌曲音量差异过大。
  cinemaDynamics.avg += (composite - cinemaDynamics.avg) * (composite > cinemaDynamics.avg ? (isDj ? 0.018 : 0.010) : (isDj ? 0.006 : 0.004));
  cinemaDynamics.lowAvg += (l - cinemaDynamics.lowAvg) * (l > cinemaDynamics.lowAvg ? (isDj ? 0.022 : 0.012) : (isDj ? 0.007 : 0.005));
  cinemaDynamics.peak = Math.max(isDj ? 0.36 : 0.30, cinemaDynamics.peak * (isDj ? 0.9980 : 0.9988), composite);
  var floor = Math.max(0.10, cinemaDynamics.avg * 0.82);
  var span = Math.max(0.18, cinemaDynamics.peak - floor);
  // lift 表示当前能量相对基线的抬升程度。
  var lift = clamp01((composite - floor) / span);
  lift = lift * lift * (3 - 2 * lift);
  var target = isDj
    ? 0.50 + lift * 0.66 + clamp01((l - cinemaDynamics.lowAvg) / 0.30) * 0.18 + clamp01(djMode.sectionChange * 2.4) * 0.08
    : 0.42 + lift * 0.56 + clamp01((l - cinemaDynamics.lowAvg) / 0.36) * 0.12;
  if (cinemaDynamics.avg < 0.18 && l < 0.32) target *= isDj ? 0.88 : 0.78;
  if (e > 0.48 && l > 0.46) target = Math.max(target, isDj ? 1.02 : 0.92);
  target = clampRange(target, isDj ? 0.42 : 0.34, isDj ? 1.24 : 1.08);
  // 目标变大时快跟随，变小时慢回落，形成更自然的电影镜头呼吸。
  cinemaDynamics.scale += (target - cinemaDynamics.scale) * (target > cinemaDynamics.scale ? (isDj ? 0.070 : 0.045) : (isDj ? 0.030 : 0.022));
}

// 组合电影镜头动态、歌曲画像和 DJ 加成，得到最终镜头强度倍率。
function cameraDynamicsScale(extra) {
  var isDj = djMode.active;
  // DJ 模式下按低频段落和 tempo 置信度加一点镜头强度。
  var djBoost = isDj ? (1.06 + clamp01(djMode.sectionLow) * 0.16 + clamp01(rtBeat.tempoConfidence) * 0.08) : 1;
  return clampRange((cinemaDynamics.scale || 0.82) * (cinemaTrackProfile.scale || 1) * (extra == null ? 1 : extra) * djBoost, isDj ? 0.24 : 0.18, isDj ? 1.42 : 1.18);
}

// 根据歌曲名/歌手名提供少量人工镜头强度提示，用于已知歌曲的特殊调校。
function cinemaTrackNameHint(song) {
  var label = ((song && song.name) || '') + ' ' + ((song && song.artist) || '');
  label = label.toLowerCase().replace(/\s+/g, '');
  if (/after17/.test(label)) return 0.46;
  if (/joey/.test(label)) return 1.08;
  return 1.0;
}

// 根据歌曲标题和歌手返回分析策略画像，某些歌曲使用更柔和或更稀疏的镜头策略。
function cinemaAnalysisProfileForSong(song) {
  // 标题和歌手统一小写并去空白，便于中英文规则匹配。
  var title = String((song && (song.name || song.title)) || '').toLowerCase().replace(/\s+/g, '');
  var artist = String((song && song.artist) || '').toLowerCase().replace(/\s+/g, '');
  var label = title + ' ' + artist;
  if (/日落大道|sunsetboulevard/.test(label)) {
    // 日落大道类曲目使用柔和律动和稀疏镜头，避免过强节拍切换。
    return {
      id: 'sunset-boulevard-soft-groove',
      softGroove: true,
      phaseScan: true,
      localRefine: true,
      sparseCamera: true,
      introPattern: true
    };
  }
  return { id: 'default', softGroove: false, phaseScan: false, localRefine: false, sparseCamera: false, introPattern: false };
}

// 重置当前歌曲的电影镜头画像统计。
function resetCinemaTrackProfile(song) {
  // scale/target 先回到中性，后续由频谱逐帧学习。
  cinemaTrackProfile.scale = 1.0;
  cinemaTrackProfile.target = 1.0;
  cinemaTrackProfile.nameHint = cinemaTrackNameHint(song);
  cinemaTrackProfile.frames = 0;
  cinemaTrackProfile.energyAvg = 0;
  cinemaTrackProfile.lowAvg = 0;
  cinemaTrackProfile.vocalAvg = 0;
  cinemaTrackProfile.melodyAvg = 0;
  cinemaTrackProfile.punchPeak = 0.10;
  cinemaTrackProfile.density = 0;
}

// 用实时频谱样本持续更新当前歌曲的电影镜头画像。
function updateCinemaTrackProfile(sample) {
  if (!sample) return;
  // p 是 cinemaTrackProfile 的局部别名，便于下面多次读写。
  var p = cinemaTrackProfile;
  p.frames++;
  // 简单一阶跟随函数，用于平滑各类长期均值。
  function follow(cur, next, k) { return cur + (next - cur) * k; }
  // 前几秒学习速度更快，后面改为慢速适应。
  var early = p.frames < 360;
  var k = early ? 0.020 : 0.006;
  // 分别学习总能量、低频、人声和旋律平均值。
  p.energyAvg = follow(p.energyAvg, clamp01(sample.energy), k);
  p.lowAvg = follow(p.lowAvg, clamp01(sample.low), k);
  p.vocalAvg = follow(p.vocalAvg, clamp01(sample.vocal), k * 0.8);
  p.melodyAvg = follow(p.melodyAvg, clamp01(sample.melody), k * 0.8);
  // punchRaw 代表瞬态冲击感，低频上升沿权重最高。
  var punchRaw = clamp01((sample.lowOnset || 0) * 2.4 + (sample.energyOnset || 0) * 1.5 + sample.low * 0.16);
  p.punchPeak = Math.max(0.10, p.punchPeak * 0.9975, punchRaw);
  // 下面把长期画像拆成低频驱动、响度驱动、冲击驱动、人声柔化和安静柔化。
  var lowDrive = clamp01((p.lowAvg - 0.20) / 0.42);
  var loudDrive = clamp01((p.energyAvg - 0.18) / 0.40);
  var punchDrive = clamp01((p.punchPeak - 0.13) / 0.36);
  var vocalSoft = clamp01((p.vocalAvg * 0.72 + p.melodyAvg * 0.42 - p.lowAvg * 0.34 - 0.08) / 0.42);
  var quietSoft = clamp01((0.24 - p.energyAvg) / 0.18);
  // DJ 模式更强调低频和冲击，普通模式会被人声和安静段明显压低。
  var target = djMode.active
    ? 0.72 + lowDrive * 0.34 + loudDrive * 0.18 + punchDrive * 0.42 - vocalSoft * 0.12 - quietSoft * 0.06
    : 0.54 + lowDrive * 0.28 + loudDrive * 0.22 + punchDrive * 0.34 - vocalSoft * 0.34 - quietSoft * 0.18;
  if (p.density) target += clamp01((p.density - 0.55) / 1.6) * 0.14;
  // 已知歌曲名提示作为最后倍率。
  target *= p.nameHint || 1;
  target = clampRange(target, djMode.active ? 0.68 : 0.28, djMode.active ? 1.26 : 1.12);
  p.target = target;
  // 普通模式下降更快，避免柔和歌曲被早期强节拍长期抬高。
  p.scale += (target - p.scale) * (target > p.scale ? (djMode.active ? 0.045 : 0.030) : (djMode.active ? 0.030 : 0.045));
}

// 使用预解析 beatMap 的统计结果修正电影镜头画像。
function applyCinemaProfileFromBeatMap(map) {
  // 没有时长无法计算密度。
  if (!map || !map.duration) return;
  // 只统计可用于相机的非数字事件，过滤掉普通节拍点。
  var events = (map.cameraBeats || map.beats || []).filter(function(b){ return b && typeof b !== 'number' && b.camera !== false; });
  if (!events.length) return;
  // 聚合冲击、低频和 primary 数量。
  var sumImpact = 0, sumLow = 0, primary = 0;
  events.forEach(function(b){
    sumImpact += Math.max(b.impact || 0, b.strength || 0);
    sumLow += b.low || 0;
    if (b.primary !== false) primary++;
  });
  var avgImpact = sumImpact / events.length;
  var avgLow = sumLow / events.length;
  // 密度按每秒相机事件数量估计，分母下限避免短歌或片段过度放大。
  var density = events.length / Math.max(20, map.duration);
  cinemaTrackProfile.density = density;
  var target = 0.44 + clamp01((avgImpact - 0.20) / 0.55) * 0.38 + clamp01((avgLow - 0.24) / 0.48) * 0.18 + clamp01((density - 0.45) / 1.65) * 0.20 + clamp01(primary / Math.max(1, events.length)) * 0.08;
  target *= cinemaTrackProfile.nameHint || 1;
  target = clampRange(target, 0.28, 1.12);
  cinemaTrackProfile.target = target;
  cinemaTrackProfile.scale += (target - cinemaTrackProfile.scale) * (target < cinemaTrackProfile.scale ? 0.55 : 0.22);
}

// 重置实时节拍检测器的全部包络、峰值、节拍间隔和统计。
function resetRealtimeBeatEngine() {
  // 快慢包络全部清零，避免上一首歌的频段状态影响新歌。
  rtBeat.subFast = rtBeat.subSlow = rtBeat.lowFast = rtBeat.lowSlow = 0;
  rtBeat.bodyFast = rtBeat.bodySlow = rtBeat.vocalFast = rtBeat.vocalSlow = rtBeat.snapFast = rtBeat.snapSlow = 0;
  rtBeat.prevSub = rtBeat.prevLow = rtBeat.prevBody = rtBeat.prevVocal = rtBeat.prevSnap = rtBeat.prevRms = 0;
  rtBeat.onsetAvg = 0.012;
  rtBeat.onsetPeak = 0.060;
  rtBeat.subPeak = 0.14;
  rtBeat.lowPeak = 0.18;
  rtBeat.bodyPeak = 0.16;
  rtBeat.vocalPeak = 0.16;
  rtBeat.snapPeak = 0.14;
  rtBeat.lastHitAt = -10;
  rtBeat.tempoGap = 0;
  rtBeat.tempoConfidence = 0;
  rtBeat.beatCount = 0;
  rtBeat.primedFrames = 0;
  // 切歌或 seek 后留出 warmup 时间，避免刚恢复时的瞬态被误判成节拍。
  rtBeat.warmupUntil = (audio && isFinite(audio.currentTime) ? audio.currentTime : 0) + (djMode.active ? 0.34 : 1.15);
  rtBeat.pulse = 0;
  rtBeat.score = 0;
  rtBeat.stats.hits = 0;
  rtBeat.stats.blocked = 0;
  rtBeat.stats.assisted = 0;
  rtBeat.stats.strong = 0;
  rtBeat.stats.rejected = 0;
}

// 重置音频驱动的所有视觉能量状态。
function resetAudioVisualState() {
  // 当前帧能量清零。
  bass = 0;
  mid = 0;
  treble = 0;
  audioEnergy = 0;
  beatPulse = 0;
  prevEnergy = 0;
  smoothBass = 0;
  smoothMid = 0;
  smoothTreb = 0;
  smoothEnergy = 0;
  bassPeak = 0.12;
  midPeak = 0.10;
  treblePeak = 0.08;
  energyPeak = 0.10;
  // 预排节拍脉冲和上升沿状态清零。
  scheduledBeatPulse = 0;
  scheduledBeatFlag = false;
  beatOnsetFlag = false;
  cinemaDynamics.avg = 0;
  cinemaDynamics.lowAvg = 0;
  cinemaDynamics.peak = 0.30;
  cinemaDynamics.scale = 0.82;
  // DJ 模式下同步重置 DJ 量表。
  if (djMode.active) resetDjModeMeter();
}

// 从数字或对象形式的 beat 事件中读取时间。
function beatEventTime(ev) {
  return typeof ev === 'number' ? ev : (ev && isFinite(ev.time) ? ev.time : Infinity);
}

// 让出一次绘制机会，适合在重任务前等待浏览器先刷新 UI。
function yieldToPaint() {
  return new Promise(function(resolve) {
    // 后台或无 RAF 环境下直接用 setTimeout。
    if (isHiddenForBackgroundOptimization() || typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
    } else {
      requestAnimationFrame(function(){ setTimeout(resolve, 0); });
    }
  });
}

// 等待浏览器空闲时间，后台时使用短 timeout，避免任务永久挂起。
function yieldToIdle(timeout) {
  return new Promise(function(resolve) {
    // 后台优化状态下不依赖 requestIdleCallback，直接短延迟返回。
    if (isHiddenForBackgroundOptimization()) {
      setTimeout(resolve, Math.min(timeout || 80, 80));
      return;
    }
    // 优先使用 requestIdleCallback，把非关键视觉任务让给交互和渲染。
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function(){ resolve(); }, { timeout: timeout || 1200 });
    } else {
      setTimeout(resolve, timeout ? Math.min(timeout, 600) : 160);
    }
  });
}

// 延迟并在空闲帧执行视觉应用任务，常用于封面、AI 深度和重建类操作。
function scheduleVisualApply(fn, delay, timeout) {
  if (typeof fn !== 'function') return;
  setTimeout(function(){
    // 后台时直接执行，避免等待不可见页面的 RAF。
    if (isHiddenForBackgroundOptimization() || typeof requestAnimationFrame !== 'function') {
      fn();
      return;
    }
    // 空闲后再进下一帧，减少和当前帧绘制竞争。
    var run = function(){ requestAnimationFrame(fn); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: timeout || 360 });
    else run();
  }, delay || 0);
}

// 安排 UI 预热任务，例如纹理上传、控制条位移图刷新等。
function scheduleUiWarmTask(fn, timeout) {
  if (typeof fn !== 'function') return;
  // 前台优先走 idle + RAF，后台降级为 timeout。
  var run = function(){ requestAnimationFrame(fn); };
  if (isHiddenForBackgroundOptimization() || typeof requestAnimationFrame !== 'function') {
    setTimeout(fn, 0);
  } else if (window.requestIdleCallback) {
    requestIdleCallback(run, { timeout: timeout || 220 });
  } else {
    requestAnimationFrame(fn);
  }
}

// 取消普通 beatMap 分析计时器。
function cancelBeatAnalysisTimer() {
  if (beatAnalysisTimer) {
    clearTimeout(beatAnalysisTimer);
    beatAnalysisTimer = null;
  }
}

// 计算频谱数组在指定频段内的 RMS 能量。
function beatBandRms(data, sampleRate, fftSize, hz0, hz1) {
  // binHz 表示每个 FFT bin 对应的频率宽度。
  var binHz = sampleRate / fftSize;
  // 频段上下界转换为 bin 索引，并限制在数组范围内。
  var a = Math.max(1, Math.floor(hz0 / binHz));
  var b = Math.min(data.length - 1, Math.ceil(hz1 / binHz));
  var sum = 0, count = 0;
  for (var i = a; i <= b; i++) {
    // 宿主频谱已经映射到 0..255，这里还原到 0..1 后平方累加。
    var v = data[i] / 255;
    sum += v * v;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

// 判断输入是否是可按数组读取的宿主频谱数据。
function isHostSpectrumArray(value) {
  return !!(value && typeof value.length === 'number' && (Array.isArray(value) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value))));
}

// 判断当前是否有仍然有效的宿主频谱帧。
function hasHostSpectrumFrame() {
  // 没有时间戳说明从未收到过宿主频谱。
  if (!hostSpectrumFrame || !hostSpectrumFrame.updatedAt) return false;
  var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // 超过 TTL 的频谱视为过期，避免暂停后残留能量。
  if (now - hostSpectrumFrame.updatedAt > HOST_SPECTRUM_TTL_MS) return false;
  return !!(
    ((isHostSpectrumArray(hostSpectrumFrame.bins) && hostSpectrumFrame.bins.length) ||
      (isHostSpectrumArray(hostSpectrumFrame.waveform) && hostSpectrumFrame.waveform.length) ||
      Number(hostSpectrumFrame.rms || 0) > 0 ||
      Number(hostSpectrumFrame.peak || 0) > 0));
}

// 把宿主低维 bins 重采样到旧播放器期望的 frequencyData 长度。
function readHostFrequencyData(target) {
  // 宿主 bins 可能是数组或 TypedArray。
  var bins = hostSpectrumFrame && isHostSpectrumArray(hostSpectrumFrame.bins) ? hostSpectrumFrame.bins : [];
  for (var i = 0; i < target.length; i++) {
    if (!bins.length) {
      target[i] = 0;
      continue;
    }
    // 使用非线性 ratio 让低频获得更多采样密度，适配节拍检测需求。
    var ratio = target.length > 1 ? i / (target.length - 1) : 0;
    var sourceIndex = bins.length > 1 ? Math.min(bins.length - 1, Math.floor(Math.pow(ratio, 0.76) * (bins.length - 1))) : 0;
    target[i] = Math.max(0, Math.min(255, Math.round(clamp01(Number(bins[sourceIndex] || 0)) * 255)));
  }
}

// 把宿主 waveform 重采样到旧播放器期望的 timeDomainData 长度。
function readHostWaveformData(target) {
  var waveform = hostSpectrumFrame && isHostSpectrumArray(hostSpectrumFrame.waveform) ? hostSpectrumFrame.waveform : [];
  for (var i = 0; i < target.length; i++) {
    if (!waveform.length) {
      target[i] = 128;
      continue;
    }
    // waveform 可能是 -1..1 或 0..1，这里统一转到 0..255 的类 AnalyserNode 输出。
    var sourceIndex = Math.min(waveform.length - 1, Math.floor(i / Math.max(1, target.length - 1) * (waveform.length - 1)));
    var value = Number(waveform[sourceIndex] || 0);
    if (value >= 0 && value <= 1) value = value * 2 - 1;
    target[i] = Math.max(0, Math.min(255, Math.round(128 + clampRange(value, -1, 1) * 112)));
  }
}

// 读取宿主 RMS，缺失或非法时使用调用方提供的 fallback。
function readHostSpectrumRms(fallback) {
  var value = Number(hostSpectrumFrame && hostSpectrumFrame.rms);
  return isFinite(value) ? clamp01(value) : (fallback || 0);
}

// 实时节拍检测引擎：从宿主频谱中估计当前帧是否产生可用于镜头和粒子脉冲的 beat。
function processRealtimeBeatEngine(dt) {
  // 没有有效频谱或播放器未播放时不进行实时节拍检测。
  if (!hasHostSpectrumFrame() || !audio || audio.paused) return null;
  // dt 限制在合理范围，避免失焦恢复时的大 dt 破坏包络。
  dt = Math.max(0.001, Math.min(0.080, dt || 0.016));
  var dj = djMode.active;
  // 读取宿主频谱到节拍检测专用缓存。
  readHostFrequencyData(beatFrequencyData);
  readHostWaveformData(beatTimeDomainData);
  // 频段按听感拆成 sub、kick、body、vocal、snap。
  var sr = HOST_SPECTRUM_SAMPLE_RATE;
  var sub = beatBandRms(beatFrequencyData, sr, BEAT_FFT_SIZE, 38, 74);
  var kick = beatBandRms(beatFrequencyData, sr, BEAT_FFT_SIZE, 52, 165);
  var body = beatBandRms(beatFrequencyData, sr, BEAT_FFT_SIZE, 165, 420);
  var vocal = beatBandRms(beatFrequencyData, sr, BEAT_FFT_SIZE, 420, 2600);
  var snap = beatBandRms(beatFrequencyData, sr, BEAT_FFT_SIZE, 1800, 9200);
  var low = Math.min(1, kick * 0.86 + sub * 0.42);
  // 从波形计算 RMS，作为总能量变化的补充。
  var rms = 0;
  for (var i = 0; i < beatTimeDomainData.length; i++) {
    var tv = (beatTimeDomainData[i] - 128) / 128;
    rms += tv * tv;
  }
  rms = Math.sqrt(rms / beatTimeDomainData.length);

  // 指数跟随函数，upTau/downTau 分别控制上升和下降速度。
  function follow(cur, next, upTau, downTau) {
    var tau = next > cur ? upTau : downTau;
    return cur + (next - cur) * (1 - Math.exp(-dt / Math.max(0.001, tau)));
  }
  // DJ 模式下快包络更敏捷，慢包络略慢，便于锁住鼓点。
  var fastMul = dj ? 0.86 : 1;
  var downMul = dj ? 0.94 : 1;
  var slowMul = dj ? 1.06 : 1;
  rtBeat.subFast = follow(rtBeat.subFast, sub, 0.018 * fastMul, 0.064 * downMul);
  rtBeat.subSlow = follow(rtBeat.subSlow, sub, 0.320 * slowMul, 0.520 * slowMul);
  rtBeat.lowFast = follow(rtBeat.lowFast, low, 0.016 * fastMul, 0.070 * downMul);
  rtBeat.lowSlow = follow(rtBeat.lowSlow, low, 0.300 * slowMul, 0.540 * slowMul);
  rtBeat.bodyFast = follow(rtBeat.bodyFast, body, 0.020 * fastMul, 0.082 * downMul);
  rtBeat.bodySlow = follow(rtBeat.bodySlow, body, 0.360 * slowMul, 0.600 * slowMul);
  rtBeat.vocalFast = follow(rtBeat.vocalFast, vocal, 0.026 * fastMul, 0.090 * downMul);
  rtBeat.vocalSlow = follow(rtBeat.vocalSlow, vocal, 0.340 * slowMul, 0.580 * slowMul);
  rtBeat.snapFast = follow(rtBeat.snapFast, snap, 0.012 * fastMul, 0.060 * downMul);
  rtBeat.snapSlow = follow(rtBeat.snapSlow, snap, 0.300 * slowMul, 0.520 * slowMul);

  // 动态峰值用于把当前频段能量归一化，峰值随时间缓慢衰减。
  var peakDecay = dj ? 0.988 : 0.990;
  rtBeat.subPeak = Math.max(rtBeat.subPeak * Math.pow(peakDecay, dt * 60), sub, 0.045);
  rtBeat.lowPeak = Math.max(rtBeat.lowPeak * Math.pow(dj ? 0.987 : 0.989, dt * 60), low, 0.060);
  rtBeat.bodyPeak = Math.max(rtBeat.bodyPeak * Math.pow(peakDecay, dt * 60), body, 0.040);
  rtBeat.vocalPeak = Math.max(rtBeat.vocalPeak * Math.pow(peakDecay, dt * 60), vocal, 0.040);
  rtBeat.snapPeak = Math.max(rtBeat.snapPeak * Math.pow(peakDecay, dt * 60), snap, 0.035);

  // flux 表示原始能量正向变化，rise 表示快慢包络差值，两者共同描述瞬态。
  var subFlux = Math.max(0, sub - rtBeat.prevSub);
  var lowFlux = Math.max(0, low - rtBeat.prevLow);
  var bodyFlux = Math.max(0, body - rtBeat.prevBody);
  var vocalFlux = Math.max(0, vocal - rtBeat.prevVocal);
  var snapFlux = Math.max(0, snap - rtBeat.prevSnap);
  var rmsFlux = Math.max(0, rms - rtBeat.prevRms);
  var subRise = Math.max(0, rtBeat.subFast - rtBeat.subSlow);
  var lowRise = Math.max(0, rtBeat.lowFast - rtBeat.lowSlow);
  var bodyRise = Math.max(0, rtBeat.bodyFast - rtBeat.bodySlow);
  var vocalRise = Math.max(0, rtBeat.vocalFast - rtBeat.vocalSlow);
  var snapRise = Math.max(0, rtBeat.snapFast - rtBeat.snapSlow);
  // 鼓点 onset 以低频为主，音乐性 onset 以中高频和 RMS 为辅。
  var drumOnset = subRise * 0.88 + subFlux * 0.66 + lowRise * 1.62 + lowFlux * 1.34;
  var musicalOnset = bodyRise * 0.34 + bodyFlux * 0.24 + vocalRise * 0.52 + vocalFlux * 0.36 + snapRise * 0.08 + snapFlux * 0.06 + rmsFlux * 0.20;
  var onset = dj ? drumOnset * 1.05 + musicalOnset * 0.07 : drumOnset + musicalOnset * 0.16;

  // onsetAvg/onsetPeak 提供动态阈值，适应不同歌曲响度和密度。
  var avgTau = onset > rtBeat.onsetAvg ? (dj ? 0.88 : 1.10) : (dj ? 0.30 : 0.34);
  rtBeat.onsetAvg = follow(rtBeat.onsetAvg, onset, avgTau, avgTau);
  rtBeat.onsetPeak = Math.max(rtBeat.onsetPeak * Math.pow(dj ? 0.986 : 0.988, dt * 60), onset, 0.032);
  var floor = rtBeat.onsetAvg * (dj ? 0.88 : 0.84);
  var score = clamp01((onset - floor) / Math.max(dj ? 0.013 : 0.014, rtBeat.onsetPeak - floor));
  // 各频段归一化值用于后面的门控判断。
  var subNorm = clamp01(sub / Math.max(0.045, rtBeat.subPeak * (dj ? 0.72 : 0.70)));
  var lowNorm = clamp01(low / Math.max(0.060, rtBeat.lowPeak * (dj ? 0.74 : 0.72)));
  var bodyNorm = clamp01(body / Math.max(0.045, rtBeat.bodyPeak * (dj ? 0.74 : 0.72)));
  var vocalNorm = clamp01(vocal / Math.max(0.045, rtBeat.vocalPeak * 0.72));
  var snapNorm = clamp01(snap / Math.max(0.040, rtBeat.snapPeak * (dj ? 0.78 : 0.72)));
  // 当前音频时间作为节拍间隔和相位判断的基准。
  var nowT = audio.currentTime || 0;
  rtBeat.primedFrames++;
  // warmup 阶段只更新状态，不轻易触发节拍。
  var warmingUp = nowT < rtBeat.warmupUntil || rtBeat.primedFrames < (dj ? 8 : 18);
  var gapFromLast = nowT - rtBeat.lastHitAt;
  // 如果已经估计出 tempoGap，就用相位窗口辅助判断当前帧是否接近预期节拍。
  var expectedGap = rtBeat.tempoGap > 0 ? rtBeat.tempoGap : 0;
  var phaseErr = expectedGap > 0 ? Math.abs(gapFromLast - expectedGap) : 99;
  var phaseWindow = expectedGap > 0 ? Math.max(dj ? 0.055 : 0.055, Math.min(dj ? 0.105 : 0.105, expectedGap * (dj ? 0.16 : 0.16))) : 0;
  var tempoDue = expectedGap > 0 && gapFromLast > expectedGap - phaseWindow && gapFromLast < expectedGap + phaseWindow;
  // 低频存在感、低频攻击性和低频主导度共同决定鼓点可信度。
  var lowPresence = Math.max(lowNorm, subNorm * 0.74);
  var lowAttack = lowRise + lowFlux * 0.72 + subRise * 0.58 + subFlux * 0.40;
  var lowDominance = low / Math.max(0.001, vocal * 0.84 + body * 0.36 + snap * 0.10);
  var lowFluxDominance = (lowFlux + subFlux * 0.58) / Math.max(0.001, vocalFlux * 0.72 + bodyFlux * 0.42 + snapFlux * 0.16);
  // 人声遮罩用于避免强人声瞬态被误判为低频鼓点。
  var voiceMask = dj
    ? (vocalNorm > 0.62 && lowDominance < 0.92 && lowFluxDominance < 1.06 && subNorm < 0.54)
    : (vocalNorm > 0.58 && lowDominance < 0.86 && lowFluxDominance < 1.10);
  var drumGate = lowPresence > (dj ? 0.42 : 0.38) && lowAttack > Math.max(dj ? 0.015 : 0.014, rtBeat.onsetAvg * (dj ? 0.38 : 0.34)) && !voiceMask;
  // 进一步要求低频在响度或通量上占优，降低非鼓点瞬态误触发概率。
  drumGate = drumGate && (lowDominance > (dj ? 0.86 : 0.72) || lowFluxDominance > (dj ? 1.14 : 1.02) || subNorm > (dj ? 0.62 : 0.56));
  // strongTransient 偏保守，kickTransient 偏灵敏，tempoAssist 依赖已锁定节奏的相位窗口。
  var strongTransient = drumGate && score > (dj ? 0.55 : 0.54) && drumOnset > rtBeat.onsetAvg * (dj ? 0.92 : 0.84);
  var kickTransient = drumGate && score > (dj ? 0.43 : 0.40) && lowAttack > Math.max(dj ? 0.020 : 0.018, rtBeat.onsetAvg * (dj ? 0.54 : 0.46));
  var tempoAssist = tempoDue && rtBeat.tempoConfidence > (dj ? 0.40 : 0.42) && drumGate && lowPresence > (dj ? 0.48 : 0) && score > (dj ? 0.30 : 0.22) && lowAttack > Math.max(0.016, rtBeat.onsetAvg * (dj ? 0.44 : 0.34));
  var candidateHit = strongTransient || kickTransient || tempoAssist;
  // 预热阶段不允许触发节拍，只更新检测器内部状态。
  if (warmingUp) candidateHit = false;
  // tempo lock 表示已估计出稳定节拍间隔，后续命中要围绕该间隔验收。
  var hasTempoLock = expectedGap >= (dj ? 0.32 : 0.42) && expectedGap <= (dj ? 0.92 : 0.88) && rtBeat.tempoConfidence > (dj ? 0.36 : 0.38);
  var lockedWindow = hasTempoLock ? Math.max(dj ? 0.062 : 0.070, Math.min(dj ? 0.118 : 0.110, expectedGap * (dj ? 0.17 : 0.16))) : 0;
  var gapRaw = nowT - rtBeat.lastHitAt;
  var rhythmAccept = false;
  if (candidateHit) {
    if (rtBeat.lastHitAt < 0) {
      // 首个命中需要更强的瞬态和低频存在感。
      rhythmAccept = strongTransient && score > (dj ? 0.58 : 0.62) && lowPresence > (dj ? 0.50 : 0.48);
    } else if (hasTempoLock) {
      // 已锁 tempo 后，优先接受一拍误差内或两拍补位的命中。
      var oneBeatErr = Math.abs(gapRaw - expectedGap);
      var twoBeatErr = Math.abs(gapRaw - expectedGap * 2);
      rhythmAccept = oneBeatErr <= lockedWindow && (kickTransient || strongTransient);
      rhythmAccept = rhythmAccept || (twoBeatErr <= lockedWindow * 1.35 && strongTransient && score > (dj ? 0.54 : 0.58));
      rhythmAccept = rhythmAccept || (gapRaw > expectedGap * 1.55 && strongTransient && lowPresence > (dj ? 0.50 : 0.44));
      if (dj) {
        // DJ 模式允许较早的强低频重新校正节奏。
        rhythmAccept = rhythmAccept || (gapRaw > expectedGap * 1.24 && strongTransient && score > 0.56 && lowDominance > 0.92);
      }
    } else {
      // 未锁 tempo 时使用最小间隔和较强瞬态做保守验收。
      rhythmAccept = gapRaw >= (dj ? 0.340 : beatCam.realtimeMinInterval) && strongTransient && score > (dj ? 0.56 : 0.58) && lowPresence > (dj ? 0.50 : 0.44);
    }
  }
  // 最终命中必须同时满足候选和节奏验收。
  var hit = candidateHit && rhythmAccept;
  // 有明显候选但被拒绝时计入 rejected，便于调试阈值。
  if (!hit && (candidateHit || score > 0.42 || vocalNorm > 0.62 || bodyNorm > 0.54)) rtBeat.stats.rejected++;
  // 命中间隔过短则阻止，避免双击鼓点或噪声连续触发。
  var minGap = hasTempoLock ? Math.max(dj ? 0.315 : 0.400, Math.min(dj ? 0.500 : 0.540, expectedGap * (dj ? 0.64 : 0.72))) : (dj ? 0.340 : beatCam.realtimeMinInterval);
  if (hit && gapRaw < minGap) {
    rtBeat.stats.blocked++;
    hit = false;
  }

  // 更新上一帧频段值，供下一帧计算 flux。
  rtBeat.prevSub = sub;
  rtBeat.prevLow = low;
  rtBeat.prevBody = body;
  rtBeat.prevVocal = vocal;
  rtBeat.prevSnap = snap;
  rtBeat.prevRms = rms;
  rtBeat.score = score;
  // 节拍脉冲和 tempo 置信度按时间衰减。
  rtBeat.pulse *= Math.pow(dj ? 0.24 : 0.18, dt);
  rtBeat.tempoConfidence *= Math.pow(dj ? 0.992 : 0.996, dt * 60);

  if (!hit) {
    // 没命中时仍把 DJ 模式的 tempo 指示同步出去。
    if (dj) {
      djMode.tempoGap = rtBeat.tempoGap;
      djMode.tempoConfidence = rtBeat.tempoConfidence;
    }
    return { hit: false, score: score, low: lowNorm, body: bodyNorm, vocal: vocalNorm, snap: snapNorm, tempoConfidence: rtBeat.tempoConfidence };
  }

  // 命中后根据本次间隔更新 tempoGap，并计算相对旧 tempo 的偏移。
  var gapShift = 0;
  if (rtBeat.lastHitAt > 0) {
    var gap = nowT - rtBeat.lastHitAt;
    while (gap > (dj ? 0.96 : 0.88)) gap *= 0.5;
    while (gap < (dj ? 0.32 : 0.42)) gap *= 2.0;
    if (gap >= (dj ? 0.32 : 0.42) && gap <= (dj ? 0.96 : 0.88)) {
      gapShift = rtBeat.tempoGap ? Math.abs(gap - rtBeat.tempoGap) / Math.max(0.001, rtBeat.tempoGap) : 0;
      var tempoEase = hasTempoLock ? (dj ? 0.12 : 0.10) : (dj ? 0.24 : 0.22);
      // DJ 模式下强低频可更快修正 tempo。
      if (dj && gapShift > 0.16 && strongTransient && lowDominance > 0.95) tempoEase = Math.min(0.36, tempoEase + gapShift * 0.45);
      rtBeat.tempoGap = rtBeat.tempoGap ? rtBeat.tempoGap * (1 - tempoEase) + gap * tempoEase : gap;
      rtBeat.tempoConfidence = Math.min(1, rtBeat.tempoConfidence + (tempoAssist ? (dj ? 0.04 : 0.04) : (dj ? 0.16 : 0.18)));
    }
  }
  rtBeat.lastHitAt = nowT;
  // 命中统计和分类统计。
  rtBeat.beatCount++;
  rtBeat.stats.hits++;
  if (tempoAssist) rtBeat.stats.assisted++;
  if (strongTransient || kickTransient) rtBeat.stats.strong++;
  // strength 是当前节拍用于视觉的强度，融合 score、低频存在感、低频主导度和 RMS 变化。
  var strength = dj
    ? clamp01(0.18 + score * 0.38 + lowPresence * 0.34 + Math.min(1.35, lowDominance) * 0.08 + rmsFlux * 0.72)
    : clamp01(0.24 + score * 0.36 + lowPresence * 0.34 + Math.min(1.25, lowDominance) * 0.07 + rmsFlux * 0.95);
  if (tempoAssist) strength = Math.max(strength, (dj ? 0.46 : 0.48) + rtBeat.tempoConfidence * (dj ? 0.10 : 0.10) + lowPresence * (dj ? 0.14 : 0.14));
  // 四拍循环标签用于给镜头动作分配 downbeat/push/drop/rebound 的差异。
  var comboSlot = (rtBeat.beatCount - 1) % 4;
  var combo = comboSlot === 0 ? 'downbeat' : (comboSlot === 1 ? 'push' : (comboSlot === 2 ? 'drop' : 'rebound'));
  if (strength > 0.84 && comboSlot !== 0) combo = 'accent';
  if (dj && strength > 0.78 && snapNorm > 0.56 && comboSlot !== 0) combo = 'accent';
  if (dj && gapShift > 0.14 && strongTransient && lowPresence > 0.52) combo = 'downbeat';
  rtBeat.pulse = Math.max(rtBeat.pulse, strength);
  if (dj) {
    // DJ 模式同步 tempo、段落变化和最后命中时间，供后续镜头动态使用。
    djMode.tempoGap = rtBeat.tempoGap;
    djMode.tempoConfidence = rtBeat.tempoConfidence;
    djMode.sectionChange = Math.max(djMode.sectionChange, Math.min(1, gapShift * 1.4));
    djMode.visualPulse = Math.max(djMode.visualPulse, strength);
    djMode.lastBeatAt = nowT;
  }
  return {
    // DJ 模式下稍微提前命中时间，抵消实时检测滞后。
    hit: true,
    time: dj ? Math.max(0, nowT - 0.026) : nowT,
    strength: strength,
    confidence: dj ? clamp01(score * 0.58 + lowPresence * 0.30 + rtBeat.tempoConfidence * 0.12) : clamp01(score * 0.62 + lowPresence * 0.26 + rtBeat.tempoConfidence * 0.12),
    low: Math.max(0.05, lowPresence),
    body: Math.max(0.02, bodyNorm * (dj ? 0.50 : 0.62)),
    snap: Math.max(0.02, snapNorm * (dj ? 0.86 : 1)),
    mass: dj ? clamp01(lowPresence * 0.84 + bodyNorm * 0.10) : clamp01(lowPresence * 0.76 + bodyNorm * 0.20),
    sharpness: dj ? clamp01(snapNorm * 0.58 + bodyNorm * 0.10) : clamp01(snapNorm * 0.70 + bodyNorm * 0.12),
    tempoAssist: tempoAssist,
    tempoGap: rtBeat.tempoGap,
    combo: combo,
    score: score,
    lowDominance: lowDominance,
    dj: dj
  };
}

// 把实时检测到的 beat 合并到已有 beatCam 事件，避免预解析和实时检测重复触发相机。
function mergeRealtimeBeatCamera(time, amp, tone) {
  // 在合并窗口内寻找距离最近的已有事件。
  var best = null;
  var bestDist = beatCam.realtimeMergeWindow;
  for (var i = 0; i < beatCam.events.length; i++) {
    var dist = Math.abs((beatCam.events[i].hit || 0) - time);
    if (dist < bestDist) {
      best = beatCam.events[i];
      bestDist = dist;
    }
  }
  if (!best) return false;
  // 合并后重设 hit/start，让相机事件与实时命中对齐。
  var nowT = audio ? audio.currentTime : uniforms.uTime.value;
  best.hit = time;
  best.start = nowT - (best.attack || beatCam.attack) * 0.42;
  var mergeMaxAmp = ((tone && tone.dj) || djMode.active) ? 0.62 : 0.62;
  best.amp = Math.min(mergeMaxAmp, Math.max(best.amp || 0, amp));
  if (tone) {
    // tone 中的各类幅度取最大值，保留更强的视觉表达。
    best.zoomAmp = Math.max(best.zoomAmp || 0, tone.zoomAmp);
    best.thetaAmp = Math.max(best.thetaAmp || 0, tone.thetaAmp);
    best.phiAmp = Math.max(best.phiAmp || 0, tone.phiAmp);
    best.rollAmp = Math.max(best.rollAmp || 0, tone.rollAmp || 0);
    best.low = Math.max(best.low || 0, tone.low);
    best.body = Math.max(best.body || 0, tone.body);
    best.snap = Math.max(best.snap || 0, tone.snap);
    best.mode = tone.mode || best.mode;
    best.dj = !!tone.dj || !!best.dj;
  }
  best.source = 'hybrid';
  beatCam.stats.merged++;
  return true;
}

// 把一个 beat 事件转换成相机冲击事件并加入 beatCam.events。
function scheduleBeatCamera(beat, source) {
  // 电影镜头关闭时不调度任何相机事件。
  if (!fx.cinema) return;
  // beat 可为数字时间或对象，下面统一拆出时间、强度和置信度。
  var time = typeof beat === 'number' ? beat : beat.time;
  if (!isFinite(time)) return;
  var strength = typeof beat === 'number' ? 0.72 : Math.max(0, Math.min(1, beat.strength || 0.72));
  var confidence = typeof beat === 'number' ? 0.72 : Math.max(0, Math.min(1, beat.confidence || 0.72));
  var isPrimary = typeof beat === 'number' ? true : beat.primary !== false;
  var visualImpact = typeof beat === 'number' ? strength : Math.max(0, Math.min(1, beat.impact == null ? strength : beat.impact));
  var isDjMapSource = source === 'djmap';
  var isMapSource = source === 'map' || !source;
  var isLiveSource = source === 'live' || source === 'fallback';
  var livePreview = !!(isLiveSource && beat && beat.preview);
  var dj = djMode.active && (isLiveSource || isDjMapSource || (beat && beat.dj));
  // 预解析 map 只接受 primary 或高强度事件，避免镜头过密。
  if (isMapSource && !isPrimary) return;
  if (isMapSource && visualImpact < 0.18 && strength < 0.56) return;
  if (isMapSource && confidence < 0.30 && strength < 0.68) return;
  var trackScale = cinemaTrackProfile.scale || 1;
  // 歌曲画像认为应柔和时，弱事件会被丢弃。
  if (trackScale < 0.58 && isMapSource && strength < 0.72 && visualImpact < 0.46) return;
  if (trackScale < 0.50 && isLiveSource && strength < (dj ? 0.58 : 0.84) && visualImpact < (dj ? 0.42 : 0.56)) return;
  var lowTone = typeof beat === 'number' ? 0.62 : Math.max(0, beat.low == null ? 0.62 : beat.low);
  var bodyTone = typeof beat === 'number' ? 0.22 : Math.max(0, beat.body == null ? 0.22 : beat.body);
  var snapTone = typeof beat === 'number' ? 0.16 : Math.max(0, beat.snap == null ? 0.16 : beat.snap);
  var rawLowTone = lowTone;
  var rawBodyTone = bodyTone;
  var rawSnapTone = snapTone;
  var toneSum = Math.max(0.001, lowTone + bodyTone + snapTone);
  // 低频、身体感和清脆感归一化后用于决定镜头模式。
  lowTone /= toneSum;
  bodyTone /= toneSum;
  snapTone /= toneSum;
  var sharpness = typeof beat === 'number' ? snapTone : Math.max(0, Math.min(1, beat.sharpness == null ? snapTone : beat.sharpness));
  var mass = typeof beat === 'number' ? lowTone : Math.max(0, Math.min(1, beat.mass == null ? (lowTone * 0.72 + bodyTone * 0.36 + strength * 0.20) : beat.mass));
  var nowT = audio ? audio.currentTime : uniforms.uTime.value;
  // mode 决定镜头动作类型：deep 偏推拉，body 偏俯仰，snap 偏滚转。
  var mode = 'deep';
  if (dj) {
    if (rawSnapTone > 0.58 && rawSnapTone > rawLowTone * 0.86 && rawSnapTone > rawBodyTone * 1.08) mode = 'snap';
    else if (rawBodyTone > 0.36 && rawBodyTone > rawLowTone * 0.56) mode = 'body';
  } else {
    if (snapTone > 0.42 && snapTone > lowTone * 1.18 && snapTone > bodyTone * 1.08) mode = 'snap';
    else if (bodyTone > 0.46 && bodyTone > lowTone * 1.12) mode = 'body';
  }
  var amp;
  if (dj) {
    // DJ 模式按原始 tone 重新计算 drive，保持低频主导。
    var lowDrive = clamp01((rawLowTone - 0.42) / 0.54);
    var bodyDrive = clamp01((rawBodyTone - 0.24) / 0.58);
    var snapDrive = clamp01((rawSnapTone - 0.30) / 0.60);
    if (mode === 'deep') amp = 0.16 + strength * 0.20 + lowDrive * 0.25 + confidence * 0.05;
    else if (mode === 'body') amp = 0.12 + strength * 0.15 + bodyDrive * 0.18 + lowDrive * 0.06;
    else amp = 0.08 + strength * 0.11 + snapDrive * 0.13;
  } else {
    amp = Math.max(0.18, Math.min(0.72, 0.15 + strength * 0.34 + confidence * 0.06 + mass * 0.13 + snapTone * 0.04));
  }
  if (isMapSource) amp *= 0.68 + visualImpact * 0.46;
  if (!isPrimary) amp *= 0.62;
  if (source === 'fallback') amp *= 0.74;
  if (source === 'live') amp *= dj ? 0.62 : (livePreview ? 0.78 : 0.92);
  if (mode === 'deep' && !dj) amp = Math.min(0.62, amp * 1.12);
  // 歌曲画像动态缩放会整体影响本次相机冲击。
  var dynScale = cameraDynamicsScale(0.92 + visualImpact * 0.12 + mass * 0.08);
  amp *= dj ? clampRange(dynScale, 0.72, 1.16) : dynScale;
  var attack = dj
    ? (mode === 'snap' ? 0.010 : (mode === 'body' ? 0.015 : 0.017))
    : Math.max(0.014, Math.min(0.038, beatCam.attack * (1.18 - sharpness * 0.55)));
  var hold = dj
    ? (mode === 'deep' ? 0.038 + lowTone * 0.014 : (mode === 'body' ? 0.026 : 0.014))
    : Math.max(0.014, Math.min(0.052, beatCam.hold * (0.62 + lowTone * 0.55 + bodyTone * 0.25)));
  var release = dj
    ? (mode === 'deep' ? 0.178 + mass * 0.040 : (mode === 'body' ? 0.140 : 0.104))
    : Math.max(0.110, Math.min(0.255, beatCam.release * (0.76 + mass * 0.56 + bodyTone * 0.18 - sharpness * 0.18)));
  var idx = typeof beat === 'number' ? Math.floor(time * 2.7) : (beat.index || Math.floor(time * 2.7));
  var combo = typeof beat === 'number' ? null : beat.combo;
  if (!combo) {
    // 没有外部 combo 时按事件索引生成四拍循环动作标签。
    var comboSlot = Math.abs(idx) % 4;
    combo = comboSlot === 0 ? 'downbeat' : (comboSlot === 1 ? 'push' : (comboSlot === 2 ? 'drop' : 'rebound'));
  }
  // 基础镜头幅度拆成推拉、水平、垂直和滚转四类。
  var zoomAmp = 0.070 + mass * 0.190 + (mode === 'deep' ? 0.095 : 0.018) + strength * 0.045;
  var thetaAmp = 0.00035;
  var phiAmp = 0.002 + (mode === 'body' ? 0.012 : (mode === 'snap' ? 0.005 : 0.002));
  var rollAmp = mode === 'snap' ? (0.003 + snapTone * 0.004) : 0.0008;
  zoomAmp *= 0.76 + dynScale * 0.28;
  phiAmp *= 0.82 + dynScale * 0.20;
  rollAmp *= 0.78 + dynScale * 0.24;
  if (dj) {
    // DJ 模式重算各镜头通道，使 deep/body/snap 的差异更明确。
    var lowDrive2 = clamp01((rawLowTone - 0.42) / 0.54);
    var bodyDrive2 = clamp01((rawBodyTone - 0.24) / 0.58);
    var snapDrive2 = clamp01((rawSnapTone - 0.30) / 0.60);
    if (mode === 'deep') {
      zoomAmp = 0.115 + lowDrive2 * 0.170 + strength * 0.036;
      phiAmp = 0.0016 + bodyDrive2 * 0.0022;
      thetaAmp = 0.0006 + bodyDrive2 * 0.0012;
      rollAmp = 0.0006 + snapDrive2 * 0.0016;
    } else if (mode === 'body') {
      zoomAmp = 0.052 + lowDrive2 * 0.052;
      phiAmp = 0.0075 + bodyDrive2 * 0.018;
      thetaAmp = 0.0018 + bodyDrive2 * 0.0046;
      rollAmp = 0.0014 + snapDrive2 * 0.0022;
    } else {
      zoomAmp = 0.026 + lowDrive2 * 0.024;
      phiAmp = 0.0024 + bodyDrive2 * 0.0040;
      thetaAmp = 0.0009 + snapDrive2 * 0.0018;
      rollAmp = 0.0048 + snapDrive2 * 0.0095;
    }
    if (combo === 'downbeat') {
      // downbeat 重点强化推拉。
      amp *= 1.12;
      zoomAmp *= mode === 'deep' ? 1.28 : 1.06;
      phiAmp *= 0.76;
    } else if (combo === 'push') {
      // push 弱化推拉，增强左右偏移。
      amp *= mode === 'deep' ? 0.76 : 0.68;
      zoomAmp *= 0.62;
      thetaAmp *= 1.15;
    } else if (combo === 'drop') {
      // drop 偏向垂直冲击。
      amp *= 0.82;
      zoomAmp *= 0.50;
      phiAmp *= 1.38;
    } else if (combo === 'rebound') {
      // rebound 作为弱回弹。
      amp *= 0.62;
      zoomAmp *= 0.40;
      phiAmp *= 0.70;
    } else if (combo === 'accent') {
      // accent 更强调滚转或局部装饰。
      amp *= mode === 'snap' ? 0.78 : 0.94;
      zoomAmp *= mode === 'snap' ? 0.42 : 0.78;
      rollAmp *= 1.58;
    }
    if (isDjMapSource) {
      // 离线 DJ beatMap 事件根据 visualImpact 重新拉开强弱对比。
      var offlineContrast = Math.pow(clamp01((visualImpact - 0.16) / 0.72), 1.06);
      var offlineDrive = 0.72 + offlineContrast * 0.94 + Math.pow(strength, 1.22) * 0.14;
      var sectionLowGate = clamp01(((djMode.sectionLow || 0) - 0.030) / 0.32);
      var sectionEnergyGate = clamp01(((djMode.sectionEnergy || 0) - 0.045) / 0.40);
      var liveSectionGate = Math.max(sectionLowGate * 0.58 + sectionEnergyGate * 0.34, visualImpact * 0.82);
      var weakSectionScale = 0.54 + Math.pow(clamp01(liveSectionGate), 0.78) * 0.46;
      var comboDrive = combo === 'downbeat'
        ? 0.96 + offlineContrast * 0.38
        : (combo === 'drop'
          ? 0.80 + offlineContrast * 0.26
          : (combo === 'accent'
            ? 0.74 + offlineContrast * 0.30
          : (combo === 'push' ? 0.68 + offlineContrast * 0.16 : 0.52 + offlineContrast * 0.12)));
      if (mode === 'deep') {
        // deep 离线事件主要放大推拉和持续时间。
        amp *= offlineDrive * comboDrive * 1.38;
        zoomAmp *= 1.14 + offlineContrast * 0.68 + lowDrive2 * 0.20;
        phiAmp *= 0.72 + offlineContrast * 0.22;
        thetaAmp *= 0.72 + offlineContrast * 0.20;
        release *= 0.98 + offlineContrast * 0.20;
      } else if (mode === 'body') {
        // body 离线事件增强俯仰和横向微动。
        amp *= offlineDrive * comboDrive * 1.24;
        zoomAmp *= 0.90 + offlineContrast * 0.32;
        phiAmp *= 1.00 + offlineContrast * 0.42 + bodyDrive2 * 0.18;
        thetaAmp *= 0.98 + offlineContrast * 0.36 + bodyDrive2 * 0.14;
        release *= 0.96 + offlineContrast * 0.12;
      } else {
        // snap 离线事件压低推拉，增强滚转和短促感。
        amp *= offlineDrive * comboDrive * 0.94;
        zoomAmp *= 0.52 + offlineContrast * 0.24;
        phiAmp *= 0.84 + offlineContrast * 0.28;
        thetaAmp *= 0.86 + offlineContrast * 0.30;
        rollAmp *= 1.02 + offlineContrast * 0.76 + snapDrive2 * 0.22;
        attack *= 0.92;
        release *= 0.78 + offlineContrast * 0.14;
      }
      if (combo === 'downbeat') {
        // downbeat 离线事件再按对比度加强推拉。
        zoomAmp *= mode === 'deep' ? (1.04 + offlineContrast * 0.18) : (0.96 + offlineContrast * 0.12);
      } else if (combo === 'drop') {
        phiAmp *= 0.96 + offlineContrast * 0.28;
      } else if (combo === 'accent') {
        rollAmp *= 1.02 + offlineContrast * 0.34;
        zoomAmp *= 0.72 + offlineContrast * 0.20;
      }
      var peakTame = Math.pow(clamp01((visualImpact - 0.76) / 0.24), 1.35);
      if (peakTame > 0) {
        // 顶部强度做轻微驯化，避免高 impact beatMap 让相机过冲。
        var downbeatTame = combo === 'downbeat' ? 1.0 : 0.58;
        amp *= 1 - peakTame * (0.070 + downbeatTame * 0.050);
        zoomAmp *= 1 - peakTame * (0.060 + downbeatTame * 0.050);
        phiAmp *= 1 - peakTame * 0.035;
        release *= 1 - peakTame * 0.045;
      }
      if (visualImpact < 0.12 && liveSectionGate < 0.18) {
        // 离线弱事件且实时段落也很弱时整体收缩，避免安静段仍有大镜头。
        var softScale = Math.min(1, weakSectionScale * (0.72 + visualImpact * 1.10));
        amp *= softScale;
        zoomAmp *= 0.58 + softScale * 0.34;
        phiAmp *= 0.62 + softScale * 0.30;
        thetaAmp *= 0.62 + softScale * 0.28;
        rollAmp *= 0.66 + softScale * 0.24;
        release *= 0.86 + softScale * 0.16;
      }
    }
  } else if (combo === 'downbeat') {
    // 普通模式下按 combo 对镜头通道做基础差异化。
    amp *= 1.10;
    zoomAmp *= 1.18;
    phiAmp *= 0.72;
  } else if (combo === 'push') {
    amp *= 0.84;
    zoomAmp *= 0.88;
    phiAmp *= 0.62;
  } else if (combo === 'drop') {
    amp *= 0.96;
    zoomAmp *= 0.72;
    phiAmp *= 1.22;
  } else if (combo === 'rebound') {
    amp *= 0.74;
    zoomAmp *= 0.62;
    phiAmp *= 0.78;
  } else if (combo === 'accent') {
    amp *= 1.14;
    zoomAmp *= 1.08;
    rollAmp *= 1.35;
  }
  if (livePreview && !dj) {
    // beatMap 未就绪时的实时预览镜头更克制。
    var previewTone = clamp01(visualImpact * 0.54 + rawLowTone * 0.22 + confidence * 0.18 + strength * 0.06);
    amp *= 0.72 + previewTone * 0.16;
    zoomAmp *= 0.62 + previewTone * 0.18;
    phiAmp *= 0.70 + previewTone * 0.12;
    thetaAmp *= 0.70 + previewTone * 0.12;
    rollAmp *= 0.54 + previewTone * 0.16;
    release *= 1.08 + previewTone * 0.08;
  }
  // DJ 离线事件设置软上限，保留强弱但避免连续强事件太晃。
  if (dj && isDjMapSource && amp > 0.74) amp = 0.74 + (amp - 0.74) * 0.56;
  if (dj && isDjMapSource && zoomAmp > 0.30) zoomAmp = 0.30 + (zoomAmp - 0.30) * 0.52;
  amp = Math.max(dj ? (isDjMapSource ? 0.018 : 0.040) : 0.08, Math.min(dj ? (isDjMapSource ? 0.92 : 0.34) : 0.68, amp));
  if (isLiveSource) {
    // 实时来源额外限频，防止同一鼓点附近重复触发。
    var liveMinInterval = dj ? Math.max(0.315, Math.min(0.500, rtBeat.tempoGap ? rtBeat.tempoGap * 0.62 : 0.360)) : beatCam.realtimeMinInterval;
    if (time - beatCam.lastRealtimeAt < liveMinInterval && strength < (dj ? 0.74 : 0.78)) {
      beatCam.stats.liveBlocked++;
      return;
    }
    beatCam.lastRealtimeAt = time;
    // 优先尝试和已有预解析事件合并。
    if (mergeRealtimeBeatCamera(time, amp, {
      zoomAmp: zoomAmp, thetaAmp: thetaAmp, phiAmp: phiAmp, rollAmp: rollAmp, mode: mode,
      low: lowTone, body: bodyTone, snap: snapTone, dj: dj
    })) {
      beatCam.lastTriggerAt = Math.max(beatCam.lastTriggerAt, time);
      return;
    }
    for (var ei = beatCam.events.length - 1; ei >= 0; ei--) {
      // 如果实时命中抢在很近的 map 事件前，删除那个 map 事件，避免双触发。
      var pending = beatCam.events[ei];
      if (pending.source === 'map' && pending.hit > time && pending.hit - time < beatCam.realtimeMergeWindow) {
        beatCam.events.splice(ei, 1);
      }
    }
  }
  if (isDjMapSource) {
    // 离线 DJ map 事件按 step 控制最小间隔。
    var djGap = time - beatCam.lastTriggerAt;
    var djMinGap = Math.max(0.255, Math.min(0.470, (beat && beat.step ? beat.step * 0.52 : 0.320)));
    if (djGap < djMinGap && strength < 0.86) return;
    beatCam.lastTriggerAt = time;
    beatCam.stats.map++;
  } else if (!isLiveSource) {
    // 普通 map 事件使用 beatCam.minInterval，primary 事件可以略微放宽。
    var gap = time - beatCam.lastTriggerAt;
    var minGap = beatCam.minInterval;
    if (isMapSource && isPrimary) minGap *= 0.82;
    if (gap < minGap && strength < 0.88) return;
    beatCam.lastTriggerAt = time;
    beatCam.stats.map++;
  } else {
    // 实时事件只推进 lastTriggerAt 和 live 统计。
    beatCam.lastTriggerAt = Math.max(beatCam.lastTriggerAt, time);
    beatCam.stats.live++;
  }
  // 写入最终相机事件，updateBeatCamera 会按 attack/hold/release 消费它。
  beatCam.events.push({
    start: isLiveSource ? nowT - attack * 0.42 : nowT + (time - nowT) - attack,
    hit: time,
    amp: amp,
    attack: attack,
    hold: hold,
    release: release,
    zoomAmp: zoomAmp,
    thetaAmp: thetaAmp,
    phiAmp: phiAmp,
    rollAmp: rollAmp,
    mode: mode,
    combo: combo,
    phase: idx * 2.399963 + (snapTone - lowTone) * 1.4,
    low: lowTone,
    body: bodyTone,
    snap: snapTone,
    mass: mass,
    source: source || 'map',
    dj: dj
  });
  // 保留有限数量的未来/活动事件，避免长时间播放后事件数组增长。
  var maxEvents = djMode.active ? 12 : 8;
  if (beatCam.events.length > maxEvents) beatCam.events.splice(0, beatCam.events.length - maxEvents);
}

// 每帧消费 beatCam.events，生成当前帧的相机冲击偏移。
function updateBeatCamera(dt) {
  var t = audio ? audio.currentTime : uniforms.uTime.value;
  if (!audio || audio.paused) {
    // 暂停时快速衰减所有镜头冲击并清空待触发事件。
    beatCam.punch *= Math.pow(0.08, dt);
    beatCam.thetaKick *= Math.pow(0.05, dt);
    beatCam.phiKick *= Math.pow(0.05, dt);
    beatCam.radiusKick *= Math.pow(0.05, dt);
    beatCam.rollKick *= Math.pow(0.05, dt);
    beatCam.events.length = 0;
    beatCam.prevAudioTime = t;
    return;
  }
  if (beatCam.prevAudioTime >= 0 && Math.abs(t - beatCam.prevAudioTime) > 0.55) {
    // 检测到 seek 或播放时间跳变后重新对齐 beatMap 游标。
    if (djMode.active) syncDjBeatMapCursor(t, false);
    else syncBeatCameraToTime(t);
  }
  beatCam.prevAudioTime = t;

  // 本帧镜头冲击的各通道累计值。
  var punch = 0;
  var thetaKick = 0;
  var phiKick = 0;
  var radiusKick = 0;
  var rollKick = 0;
  var leadEvent = null;
  var leadPunch = 0;
  var leadVal = 0;
  for (var i = beatCam.events.length - 1; i >= 0; i--) {
    // 每个事件按 attack/hold/release 计算局部强度。
    var ev = beatCam.events[i];
    var attack = ev.attack || beatCam.attack;
    var hold = ev.hold || beatCam.hold;
    var release = ev.release || beatCam.release;
    var local = t - ev.start;
    var val = 0;
    if (local < 0) {
      val = 0;
    } else if (local < attack) {
      val = easeBeatCamera(local / attack);
    } else if (local < attack + hold) {
      val = 1;
    } else if (local < attack + hold + release) {
      var r = (local - attack - hold) / release;
      val = 1 - easeBeatCamera(r);
    } else {
      // 事件生命周期结束后移出队列。
      beatCam.events.splice(i, 1);
      continue;
    }
    var evPunch = val * ev.amp;
    punch = Math.max(punch, evPunch);
    if (evPunch > leadPunch) {
      // leadEvent 是本帧最强事件，后续按它决定方向和 combo 动作。
      leadEvent = ev;
      leadPunch = evPunch;
      leadVal = val;
    }
  }
  if (leadEvent) {
    // phase 决定左右方向，snapFlick 让 snap 类动作前段更锋利。
    var sign = Math.sin(leadEvent.phase) >= 0 ? 1 : -1;
    var snapFlick = 1.0 - Math.min(1, Math.max(0, leadVal - 0.25) / 0.75);
    var combo = leadEvent.combo || 'downbeat';
    if (combo === 'downbeat') {
      // downbeat 主要推拉相机。
      radiusKick = leadPunch * leadEvent.zoomAmp;
      phiKick = -leadPunch * 0.0032;
    } else if (combo === 'push') {
      // push 是较弱推拉。
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.72;
      phiKick = -leadPunch * 0.0014;
    } else if (combo === 'drop') {
      // drop 更偏垂直俯仰。
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.46;
      phiKick = leadPunch * leadEvent.phiAmp * 0.92;
    } else if (combo === 'rebound') {
      // rebound 是轻微回弹。
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.30;
      phiKick = -leadPunch * leadEvent.phiAmp * 0.22;
    } else if (combo === 'accent') {
      // accent 叠加滚转，适合清脆高频。
      radiusKick = leadPunch * leadEvent.zoomAmp * 0.90;
      phiKick = -leadPunch * 0.0022;
      rollKick = sign * leadPunch * (leadEvent.rollAmp || 0) * (0.45 + snapFlick * 0.30);
    } else if (leadEvent.mode === 'deep') {
      // 没有 combo 但 mode 为 deep 时走默认低频推拉。
      radiusKick = leadPunch * leadEvent.zoomAmp;
      phiKick = -leadPunch * 0.003;
    }
    if (leadEvent.dj) {
      // DJ 事件额外增加左右微动和 snap 滚转。
      var djSide = sign * leadPunch * (leadEvent.thetaAmp || 0.0012) * (0.70 + (leadEvent.body || 0) * 0.65 + (leadEvent.snap || 0) * 0.35);
      thetaKick += djSide;
      if (leadEvent.mode === 'snap' || combo === 'accent') {
        rollKick += sign * leadPunch * (leadEvent.rollAmp || 0.003) * (0.52 + snapFlick * 0.34);
      }
      if (combo === 'downbeat') radiusKick *= 1.06;
      else if (combo === 'drop') phiKick *= 1.18;
      punch = Math.min(0.90, punch * (1.04 + (leadEvent.mass || 0) * 0.10));
    }
  }
  // 将目标冲击平滑写入 beatCam，攻击快、释放慢，避免相机抖成硬切。
  var djEase = djMode.active;
  beatCam.punch += (punch - beatCam.punch) * (punch > beatCam.punch ? (djEase ? 0.82 : 0.72) : (djEase ? 0.44 : 0.38));
  beatCam.thetaKick += (thetaKick - beatCam.thetaKick) * (Math.abs(thetaKick) > Math.abs(beatCam.thetaKick) ? (djEase ? 0.80 : 0.70) : (djEase ? 0.42 : 0.36));
  beatCam.phiKick += (phiKick - beatCam.phiKick) * (Math.abs(phiKick) > Math.abs(beatCam.phiKick) ? (djEase ? 0.80 : 0.70) : (djEase ? 0.42 : 0.36));
  beatCam.radiusKick += (radiusKick - beatCam.radiusKick) * (radiusKick > beatCam.radiusKick ? (djEase ? 0.82 : 0.72) : (djEase ? 0.40 : 0.34));
  beatCam.rollKick += (rollKick - beatCam.rollKick) * (Math.abs(rollKick) > Math.abs(beatCam.rollKick) ? (djEase ? 0.82 : 0.72) : (djEase ? 0.44 : 0.38));
}

// 解除中心锁定，让用户轨道相机重新接管中心以外的偏移。
function unlockCenteredView() {
  orbit.centerLocked = false;
}

// 清理所有会让视图偏离中心的输入偏移。
function clearCenteredViewOffsets() {
  // 指针视差目标和当前值都归零。
  pointerTarget.x = 0;
  pointerTarget.y = 0;
  pointerParallax.x = 0;
  pointerParallax.y = 0;
  mouseWorld.set(-999, -999, 0);
  mouseActive = false;
  headParallax.x = 0;
  headParallax.y = 0;
  headParallax.active = false;
  headNeutral = null;
  if (typeof particleRotation !== 'undefined') {
    // 粒子拖拽旋转归零。
    particleRotation.x = 0;
    particleRotation.y = 0;
  }
  if (typeof particleSpin !== 'undefined') {
    // 粒子惯性速度归零。
    particleSpin.vx = 0;
    particleSpin.vy = 0;
  }
  if (typeof particlePointerSpin !== 'undefined') particlePointerSpin.active = false;
  if (typeof resetParticleRotationTarget === 'function') resetParticleRotationTarget(false);
}

// 根据轨道相机、焦点跟拍、电影镜头和自由相机状态更新主相机。
function updateCamera() {
  // 自由相机优先级最高，启用时直接返回。
  if (applyFreeCameraToCamera()) return;
  if (orbit.recentering) {
    // 回正时用户轨道参数缓慢靠近基准值。
    orbit.userTheta  += (orbit.baselineTheta - orbit.userTheta)  * 0.04;
    orbit.userPhi    += (orbit.baselinePhi   - orbit.userPhi)    * 0.04;
    orbit.userRadius += (orbit.baselineRadius- orbit.userRadius) * 0.04;
    if (Math.abs(orbit.userTheta - orbit.baselineTheta) < 0.005 &&
        Math.abs(orbit.userPhi - orbit.baselinePhi) < 0.005 &&
        Math.abs(orbit.userRadius - orbit.baselineRadius) < 0.05) {
      orbit.userTheta = orbit.baselineTheta;
      orbit.userPhi   = orbit.baselinePhi;
      orbit.userRadius= orbit.baselineRadius;
      orbit.recentering = false;
    }
  }

  // v8: focus 优先, 否则用 user + cine 复合姿态
  var fa = orbit.focus.active;
  // target* 是本帧相机要缓动靠近的目标轨道参数。
  var targetTheta, targetPhi, targetRadius, tLookAt;
  if (fa) {
    // 焦点跟拍优先，例如悬停歌单架。
    targetTheta = orbit.focus.theta;
    targetPhi   = orbit.focus.phi;
    targetRadius = orbit.focus.radius;
    tLookAt = orbit.focus.lookAt;
  } else if (orbit.centerLocked) {
    // 中心锁定时忽略用户拖拽，只叠加电影镜头偏移。
    targetTheta = orbit.baselineTheta + orbit.cineTheta;
    targetPhi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.baselinePhi + orbit.cinePhi));
    targetRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.baselineRadius + orbit.cineRadius));
    tLookAt = ZERO_VEC;
  } else {
    // 普通轨道模式：用户轨道和电影镜头偏移叠加。
    targetTheta = orbit.userTheta + orbit.cineTheta;
    targetPhi   = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.userPhi + orbit.cinePhi));
    targetRadius= Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + orbit.cineRadius));
    tLookAt = ZERO_VEC;
  }
  // 丝滑变速: 线性 lerp 自然给出 "快→慢" 缓出曲线
  var focusEase = fa ? 0.16 : 0.10;
  var radiusEase = fa ? 0.12 : 0.07;
  if (beatCam.punch > 0.01) {
    // 节拍冲击强时略微提高相机跟随速度，避免动作滞后。
    focusEase = Math.max(focusEase, 0.12 + beatCam.punch * 0.12);
    radiusEase = Math.max(radiusEase, 0.09 + beatCam.punch * 0.12);
  }
  orbit.theta  += (targetTheta  - orbit.theta)  * focusEase;
  orbit.phi    += (targetPhi    - orbit.phi)    * focusEase;
  orbit.radius += (targetRadius - orbit.radius) * radiusEase;
  orbit.lookAt.x += (tLookAt.x - orbit.lookAt.x) * focusEase;
  orbit.lookAt.y += (tLookAt.y - orbit.lookAt.y) * focusEase;
  orbit.lookAt.z += (tLookAt.z - orbit.lookAt.z) * focusEase;

  // 球坐标转笛卡尔坐标，得到相机在 lookAt 周围的位置。
  var cy = Math.cos(orbit.phi), sy = Math.sin(orbit.phi);
  var ct = Math.cos(orbit.theta), st = Math.sin(orbit.theta);
  camera.position.set(
    orbit.lookAt.x + orbit.radius * cy * st,
    orbit.lookAt.y + orbit.radius * sy,
    orbit.lookAt.z + orbit.radius * cy * ct
  );
  // 相机始终看向当前平滑后的 lookAt 点。
  camera.lookAt(orbit.lookAt);
  var cameraShake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  // beatCam.rollKick 最后叠加到相机 roll。
  camera.rotation.z += beatCam.rollKick * cameraShake;

  // 节拍 punch 会短暂改变 FOV，形成镜头冲击。
  var cameraPunch = Math.max(camPunch * 0.55, beatCam.punch * 0.54 + beatCam.radiusKick * 0.16) * cameraShake;
  var targetFOV = BASE_FOV - cameraPunch * (djMode.active ? 2.62 : 2.35);
  var fovEase = targetFOV < camera.fov ? 0.24 : 0.12;
  camera.fov += (targetFOV - camera.fov) * fovEase;
  camera.updateProjectionMatrix();
  camPunch *= 0.86;
}

// 焦点跟拍 (hover 0.5s 后镜头移到目标)
// 记录当前希望进入的焦点区以及进入/退出延迟计时器。
var focusHover = { wantType: null, pendingTimer: null, exitTimer: null };
// 星河/壁纸预设下使用更保守的歌单架相机构图。
function shouldUseWallpaperSafeShelfCamera() {
  return !!(fx && Number(fx.preset) === 5);
}
// 骷髅预设下使用专门的歌单架安全构图。
function shouldUseSkullSafeShelfCamera() {
  return !!(fx && Number(fx.preset) === SKULL_PRESET_INDEX);
}
// 星河预设且歌词相机锁开启时，歌词相机需要额外锁定。
function shouldUseWallpaperLyricCameraLock() {
  return !!(fx && Number(fx.preset) === 5 && fx.lyricCameraLock);
}
// 请求舞台歌词相机在后续若干帧强制贴合主相机。
function requestStageLyricCameraSnap(frames) {
  if (typeof stageLyrics === 'undefined' || !stageLyrics) return;
  stageLyrics.snapCameraLockFrames = Math.max(stageLyrics.snapCameraLockFrames || 0, frames || 8);
}
// 星河预设下，歌单架打开时是否压暗壁纸层。
function shouldDimWallpaperForShelf() {
  if (!shouldUseWallpaperSafeShelfCamera()) return false;
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfPinnedOpen) return true;
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
// 侧边歌单详情打开时，歌词需要避让右侧内容。
function shouldOffsetLyricsForShelfDetail() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
// 判断当前是否应让舞台歌词避开歌单架区域。
function shouldAvoidStageLyricsForShelf() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfAlwaysVisible()) return true;
  if (shelfPinnedOpen) return true;
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return true;
  return !!(shelfVisibility > 0.24 || (shelfHoverCue && shelfHoverCue.value > 0.28));
}
// 激活指定焦点区，并写入 orbit.focus 的目标轨道参数。
function activateFocusZone(type) {
  // 焦点区接管前解除中心锁，允许相机移动到侧边或队列目标。
  unlockCenteredView();
  orbit.focus.active = true;
  orbit.focus.type = type;
  var shelfProfile = shelfLayoutProfile();
  if (type === 'shelf-side') {
    // 右侧歌单架焦点。
    if (shouldUseWallpaperSafeShelfCamera()) {
      orbit.focus.theta  = shelfProfile.portrait ? 0.18 : 0.24;
      orbit.focus.phi    = shelfProfile.portrait ? 0.00 : 0.02;
      orbit.focus.radius = shelfProfile.portrait ? 5.74 : 5.32;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 1.04 : 2.24, -0.08, 0.78);
      camPunch = Math.max(camPunch, 0.28);
      requestStageLyricCameraSnap(10);
    } else {
      // 侧栏 (右): 近一点、侧一点，让歌单架打开时有明确的镜头推近。
      orbit.focus.theta  = shelfProfile.portrait ? 0.24 : 0.42;
      orbit.focus.phi    = shelfProfile.portrait ? -0.06 : -0.12;
      orbit.focus.radius = shelfProfile.portrait ? 5.28 : 4.20;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 1.08 : 2.32, shelfProfile.portrait ? -0.18 : -0.10, 0.72);
      camPunch = Math.max(camPunch, 0.82);
    }
  } else if (type === 'shelf-detail') {
    // 歌单架二级详情焦点。
    if (shouldUseWallpaperSafeShelfCamera()) {
      orbit.focus.theta  = shelfProfile.portrait ? 0.16 : 0.26;
      orbit.focus.phi    = shelfProfile.portrait ? -0.02 : 0.02;
      orbit.focus.radius = shelfProfile.portrait ? 5.88 : 5.18;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 0.72 : 2.28, shelfProfile.portrait ? -0.36 : -0.32, 0.84);
      camPunch = Math.max(camPunch, 0.30);
      requestStageLyricCameraSnap(10);
    } else {
      orbit.focus.theta  = shelfProfile.portrait ? 0.16 : 0.34;
      orbit.focus.phi    = shelfProfile.portrait ? -0.03 : -0.06;
      orbit.focus.radius = shelfProfile.portrait ? 5.90 : 4.86;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 0.62 : 1.74, shelfProfile.portrait ? -0.08 : 0.02, 0.82);
      camPunch = Math.max(camPunch, 0.38);
    }
  } else if (type === 'shelf-stage') {
    // 舞台: 居中仰拍
    orbit.focus.theta  = 0.0;
    orbit.focus.phi    = shelfProfile.portrait ? -0.24 : -0.32;
    orbit.focus.radius = shelfProfile.portrait ? 4.8 : 3.8;
    orbit.focus.lookAt.set(0, shelfProfile.portrait ? -1.86 : -1.7, 0.8);
  }
}
// 请求进入或退出某个焦点区，带延迟避免鼠标路过时频繁切镜头。
function setFocusZone(type, immediate) {
  if (type && !shouldUseShelfDynamicCamera(type)) {
    // 配置不允许歌单架动态相机时，shelf 类焦点请求会被清空。
    if (/^shelf-/.test(String(orbit.focus.type || ''))) orbit.focus.active = false;
    type = null;
  }
  if (focusHover.wantType === type) return;
  focusHover.wantType = type;
  if (focusHover.pendingTimer) { clearTimeout(focusHover.pendingTimer); focusHover.pendingTimer = null; }
  if (focusHover.exitTimer) { clearTimeout(focusHover.exitTimer); focusHover.exitTimer = null; }
  if (!type) {
    // 立刻退出 focus, 让相机回主姿态 (但插值是平滑的)
    var exitDelay = 120;
    focusHover.exitTimer = setTimeout(function(){
      focusHover.exitTimer = null;
      if (!focusHover.wantType) orbit.focus.active = false;
    }, exitDelay);
    return;
  }
  if (immediate) {
    // immediate 用于点击打开等明确操作，跳过悬停延迟。
    activateFocusZone(type);
    return;
  }
  // 延迟 500ms 激活
  focusHover.pendingTimer = setTimeout(function(){
    focusHover.pendingTimer = null;
    if (focusHover.wantType !== type) return;
    activateFocusZone(type);
  }, 260);
}

// 电影镜头 v8: 振幅大幅减小, 节拍 punch 加冷却 + 强度门槛
//   - cineTheta/Phi 是非常缓慢的低频漂移, 不再让人 motion sick
//   - punch zoom 只在 真·强主拍 触发, 至少间隔 0.45s, 振幅 ×0.5
// 上一次普通镜头 punch 的时间，用于冷却。
var lastCamPunchAt = -10;
// 普通镜头 punch 最小间隔。
var CAM_PUNCH_MIN_INTERVAL = 0.45;     // 秒
// 普通镜头 punch 强度阈值。
var CAM_PUNCH_BEAT_THRESHOLD = 0.55;   // 必须够强才触发
// 更新电影镜头的低频漂移和节拍偏移。
function updateCinema(dt) {
  // cinemaT 是慢速漂移的时间基准。
  cinemaT += dt;
  // 先更新节拍相机通道，cine 偏移会叠加这些结果。
  updateBeatCamera(dt);
  if (!fx.cinema) {
    // 关闭电影镜头时逐帧衰减残留偏移。
    orbit.cineTheta  *= 0.95;
    orbit.cinePhi    *= 0.95;
    orbit.cineRadius *= 0.95;
    return;
  }
  var damp = orbit.rotating ? 0.25 : 1.0;
  // v8: 振幅减半, 周期更长 (更优雅)
  // DJ 模式下保留更强节拍响应，用户拖动时降低空闲漂移。
  var dj = djMode.active;
  var shake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  var beatDamp = (orbit.focus.active ? (dj ? 0.66 : 0.55) : (dj ? 1.12 : 1.0)) * shake;
  var idleDamp = damp * (dj ? 0.72 : 1.0) * shake;
  orbit.cineTheta  = Math.sin(cinemaT * 0.08) * 0.012 * idleDamp + beatCam.thetaKick * beatDamp;
  orbit.cinePhi    = Math.sin(cinemaT * 0.06 + 1.0) * 0.010 * idleDamp + beatCam.phiKick * beatDamp;
  orbit.cineRadius = Math.sin(cinemaT * 0.04 + 2.0) * 0.080 * idleDamp - beatCam.radiusKick * beatDamp * (dj ? 1.22 : 1.18);
}
// 初始化后立即计算一次相机位置，避免首帧相机未就位。
updateCamera();

// 将视角回到中心并清理所有焦点、粒子旋转和骷髅缩放状态。
function recenterCamera() {
  // 中心锁让后续 updateCamera 使用 baseline 姿态。
  orbit.centerLocked = true;
  orbit.recentering = true;
  clearCenteredViewOffsets();
  if (typeof skullWheelZoomTarget !== 'undefined') {
    // 骷髅滚轮缩放也回到默认值。
    skullWheelZoomTarget = 0;
    if (!(fx && fx.preset === SKULL_PRESET_INDEX)) skullWheelZoom = 0;
  }
  // 同时解除任何镜头跟拍
  if (focusHover) {
    focusHover.wantType = null;
    if (focusHover.pendingTimer) { clearTimeout(focusHover.pendingTimer); focusHover.pendingTimer = null; }
    if (focusHover.exitTimer) { clearTimeout(focusHover.exitTimer); focusHover.exitTimer = null; }
  }
  orbit.focus.active = false;
  if (fx && fx.preset === SKULL_PRESET_INDEX) {
    // 骷髅预设使用专用视角回正逻辑。
    resetSkullPresetView(false, { smooth:true, keepLyricLock:true });
  } else {
    resetSkullPresetView(true);
  }
  if (!(fx && fx.preset === SKULL_PRESET_INDEX) && ((fx && fx.lyricCameraLock) || shouldUseWallpaperLyricCameraLock())) requestStageLyricCameraSnap(14);
  showToast('视角回正');
}

// 判断当前是否存在可交互的播放控制上下文。
function hasActivePlaybackControls() {
  return !!(playing || (audio && !audio.paused) || (Array.isArray(playQueue) && currentIdx >= 0 && playQueue[currentIdx]));
}

// 设置底部控制条软隐藏状态。
function setControlsHidden(hidden) {
  var bar = document.getElementById('bottom-bar');
  if (!bar) return;
  // 鼠标悬停或迷你队列打开时禁止隐藏。
  if (hidden && (controlsHovering || miniQueueOpen)) hidden = false;
  bar.classList.toggle('soft-hidden', !!hidden && controlsAutoHide && bar.classList.contains('visible'));
  bar.style.pointerEvents = '';
  updateControlsChromeState();
}

// 判断底部控制条是否被歌单架交互临时抑制。
function isBottomControlsSuppressedForShelf() {
  // 读取 shelfManager 时加 try，避免模块初始化顺序导致异常。
  var shelfContentOpen = false;
  try {
    shelfContentOpen = !!(typeof shelfManager !== 'undefined' && shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent());
  } catch (e) {}
  return !!(shelfPinnedOpen || shelfContentOpen || (controlsShelfSuppressUntil && performance.now() < controlsShelfSuppressUntil));
}

// 歌单架打开或交互时临时隐藏底部控制条。
function suppressBottomControlsForShelf(duration) {
  // suppressUntil 让鼠标移动短时间内也不会重新唤出控制条。
  controlsShelfSuppressUntil = performance.now() + (duration == null ? 900 : duration);
  controlsHovering = false;
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  if (miniQueueOpen) closeMiniQueue();
  var bar = document.getElementById('bottom-bar');
  if (bar) {
    bar.classList.remove('visible', 'soft-hidden');
    bar.style.pointerEvents = '';
  }
  updateControlsChromeState();
}

// 安排控制条在延迟后软隐藏。
function scheduleControlsHide(delay) {
  if (controlsHideTimer) clearTimeout(controlsHideTimer);
  // 自动隐藏关闭时不排隐藏任务。
  if (!controlsAutoHide) return;
  controlsHideTimer = setTimeout(function(){
    controlsHideTimer = null;
    if (!controlsHovering) setControlsHidden(true);
  }, delay == null ? 480 : delay);
}

// 显示底部控制条，并按自动隐藏设置安排隐藏。
function revealBottomControls(delay) {
  // 全沉浸模式下底部控制条保持完全隐藏。
  if (immersiveMode) return;
  var bar = document.getElementById('bottom-bar');
  // 歌单架抑制期间不显示底部控制条。
  if (isBottomControlsSuppressedForShelf()) return;
  if (bar) bar.classList.add('visible');
  setControlsHidden(false);
  if (controlsAutoHide) scheduleControlsHide(delay == null ? 520 : delay);
}

// 同步 body 的控制条可见状态类名。
function updateControlsChromeState() {
  var bar = document.getElementById('bottom-bar');
  var active = !!(bar && bar.classList.contains('visible') && !bar.classList.contains('soft-hidden'));
  document.body.classList.toggle('controls-visible', active);
}


// 强制恢复播放控制按钮的可交互状态。
function forcePlaybackControlsInteractive() {
  // 没有播放上下文时不强制显示控制条。
  if (!hasActivePlaybackControls()) return;
  try {
    var bar = document.getElementById('bottom-bar');
    if (bar) {
      bar.style.pointerEvents = '';
      if (!controlsAutoHide) {
        bar.classList.add('visible');
        bar.classList.remove('soft-hidden');
      }
    }
    ['play-btn', 'prev-btn', 'next-btn', 'mini-queue-btn', 'play-mode-btn'].forEach(function(id){
      // 清掉可能残留的 busy/disabled，避免宿主桥接命令失败后按钮卡住。
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false;
      btn.classList.remove('busy');
    });
    updateControlsChromeState();
    if (bar && bar.classList.contains('visible') && controlsAutoHide && !controlsHovering) scheduleControlsHide(220);
  } catch (e) {
    console.warn('[PlaybackControlsRestore]', e);
  }
}

// 根据指针位置更新控制条自动隐藏状态。
function updateControlsAutoHideFromPointer(x, y) {
  if (isBottomControlsSuppressedForShelf()) return;
  var bar = document.getElementById('bottom-bar');
  if (!bar || !bar.classList.contains('visible')) return;
  if (!controlsAutoHide) { setControlsHidden(false); return; }
  var fxPanel = document.getElementById('fx-panel');
  var fxFab = document.getElementById('fx-fab');
  var fr = fxPanel ? fxPanel.getBoundingClientRect() : null;
  var br = fxFab ? fxFab.getBoundingClientRect() : null;
  var overFxPanel = fxPanel && (fxPanel.classList.contains('peek') || fxPanel.classList.contains('show')) && fr && x >= fr.left - 18 && x <= fr.right + 18 && y >= fr.top - 18 && y <= fr.bottom + 18;
  var overFxFab = br && x >= br.left - 18 && x <= br.right + 18 && y >= br.top - 18 && y <= br.bottom + 18;
  if (overFxPanel || overFxFab) {
    scheduleControlsHide(80);
    return;
  }
  controlsLastMoveAt = performance.now();
  var rect = bar.getBoundingClientRect();
  var overBar = x >= rect.left - 18 && x <= rect.right + 18 && y >= rect.top - 18 && y <= rect.bottom + 14;
  var mini = document.getElementById('mini-queue-popover');
  var miniRect = mini ? mini.getBoundingClientRect() : null;
  var overMini = miniQueueOpen && miniRect && x >= miniRect.left - 16 && x <= miniRect.right + 16 && y >= miniRect.top - 16 && y <= miniRect.bottom + 16;
  if (overBar || overMini) revealBottomControls(520);
  else scheduleControlsHide(70);
}

// 切换底部控制条自动隐藏偏好。
function toggleControlsAutoHide() {
  controlsAutoHide = !controlsAutoHide;
  // 用户偏好立即持久化。
  saveBooleanPreference(CONTROLS_AUTO_HIDE_STORE_KEY, controlsAutoHide);
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', controlsAutoHide);
  setControlsHidden(false);
  if (controlsAutoHide) {
    scheduleControlsHide(520);
    showToast('控制条自动隐藏已开启');
  } else {
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
    showToast('控制条保持显示');
  }
}

// 将已保存的自动隐藏偏好同步到按钮和当前控制条状态。
function applyControlsAutoHidePreference() {
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', !!controlsAutoHide);
  if (!controlsAutoHide && controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  setControlsHidden(false);
}

// 初始化控制条悬停、离开事件。
(function initControlsAutoHide() {
  var bar = document.getElementById('bottom-bar');
  if (!bar) return;
  // 进入控制条区域时保持显示并取消隐藏计时器。
  function enterControls(){
    controlsHovering = true;
    setControlsHidden(false);
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
  }
  // 离开控制条区域时按自动隐藏策略收起。
  function leaveControls(){
    controlsHovering = false;
    scheduleControlsHide(70);
  }
  bar.addEventListener('mouseenter', enterControls);
  bar.addEventListener('mouseleave', leaveControls);
  updateControlsChromeState();
})();

// 判断当前是否允许鼠标指针自动隐藏。
function isCursorAutoHideMode() {
  return !document.hidden;
}

// 清理鼠标自动隐藏计时器。
function clearCursorAutoHideTimer() {
  if (cursorHideTimer) {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
  }
}

// 设置 body 上的鼠标隐藏类名。
function setCursorHidden(hidden) {
  document.body.classList.toggle('cursor-hidden', !!hidden && isCursorAutoHideMode());
}

// 安排鼠标指针在一段时间无活动后隐藏。
function scheduleCursorHide(delay) {
  clearCursorAutoHideTimer();
  if (!isCursorAutoHideMode()) {
    // 页面隐藏时强制显示状态，避免恢复后指针仍隐藏。
    setCursorHidden(false);
    return;
  }
  cursorHideTimer = setTimeout(function(){
    cursorHideTimer = null;
    setCursorHidden(true);
  }, delay == null ? CURSOR_HIDE_DELAY : delay);
}

// 用户发生鼠标、滚轮或触控活动时显示指针并重新计时。
function revealCursorForActivity() {
  if (!isCursorAutoHideMode()) {
    clearCursorAutoHideTimer();
    setCursorHidden(false);
    return;
  }
  setCursorHidden(false);
  scheduleCursorHide(CURSOR_HIDE_DELAY);
}

// 根据当前页面可见性同步鼠标自动隐藏模式。
function syncCursorAutoHideMode() {
  if (isCursorAutoHideMode()) revealCursorForActivity();
  else {
    clearCursorAutoHideTimer();
    setCursorHidden(false);
  }
}

// 这些全局输入都会唤醒鼠标指针。
['mousemove', 'pointermove', 'mousedown', 'wheel', 'touchstart'].forEach(function(type){
  window.addEventListener(type, revealCursorForActivity, { passive:true, capture:true });
});
syncCursorAutoHideMode();

// ============================================================
//  指针 / 拖拽控制
//   v7.1: 用 userOrbit 替代 targetOrbit; 加 drag 距离判断
// ============================================================
// 当前鼠标在粒子平面上的本地坐标，默认放到远处表示无效。
var mouseWorld = new THREE.Vector3(-999, -999, 0);
// 鼠标是否当前命中粒子交互平面。
var mouseActive = false;
// 鼠标按下位置、时间和是否发生拖拽，用于区分点击与拖动。
var mouseDownAt = { x:0, y:0, t:0, hadDrag:false };
// 粒子拖拽旋转的上一帧指针状态。
var particlePointerSpin = { active:false, lastX:0, lastY:0, lastT:0 };
// 粒子指针命中检测复用对象，避免每次鼠标移动都分配新对象。
var particlePointerRay = new THREE.Raycaster();
var particlePointerNdc = new THREE.Vector2();
var particlePointerPlane = new THREE.Plane();
var particlePointerPlanePoint = new THREE.Vector3();
var particlePointerPlaneNormal = new THREE.Vector3();
var particlePointerWorldHit = new THREE.Vector3();
var particlePointerLocalHit = new THREE.Vector3();
var particlePointerQuat = new THREE.Quaternion();
// 鼠标移动只写入这一帧缓存，主循环再统一计算命中，降低事件处理成本。
var particlePointerFrame = { dirty:false, ndcX:0, ndcY:0 };
// 鼠标按下后移动超过该像素距离视为拖拽，不再触发点击动作。
var CLICK_THRESHOLD = 6;  // 像素, 拖动 > 6px 视为 drag
// 这些 UI 区域会阻止画布拖拽和粒子交互。
var UI_HIT_SELECTOR = '#top-right,#fx-panel,#fx-fab,#bottom-bar,#thumb-wrap,.modal-mask,#toast,#ai-depth-chip,#beat-chip';

// 判断指针是否位于播放器 UI 控件上。
function isPointerOverUi(e) {
  if (!e) return false;
  var el = document.elementFromPoint(e.clientX, e.clientY);
  return !!(el && el.closest && el.closest(UI_HIT_SELECTOR));
}

// 把 NDC 坐标投射到粒子所在平面，输出粒子本地坐标。
function particleLocalPointFromNdc(ndcX, ndcY, out) {
  // 先用主相机生成射线。
  particlePointerNdc.set(ndcX, ndcY);
  particlePointerRay.setFromCamera(particlePointerNdc, camera);
  if (particles) {
    // 粒子存在时使用粒子当前世界位置和朝向构造命中平面。
    particles.updateMatrixWorld(true);
    particles.getWorldPosition(particlePointerPlanePoint);
    particles.getWorldQuaternion(particlePointerQuat);
    particlePointerPlaneNormal.set(0, 0, 1).applyQuaternion(particlePointerQuat).normalize();
    if (Math.abs(particlePointerPlaneNormal.dot(particlePointerRay.ray.direction)) < 0.16) return false;
    particlePointerPlane.setFromNormalAndCoplanarPoint(particlePointerPlaneNormal, particlePointerPlanePoint);
    if (particlePointerRay.ray.intersectPlane(particlePointerPlane, particlePointerWorldHit)) {
      // 命中世界坐标转为粒子本地坐标，shader 鼠标交互使用本地坐标。
      out.copy(particlePointerWorldHit);
      particles.worldToLocal(out);
      return isFinite(out.x) && isFinite(out.y) && Math.abs(out.x) < 8.5 && Math.abs(out.y) < 8.5;
    }
  }
  // 粒子尚未创建时退回 z=0 平面，保证启动早期也有基本交互。
  particlePointerPlaneNormal.set(0, 0, 1);
  particlePointerPlane.set(particlePointerPlaneNormal, 0);
  if (particlePointerRay.ray.intersectPlane(particlePointerPlane, particlePointerWorldHit)) {
    out.copy(particlePointerWorldHit);
    return isFinite(out.x) && isFinite(out.y) && Math.abs(out.x) < 8.5 && Math.abs(out.y) < 8.5;
  }
  return false;
}

// 将屏幕坐标写入待处理的粒子指针帧。
function queueParticlePointerFrame(clientX, clientY) {
  // 转换为 WebGL NDC 坐标。
  var mx = (clientX / innerWidth) * 2 - 1;
  var my = -(clientY / innerHeight) * 2 + 1;
  pointerTarget.x = mx; pointerTarget.y = my;
  particlePointerFrame.ndcX = mx;
  particlePointerFrame.ndcY = my;
  particlePointerFrame.dirty = true;
}

// 主循环中消费待处理的粒子指针帧，并更新 mouseWorld/mouseActive。
function updateParticlePointerFrame() {
  if (!particlePointerFrame.dirty) return;
  particlePointerFrame.dirty = false;
  if (particleLocalPointFromNdc(particlePointerFrame.ndcX, particlePointerFrame.ndcY, particlePointerLocalHit)) {
    // 命中粒子平面时把坐标写给 shader uniform。
    mouseWorld.x = particlePointerLocalHit.x;
    mouseWorld.y = particlePointerLocalHit.y;
    mouseActive = true;
  } else {
    // 未命中时放到远处，shader 会视为没有鼠标交互。
    mouseWorld.set(-999, -999, 0);
    mouseActive = false;
  }
}

// 开始粒子/轨道拖拽。
function beginParticlePointerDrag(e) {
  // 右键不进入拖拽。
  if (e.button === 2) return;
  // UI 上的点击不应该拖动画布。
  if (isPointerOverUi(e)) return;
  markRenderInteraction('canvas-drag', 1200);
  // 空闲引导也需要收到按下事件，用于关闭或反馈。
  idleGuidePointerDown(e);
  orbit.rotating = true; orbit.last.x = e.clientX; orbit.last.y = e.clientY;
  particlePointerSpin.active = true;
  particlePointerSpin.lastX = e.clientX;
  particlePointerSpin.lastY = e.clientY;
  particlePointerSpin.lastT = performance.now();
  if (typeof particleSpin !== 'undefined') particleSpin.vx = particleSpin.vy = 0;
  // 记录按下点，后续判断是否超过点击阈值。
  mouseDownAt.x = e.clientX; mouseDownAt.y = e.clientY;
  mouseDownAt.t = performance.now(); mouseDownAt.hadDrag = false;
}
// 画布自身按下直接开始拖拽。
renderer.domElement.addEventListener('mousedown', function(e){
  beginParticlePointerDrag(e);
});
// 骷髅预设下允许从窗口其他非 UI 区域开始拖拽。
window.addEventListener('mousedown', function(e){
  if (!(fx && fx.preset === SKULL_PRESET_INDEX)) return;
  if (orbit.rotating || e.target === renderer.domElement) return;
  beginParticlePointerDrag(e);
}, true);
// 全局鼠标移动：同时驱动控制条、自由相机、粒子拖拽和鼠标命中。
window.addEventListener('mousemove', function(e){
  updateControlsAutoHideFromPointer(e.clientX, e.clientY);
  idleGuidePointerMove(e);
  if (freeCamera && freeCamera.active) {
    // 自由相机激活时鼠标移动只控制相机视角。
    markRenderInteraction('free-camera', 900);
    var mdx = e.movementX || 0;
    var mdy = e.movementY || 0;
    if ((!mdx && !mdy) && freeCameraPointer.seen) {
      // 没有 movementX/Y 时用前后 clientX/Y 差值兜底。
      mdx = e.clientX - freeCameraPointer.x;
      mdy = e.clientY - freeCameraPointer.y;
    }
    freeCameraPointer.x = e.clientX;
    freeCameraPointer.y = e.clientY;
    freeCameraPointer.seen = true;
    freeCamera.yaw -= mdx * 0.00125;
    freeCamera.pitch = clampRange(freeCamera.pitch - mdy * 0.00125, -Math.PI * 0.49, Math.PI * 0.49);
    return;
  }
  if (isPointerOverUi(e) && !orbit.rotating) { mouseActive = false; return; }
  if (orbit.rotating) {
    // 正在拖拽时更新粒子旋转惯性。
    markRenderInteraction('canvas-drag', 900);
    unlockCenteredView();
    var dx = e.clientX - orbit.last.x, dy = e.clientY - orbit.last.y;
    if (particlePointerSpin.active) {
      // 用移动距离和时间间隔估算拖拽角速度。
      var nowSpin = performance.now();
      var spinDt = Math.max(1 / 120, Math.min(0.08, (nowSpin - particlePointerSpin.lastT) / 1000 || 1 / 60));
      applyParticleSpinDrag(dx, dy, spinDt);
      particlePointerSpin.lastX = e.clientX;
      particlePointerSpin.lastY = e.clientY;
      particlePointerSpin.lastT = nowSpin;
    }
    orbit.last.x = e.clientX; orbit.last.y = e.clientY;
    // drag 距离判断
    var totalDx = e.clientX - mouseDownAt.x, totalDy = e.clientY - mouseDownAt.y;
    if (Math.sqrt(totalDx*totalDx + totalDy*totalDy) > CLICK_THRESHOLD) mouseDownAt.hadDrag = true;
    if (orbit.recentering) orbit.recentering = false;
  }
  queueParticlePointerFrame(e.clientX, e.clientY);
});
// 鼠标释放时结束所有由按下触发的画布拖拽状态。
window.addEventListener('mouseup', function(){
  // 轨道拖拽停止后，后续 mousemove 不再改变相机或粒子惯性。
  orbit.rotating = false;
  // 粒子旋转惯性采样也同步关闭，避免释放后继续写入拖拽速度。
  particlePointerSpin.active = false;
  // 空闲引导需要收到释放事件，用于恢复提示状态或完成点击判断。
  idleGuidePointerUp();
});
// 鼠标离开画布时清理粒子命中状态，避免 shader 继续使用旧坐标。
renderer.domElement.addEventListener('mouseleave', function(){
  // 丢弃尚未被主循环消费的指针帧。
  particlePointerFrame.dirty = false;
  // 把鼠标位置移到远处，让 shader 中的交互距离判断自然失效。
  mouseWorld.set(-999, -999, 0);
  // 标记鼠标已不再作用于粒子平面。
  mouseActive = false;
  // 通知空闲引导鼠标已经离开主舞台区域。
  idleGuidePointerLeave();
});
// 鼠标滚轮在画布上负责缩放当前视觉视角。
renderer.domElement.addEventListener('wheel', function(e){
  // UI 控件上的滚轮操作交给控件自身处理。
  if (isPointerOverUi(e)) return;
  // 阻止页面滚动，确保滚轮只改变 3D 视图。
  e.preventDefault();
  // 滚轮交互期间提高渲染活跃度，避免降帧影响反馈。
  markRenderInteraction('canvas-wheel', 900);
  if (freeCamera && freeCamera.active) {
    // 自由相机模式下滚轮调整视场角，而不是改变轨道半径。
    freeCamera.fov = clampRange((freeCamera.fov || BASE_FOV) + e.deltaY * 0.018, 26, 72);
    // 视场角属于自由相机偏好，立即持久化。
    saveFreeCameraState();
    return;
  }
  if (fx && fx.preset === SKULL_PRESET_INDEX && typeof skullWheelZoomTarget !== 'undefined') {
    // 骷髅预设使用专属缩放目标，避免和通用轨道半径互相覆盖。
    skullWheelZoomTarget = clampRange(skullWheelZoomTarget + e.deltaY * 0.00155, -0.95, 1.28);
    return;
  }
  // 其它预设下滚轮同时唤醒空闲引导和解除居中锁定。
  idleGuideWheel(e);
  unlockCenteredView();
  // 轨道相机半径限制在预设允许范围内，防止穿过或远离舞台。
  orbit.userRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + e.deltaY * 0.005));
  // 用户手动缩放后取消自动回正动画。
  if (orbit.recentering) orbit.recentering = false;
}, { passive:false });

// 双击屏幕回正 — 不命中卡片时
renderer.domElement.addEventListener('dblclick', function(e){
  // 双击 UI 时不触发舞台回正。
  if (isPointerOverUi(e)) return;
  if (freeCamera && freeCamera.locked) {
    // 自由相机锁定状态下双击优先恢复自由相机默认姿态。
    resetFreeCameraToDefault();
    // 骷髅预设同步重置视图，但保留歌词锁定语义。
    resetSkullPresetView(false, { smooth:true, keepLyricLock:true });
    return;
  }
  if (shelfManager && shelfManager.getMode() !== 'off') {
    // 歌单架开启时，先判断双击是否落在卡片上。
    var mx = (e.clientX / innerWidth) * 2 - 1;
    // 屏幕 Y 轴需要翻转为 Three.js 标准化设备坐标。
    var my = -(e.clientY / innerHeight) * 2 + 1;
    // 临时射线只用于本次双击命中测试。
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(mx, my), camera);
    // 命中卡片时让卡片交互接管，不做舞台回正。
    if (shelfManager.raycastCards(rc)) return;
  }
  // 没有命中 UI 或卡片时恢复主视觉相机。
  recenterCamera();
});


