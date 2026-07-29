// ===== js/05-playlist-shelf.js =====

// ============================================================
//  3D 歌单架 — 双模式 (off / side / stage)
//   - side:   现版本精修, 右侧 5 张卡微角度堆叠
//   - stage:  弧形排列, 居中, 有倒影, 当前卡片"呼吸+光环"
//             卡片间粒子穿梭, 切歌时飞出动画
// ============================================================
// 歌单架是否被用户固定展开。
var shelfPinnedOpen = false;
// 歌单架管理器实例，负责创建和更新 3D 卡片。
var shelfManager = null;
// 最近一次打开歌单架的动画起始时间。
var shelfOpenAnimAt = -10;
// 侧边歌单架悬停提示状态，记录目标显隐、当前位置和热区停留时间。
var shelfHoverCue = { target: 0, value: 0, x: 0, y: 0, lastAt: 0, enteredAt: 0, zoneActive: false };
var shelfVisibility = 0;  // 0..1, 侧栏自动隐藏的整体透明度系数
// 判断应用是否已经完成启动揭示，兼容旧入口和迁移后的桥接入口。
function isShelfAppRevealed() {
  // 迁移后的桥接入口没有旧版启动揭示流程，缺失时按已揭示处理。
  return typeof appRevealed === 'undefined' ? true : !!appRevealed;
}
// 判断当前视口是否更适合竖屏歌单架布局。
function isPortraitShelfViewport() {
  return innerHeight > innerWidth * 1.08;
}
// 计算歌单架在当前视口、预设和用户设置下的布局参数。
function shelfLayoutProfile() {
  // 歌单架布局按横竖屏、窄屏和骷髅预设分别收敛，避免卡片压住主视觉或歌词。
  // 是否竖屏。
  var portrait = isPortraitShelfViewport();
  // 横屏但宽度较小的窄屏布局标记。
  var narrow = !portrait && innerWidth < 980;
  // 骷髅预设需要更保守的右侧安全区域。
  var skullShelf = shouldUseSkullSafeShelfCamera();
  // 二级详情面板的基础缩放。
  var detailScale = portrait ? clampRange(innerWidth / 820, 0.70, 0.86) : (narrow ? 0.92 : 1.04);
  // 用户在设置面板中调整的歌单架偏移、角度和大小。
  var shelfCtl = shelfSettings();
  return {
    // 是否竖屏，供调用方复用。
    portrait: portrait,
    // 是否窄屏，供调用方复用。
    narrow: narrow,
    // 侧边模式卡片基准 X 坐标。
    sideX: (skullShelf ? (portrait ? 0.22 : (narrow ? 0.46 : 0.76)) : (portrait ? 1.56 : (narrow ? 2.48 : 3.18))) + shelfCtl.x,
    // 侧边模式卡片基准 Y 坐标。
    sideY: (skullShelf ? (portrait ? -0.22 : (narrow ? -0.30 : -0.34)) : 0) + shelfCtl.y,
    // 侧边模式相邻卡片 X 方向错位。
    sideXStep: skullShelf ? (portrait ? 0.018 : 0.034) : (portrait ? 0.018 : 0.040),
    // 侧边模式相邻卡片 Y 方向错位。
    sideYStep: skullShelf ? (portrait ? 0.46 : 0.62) : (portrait ? 0.52 : 0.68),
    // 侧边模式基准 Z 深度。
    sideZ: (skullShelf ? (portrait ? 0.86 : 0.92) : (portrait ? 0.78 : 0.86)) + shelfCtl.z,
    // 侧边模式相邻卡片 Z 方向错位。
    sideZStep: skullShelf ? (portrait ? 0.108 : 0.158) : (portrait ? 0.118 : 0.170),
    // 侧边模式入场动画的 X 起点偏移。
    sideEntryX: skullShelf ? (portrait ? 0.30 : 0.50) : (portrait ? 0.38 : 0.82),
    // 侧边详情打开时主卡片额外位移。
    sideDetailShift: skullShelf ? (portrait ? 0.00 : 0.00) : (portrait ? 0.38 : 0.82),
    // 侧边模式卡片缩放。
    sideScale: (skullShelf ? (portrait ? 0.84 : (narrow ? 1.04 : 1.22)) : (portrait ? 0.70 : (narrow ? 0.86 : 1))) * shelfCtl.size,
    // 侧边模式卡片 Y 轴旋转。
    sideRotY: (skullShelf ? (portrait ? -0.085 : -0.190) : (portrait ? 0.12 : 0.28)) + shelfCtl.angle,
    // 侧边模式卡片 X 轴俯仰。
    sideRotX: skullShelf ? (portrait ? 0.018 : 0.030) : (portrait ? 0.022 : 0.042),
    // 舞台模式基准 X 坐标。
    stageX: shelfCtl.x,
    // 舞台模式卡片横向间距。
    stageXStep: portrait ? 0.92 : (narrow ? 1.22 : 1.55),
    // 舞台模式基准 Y 坐标。
    stageY: (portrait ? -2.46 : -2.20) + shelfCtl.y,
    // 舞台模式基准 Z 深度。
    stageZ: (portrait ? 0.84 : 1.0) + shelfCtl.z,
    // 舞台模式卡片缩放。
    stageScale: (portrait ? 0.72 : (narrow ? 0.86 : 1)) * shelfCtl.size,
    // 二级内容面板布局参数。
    detail: {
      // 详情面板基准 X 坐标。
      x: (skullShelf ? (portrait ? 0.16 : (narrow ? 0.40 : 0.64)) : (portrait ? 0.38 : (narrow ? 0.96 : 1.28))) + shelfCtl.x * 0.62,
      // 详情面板基准 Y 坐标。
      y: (skullShelf ? (portrait ? -0.40 : -0.68) : (portrait ? 0.10 : 0.18)) + shelfCtl.y * 0.55,
      // 详情面板基准 Z 深度。
      z: (skullShelf ? (portrait ? 1.10 : 1.22) : (portrait ? 1.28 : 1.36)) + shelfCtl.z * 0.45,
      // 详情面板 X 轴旋转。
      rx: skullShelf ? (portrait ? 0.006 : 0.014) : (portrait ? -0.004 : -0.008),
      // 详情面板 Y 轴旋转。
      ry: (skullShelf ? (portrait ? -0.070 : -0.165) : (portrait ? 0.00 : 0.020)) + shelfCtl.angle * 0.55,
      // 详情面板整体缩放。
      scale: (skullShelf ? detailScale * (portrait ? 0.88 : 1.02) : detailScale) * shelfCtl.size,
      // 详情面板内行间距。
      rowStep: skullShelf ? (portrait ? 0.37 : 0.43) : (portrait ? 0.36 : 0.42),
      // 详情面板内行缩放。
      rowScale: skullShelf ? (portrait ? 0.90 : 1.02) : (portrait ? 0.88 : (narrow ? 0.96 : 1.00))
    }
  };
}
// 计算右侧悬停热区宽度。
function shelfHotZoneWidth() {
  // 竖屏热区比例更宽，方便触摸和窄屏操作。
  var ratio = isPortraitShelfViewport() ? 0.26 : 0.18;
  return Math.min(isPortraitShelfViewport() ? 280 : 360, Math.max(148, innerWidth * ratio));
}
// 计算预览可用热区宽度，用于判断侧栏预览是否应继续保持。
function shelfPreviewUseZoneWidth() {
  return Math.min(820, Math.max(shelfHotZoneWidth(), innerWidth * 0.56));
}
// 计算滚轮控制歌单架的右侧热区宽度。
function shelfWheelZoneWidth() {
  // 竖屏滚轮热区略窄，避免影响主体滚动区域。
  var portrait = isPortraitShelfViewport();
  // 按视口比例得到候选宽度。
  var ratioWidth = innerWidth * (portrait ? 0.24 : 0.18);
  return Math.min(portrait ? 280 : 360, Math.max(shelfHotZoneWidth(), ratioWidth));
}
// 判断一次点击是否落在侧边歌单架交互区域。
function isShelfClickZone(e) {
  // 固定展开时扩大点击区域，否则使用悬停热区。
  var edge = shelfPinnedOpen ? Math.min(390, Math.max(210, innerWidth * 0.22)) : shelfHotZoneWidth();
  return e.clientX > innerWidth - edge && e.clientY > 130 && e.clientY < innerHeight - 150;
}
// 判断指针是否处在允许继续使用侧边预览的区域。
function isShelfPreviewUseZone(e) {
  // 预览区比热区宽，允许用户从边缘移向展开卡片。
  var edge = shelfPreviewUseZoneWidth();
  return e.clientX > innerWidth - edge && e.clientY > 96 && e.clientY < innerHeight - 96;
}
// 判断滚轮事件是否应交给歌单架处理。
function isShelfWheelZone(e) {
  // 滚轮区使用独立宽度，减少误拦截主页面滚轮。
  var edge = shelfWheelZoneWidth();
  return e.clientX > innerWidth - edge && e.clientY > 116 && e.clientY < innerHeight - 116;
}
// 判断侧边歌单架在未固定展开时是否仍可显示。
function canUseSideShelfWithoutPinnedOpen() {
  return !!shelfAlwaysVisible();
}
// 判断歌单架预览当前是否可见或正在过渡中。
function shelfPreviewIsVisible() {
  return shelfHoverCue.zoneActive || shelfHoverCue.target > 0 || shelfHoverCue.value > 0.10 || shelfVisibility > 0.12;
}
// 判断自动隐藏状态下的歌单架是否可以响应输入。
function shelfAutoHiddenInputReady() {
  // 固定展开或设置为常显时始终可交互。
  if (shelfPinnedOpen || shelfAlwaysVisible()) return true;
  // 已打开二级内容时保持可交互。
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return true;
  return !!(shelfHoverCue.zoneActive || shelfHoverCue.value > 0.18 || shelfVisibility > 0.16);
}
// 判断当前位置是否可以显示悬停提示；当前版本关闭该提示。
function canShowShelfHoverCueAt(e) {
  return false;
}
// 获取侧边悬停提示热区矩形。
function shelfCueRect() {
  // 热区宽度。
  var w = shelfHotZoneWidth();
  // 热区顶部，避开顶部标题和控制区域。
  var top = Math.max(136, innerHeight * 0.22);
  // 热区高度，避开底部播放控制条。
  var h = Math.min(390, innerHeight - top - 142);
  return { left: innerWidth - w, top: top, width: w, height: h, right: innerWidth, bottom: top + h };
}
// 获取悬停提示热区的视觉中心点。
function shelfCueCenter() {
  // 当前热区矩形。
  var r = shelfCueRect();
  return { x: r.left + r.width * 0.58, y: r.top + r.height * 0.50 };
}
// 根据指针位置更新歌单架悬停提示目标状态。
function updateShelfHoverCueFromPointer(e) {
  if (!e) {
    // 指针离开时重置悬停提示状态。
    shelfHoverCue.target = 0;
    shelfHoverCue.zoneActive = false;
    shelfHoverCue.enteredAt = 0;
    return;
  }
  // 当前指针是否激活提示。
  var active = false;
  // 当前指针是否位于提示热区。
  var inZone = canShowShelfHoverCueAt(e);
  if (inZone && !shelfHoverCue.zoneActive) {
    // 刚进入热区时记录进入时间，用于延迟显示。
    shelfHoverCue.zoneActive = true;
    shelfHoverCue.enteredAt = performance.now();
  } else if (!inZone) {
    // 离开热区时清除停留时间。
    shelfHoverCue.zoneActive = false;
    shelfHoverCue.enteredAt = 0;
  }
  active = inZone;
  // 更新目标显隐和最后指针位置。
  shelfHoverCue.target = active ? 1 : 0;
  shelfHoverCue.x = e.clientX;
  shelfHoverCue.y = e.clientY;
  shelfHoverCue.lastAt = performance.now();
}
// 每帧推进歌单架悬停提示显隐插值。
function tickShelfHoverCue(dt) {
  if (shelfHoverCue.zoneActive) {
    // 用最近一次指针位置重新验证热区，避免窗口尺寸变化后状态滞留。
    var heldPointer = { clientX: shelfHoverCue.x, clientY: shelfHoverCue.y };
    if (canShowShelfHoverCueAt(heldPointer)) {
      // 停留超过阈值后才显示提示，降低误触发。
      if (performance.now() - shelfHoverCue.enteredAt > 260) shelfHoverCue.target = 1;
    } else {
      // 热区失效时立即收起提示。
      shelfHoverCue.zoneActive = false;
      shelfHoverCue.enteredAt = 0;
      shelfHoverCue.target = 0;
    }
  }
  // 指针长时间未更新时收起提示。
  if (!shelfHoverCue.zoneActive && performance.now() - shelfHoverCue.lastAt > 650) shelfHoverCue.target = 0;
  // 当前目标值。
  var target = shelfHoverCue.target;
  // 显示和隐藏使用略不同的速度。
  var rate = target > shelfHoverCue.value ? 0.12 : 0.10;
  // 根据帧间隔推进 value。
  shelfHoverCue.value += (target - shelfHoverCue.value) * Math.min(1, rate * Math.max(1, dt * 60));
  // 接近 0 时吸附为 0，避免残留透明度。
  if (shelfHoverCue.value < 0.006 && !target) shelfHoverCue.value = 0;
  return shelfHoverCue.value;
}
// 设置歌单架是否固定展开。
function setShelfPinnedOpen(open, immediate) {
  // 归一化目标展开状态。
  var nextOpen = !!open;
  // 展开歌单架时暂时压制底部控制条，避免互相遮挡。
  if (nextOpen && typeof suppressBottomControlsForShelf === 'function') suppressBottomControlsForShelf(980);
  if (nextOpen && !shelfPinnedOpen) {
    // 使用 shader 时间作为动画时间基准。
    var nowT = uniforms && uniforms.uTime ? uniforms.uTime.value : performance.now() / 1000;
    // 如果预览已经可见，则打开动画从更靠后的进度开始，避免重复入场。
    var previewVisible = shelfHoverCue.value > 0.28 || shelfVisibility > 0.20;
    shelfOpenAnimAt = previewVisible ? nowT - 0.62 : nowT;
    // 固定展开后收起悬停提示。
    shelfHoverCue.target = 0;
    shelfHoverCue.zoneActive = false;
    shelfHoverCue.enteredAt = 0;
  }
  // 写入固定展开状态。
  shelfPinnedOpen = nextOpen;
  // 主提示在歌单架固定或打开内容时隐藏。
  var hint = document.getElementById('hint');
  if (hint) hint.classList.toggle('shelf-hidden', shelfPinnedOpen || !!(shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()));
  // 已打开二级内容时不切换焦点区，避免打断内容交互。
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return;
  // 同步相机焦点区。
  if (typeof setFocusZone === 'function') setFocusZone(shelfPinnedOpen ? 'shelf-side' : null, immediate);
}
// 指针离开或模式重置时清理侧边歌单架预览状态。
function clearShelfPreviewOnPointerExit() {
  // 只处理 side 模式。
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return;
  // 是否有二级内容打开。
  var hasContent = shelfManager.hasOpenContent && shelfManager.hasOpenContent();
  // 清空悬停提示和预览透明度。
  updateShelfHoverCueFromPointer(null);
  shelfHoverCue.target = 0;
  shelfHoverCue.value = 0;
  shelfHoverCue.zoneActive = false;
  shelfHoverCue.enteredAt = 0;
  // 隐藏侧边悬停标签。
  if (typeof setShelfHoverTabVisible === 'function') setShelfHoverTabVisible(false);
  // 清除当前选中卡片。
  if (shelfManager && shelfManager.clearSelected) shelfManager.clearSelected();
  // 如果有内容面板，安全关闭。
  if (hasContent && shelfManager.closeContent) safeShelfCloseContent('shelf-mode-reset');
  // 固定展开时同步关闭固定状态。
  if (shelfPinnedOpen) setShelfPinnedOpen(false, true);
  // 常驻模式下不清零可见度，避免鼠标离开时歌单架闪烁。
  if (!shelfAlwaysVisible()) {
    shelfVisibility = 0;
  }
  // 清空相机焦点区。
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
}
// 切歌时压制侧边预览，避免新歌开始时旧卡片仍浮出。
function suppressShelfPreviewForPlaybackSwitch() {
  // 只处理 side 模式。
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return;
  // 固定展开或已有内容时不强制收起。
  if (shelfPinnedOpen || (shelfManager.hasOpenContent && shelfManager.hasOpenContent())) return;
  // 清空悬停提示和选择。
  updateShelfHoverCueFromPointer(null);
  shelfHoverCue.target = 0;
  shelfHoverCue.value = 0;
  shelfHoverCue.zoneActive = false;
  shelfHoverCue.enteredAt = 0;
  shelfVisibility = 0;
  if (typeof setShelfHoverTabVisible === 'function') setShelfHoverTabVisible(false);
  if (shelfManager && shelfManager.clearSelected) shelfManager.clearSelected();
  // 切歌后焦点回到主视觉。
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
}
function makeShelfManager() {
  // 歌单架管理器只暴露交互和刷新接口；内部维护 Three.js 组、卡片窗口、二级列表和舞台装饰。
  // 歌单架 Three.js 根组。
  var group = null;
  // 当前实际渲染出来的卡片窗口。
  var cards = [];          // [{canvas, ctx, texture, mesh, item, index, slot}]
  // 当前歌单架可展示的完整条目列表。
  var allItems = [];
  // 只渲染中心附近的一小段卡片窗口，长队列不会一次性创建所有 canvas/texture/mesh。
  // 当前窗口在 allItems 中的起始索引。
  var renderedStart = -1;
  // 中心卡片前后各保留的可见半径。
  var SHELF_VISIBLE_RADIUS = 5;
  // 单次最多渲染的卡片数。
  var SHELF_MAX_RENDER = SHELF_VISIBLE_RADIUS * 2 + 1;
  // 二级面板切换动画起始时间。
  var paneSwitchAt = -10;
  // 二级面板切换方向。
  var paneSwitchDir = 1;
  // 歌单架显示模式，默认侧边模式。
  var mode = 'side';
  // 上一次条目签名，用于判断是否需要重建卡片窗口。
  var lastSig = '';
  // 上一次整体更新的时间戳。
  var lastUpdate = 0;
  // 上一次卡片重绘时间。
  var lastCardRedrawAt = -10;
  // 上一次用于卡片节奏脉冲的桶值。
  var lastCardPulseBucket = -1;
  // 分帧构建卡片的队列状态。
  var cardBuildQueue = null;
  // 当前鼠标或键盘选中的卡片索引。
  var selectedIdx = -1;

  // v7.2 PSP 风格状态
  var centerIdx = 0;          // 当前居中卡片 index (在 items 数组中的位置)
  var centerTarget = 0;       // 目标 centerIdx (插值)
  var centerSmooth = 0;       // 当前实际 centerIdx 平滑值
  var openCardIdx = -1;       // 已打开内容框的卡片 (-1 表示无)
  var contentList = null;     // 二级 PSP 滚动列表 manager
  // 舞台模式中连接卡片的粒子装饰。
  var connectorParticles = null;
  // 舞台模式地面倒影网格。
  var floorMirror = null;

  // 根据播放队列生成歌单架条目列表。
  function currentItems() {
    if (playQueue.length) {
      // 播放队列中的每首歌映射为一个 queue 类型卡片。
      return playQueue.map(function(song, idx){
        return { type:'queue', title: song.name, sub: song.artist || '未知歌手',
          cover: songCoverSrc(song, 360), tag: idx === currentIdx ? '正在播放' : ('#' + (idx+1)), queueIndex: idx };
      });
    }
    // 无播放队列时歌单架为空。
    return [];
  }

  // 在 canvas 上构造圆角矩形路径。
  function makeRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  // 按最大宽度和最大行数在 canvas 上绘制自动换行文本。
  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    // 逐字拆分，适配中文没有空格分词的标题。
    var chars = String(text || '').split('');
    // 当前行文本和最终行数组。
    var line = '', lines = [];
    for (var i = 0; i < chars.length; i++) {
      // 尝试把当前字符追加到当前行。
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        // 超出宽度时换行。
        lines.push(line); line = chars[i];
        // 预留最后一行后停止继续收集。
        if (lines.length >= maxLines - 1) break;
      } else line = test;
    }
    // 收尾时把最后一行加入列表。
    if (line && lines.length < maxLines) lines.push(line);
    // 逐行绘制文本。
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], x, y + j * lineHeight);
  }
  // 生成卡片绘制签名，用于判断 canvas 内容是否需要重绘。
  function cardDrawSignature(card, item) {
    item = item || {};
    // 封面缓存记录。
    var rec = item.cover ? playlistCoverCache[item.cover] : null;
    // 封面加载状态参与签名，加载完成后可触发重绘。
    var coverState = item.cover ? (rec && rec.loaded ? 'ready' : (rec && rec.failed ? 'fail' : 'wait')) : 'none';
    // 中心卡片根据节奏脉冲分桶，避免每帧都重绘 canvas。
    var pulseBucket = card && card.isCenter ? Math.round((bass + beatPulse * 0.85) * 6) : 0;
    return [
      item.type || '', item.title || '', item.sub || '', item.tag || '',
      item.playlistId || '', item.queueIndex == null ? '' : item.queueIndex,
      item.cover || '', coverState, card && card.isCenter ? 1 : 0, card && card.selected ? 1 : 0,
      card && card.dofBucket == null ? -1 : card.dofBucket, pulseBucket, shelfAccentHex(), shelfSettings().bgOpacity
    ].join('|');
  }

  // 重绘单张歌单架卡片的 canvas 贴图。
  function drawCard(card, item) {
    item = item || card.item || {};
    // 绘制签名没有变化时跳过重绘，降低 canvas 和纹理上传成本。
    var nextDrawKey = cardDrawSignature(card, item);
    if (card.drawKey === nextDrawKey) return;
    card.drawKey = nextDrawKey;
    // 当前卡片 canvas、上下文和尺寸。
    var cv = card.canvas, ctx = card.ctx;
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    // 卡片内边距。
    var pad = 18;
    // 当前卡片是否对应正在播放的歌曲。
    var isNow = item.type === 'queue' && item.tag === '正在播放';
    // 当前歌单架视觉设置。
    var shelfLook = shelfSettings();

    // 卡片底
    makeRoundRect(ctx, pad, pad, W - pad*2, H - pad*2, 32);
    // 背景透明度来自歌单架设置。
    ctx.fillStyle = 'rgba(0,0,0,' + shelfLook.bgOpacity.toFixed(3) + ')'; ctx.fill();
    // 轻微玻璃高光渐变。
    var grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(255,255,255,0.018)');
    ctx.fillStyle = grad; ctx.fill();

    if (isNow) {
      // 正在播放卡片使用强调色和节奏相关描边宽度。
      ctx.strokeStyle = shelfAccentRgba(0.72);
      ctx.lineWidth = 1.8 + Math.sin(uniforms.uTime.value * 3) * 0.28 + bass * 1.2;
    } else {
      // 普通卡片使用低对比描边。
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1.1;
    }
    ctx.stroke();

    if (card.selected) {
      // 选中态额外绘制一层带阴影的强调描边。
      ctx.save();
      makeRoundRect(ctx, pad + 2, pad + 2, W - pad*2 - 4, H - pad*2 - 4, 30);
      ctx.shadowColor = shelfAccentRgba(0.58);
      ctx.shadowBlur = 18;
      ctx.strokeStyle = shelfAccentRgba(0.72);
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }

    // 大封面方块
    // 封面区域尺寸。
    var coverSize = H - pad*2 - 8;
    // 封面区域左上角坐标。
    var cx = pad + 6, cy = pad + 4;
    makeRoundRect(ctx, cx, cy, coverSize, coverSize, 26);
    ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fill();
    if (item.cover) {
      // 读取或请求队列封面缓存。
      var rec = playlistCoverCache[item.cover];
      if (rec && rec.loaded && rec.img) {
        // 封面加载完成后裁剪到圆角区域内绘制。
        ctx.save(); makeRoundRect(ctx, cx, cy, coverSize, coverSize, 26); ctx.clip();
        ctx.drawImage(rec.img, cx, cy, coverSize, coverSize); ctx.restore();
      } else if (!rec || (!rec.loading && !rec.failed)) {
        // 尚未加载时发起异步请求，回调里重绘当前卡片。
        requestPlaylistCover(item.cover, function(){ drawCard(card, item); });
      }
    }

    // 文本区
    // 文本区域起始 X 坐标。
    var tx = pad + coverSize + 32;
    ctx.font = '700 17px Inter, Arial';
    ctx.fillStyle = isNow ? shelfAccentRgba(0.92) : 'rgba(255,255,255,0.92)';
    ctx.fillText(item.tag || '', tx, pad + 36);

    // 标题文本，最多两行。
    ctx.font = '700 30px Inter, Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    wrapText(ctx, item.title || '', tx, pad + 78, W - tx - pad - 14, 36, 2);

    // 副标题文本，通常是歌手。
    ctx.font = '400 17px Inter, Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.52)';
    wrapText(ctx, item.sub || '', tx, pad + 156, W - tx - pad - 14, 24, 2);

    // 律动进度条
    // 底部短线随 bass 延长，正在播放时使用强调色。
    ctx.strokeStyle = isNow ? shelfAccentRgba(0.90) : 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(tx, H - pad - 22);
    ctx.lineTo(tx + Math.min(260, 80 + bass * 320), H - pad - 22);
    ctx.stroke();

    if (card.isCenter) {
      // 中心卡片显示当前可执行动作提示。
      var actionY = H - pad - 78;
      if (item.type === 'playlist') {
        // 在线歌单入口已移除，保留说明。
        ctx.font = '800 14px Inter, "Microsoft YaHei", Arial';
        ctx.fillStyle = 'rgba(255,255,255,0.58)';
        ctx.fillText('在线歌单已移除', tx, actionY + 25);
      } else if (item.type === 'queue') {
        // 队列卡片中心态显示点击播放提示。
        ctx.font = '600 14px Inter, "Microsoft YaHei", Arial';
        ctx.fillStyle = shelfAccentRgba(0.84);
        ctx.fillText('点击播放', tx, actionY + 25);
      }
    }

    // 景深模糊在 canvas 侧用暗层近似，减少 shader 复杂度。
    var dof = card.dofBlur || 0;
    if (dof > 0.12) {
      makeRoundRect(ctx, pad, pad, W - pad*2, H - pad*2, 32);
      ctx.fillStyle = 'rgba(0,0,0,' + Math.min(0.28, dof * 0.18).toFixed(3) + ')';
      ctx.fill();
    }

    // 通知 Three.js 上传更新后的 canvas 纹理。
    card.texture.needsUpdate = true;
  }

  // 构建单张 3D 歌单架卡片。
  function buildOneCard(item, i) {
    // 每张卡片是一张 canvas 贴图加一个平面网格；重绘 canvas 后通过 texture.needsUpdate 推给 GPU。
    // 卡片 canvas。
    var cv = document.createElement('canvas');
    cv.width = 720; cv.height = 360;
    // 卡片绘制上下文。
    var ctx = cv.getContext('2d');
    // 由 canvas 创建的 Three.js 纹理。
    var tx = new THREE.CanvasTexture(cv);
    tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
    tx.generateMipmaps = false;
    // 卡片材质使用透明基础材质，避免参与光照。
    var mat = new THREE.MeshBasicMaterial({ map: tx, transparent: true, opacity: 0.96, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    // 卡片平面几何尺寸与 canvas 宽高比一致。
    var geo = new THREE.PlaneGeometry(2.05, 1.025, 1, 1);
    // 卡片网格。
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 50 + i;
    // 点击命令写在 userData 中，射线命中后按这里执行。
    mesh.userData.action = item.type === 'queue' ? { kind:'playQueue', index: item.queueIndex } : { kind:'empty' };
    group.add(mesh);
    // 卡片运行期状态。
    var card = { canvas: cv, ctx: ctx, texture: tx, mesh: mesh, item: item, index: i, isCenter: false, selected: i === selectedIdx, floatMix: 0, fxPulse: 0, dofBlur: 0, dofBucket: -1, drawKey: '' };
    return card;
  }

  // 主动预热纹理上传，减少首次显示时的 GPU 上传卡顿。
  function warmTextureUpload(tex) {
    if (!tex || !renderer || typeof renderer.initTexture !== 'function') return;
    try { renderer.initTexture(tex); } catch (e) {}
  }

  // 取消正在分帧构建的卡片队列。
  function cancelCardBuildQueue() {
    if (!cardBuildQueue) return;
    // 标记取消，防止已排队的下一帧继续构建。
    cardBuildQueue.cancelled = true;
    if (cardBuildQueue.raf) cancelAnimationFrame(cardBuildQueue.raf);
    cardBuildQueue = null;
  }

  // 销毁当前窗口内已经渲染的卡片和关联资源。
  function disposeRenderedCards() {
    cancelCardBuildQueue();
    while (group && group.children.length) {
      // 从组中取出一个子对象。
      var ch = group.children.pop();
      // 释放材质和纹理，避免频繁重建窗口造成显存泄漏。
      if (ch.material) { if (ch.material.map) ch.material.map.dispose(); ch.material.dispose(); }
      // 释放几何体资源。
      if (ch.geometry) ch.geometry.dispose();
    }
    // 清空卡片数组。
    cards = [];
    // 标记当前没有有效渲染窗口。
    renderedStart = -1;
  }

  // 将卡片构建任务拆到空闲帧执行。
  function scheduleQueuedCardBuild(job) {
    // 异步建卡每批最多处理少量项目，把 canvas 绘制和纹理上传拆散到空闲帧，减少打开歌单架时的卡顿。
    // 单次空闲帧构建步骤。
    function step(deadline) {
      // 队列被取消或管理器销毁时停止。
      if (!job || job.cancelled || cardBuildQueue !== job || !group) return;
      // 本批开始时间，用于控制单帧耗时。
      var started = performance.now();
      // 本批已构建数量。
      var built = 0;
      while (job.next <= job.end && built < 2 && performance.now() - started < 7) {
        // 构建当前窗口中的下一张卡片。
        var card = buildOneCard(allItems[job.next], job.next);
        cards.push(card);
        drawCard(card, card.item);
        warmTextureUpload(card.texture);
        job.next += 1;
        built += 1;
      }
      if (job.next <= job.end) {
        // 仍有剩余卡片时继续排队到空闲帧或下一帧。
        if (window.requestIdleCallback) {
          requestIdleCallback(step, { timeout: 180 });
        } else {
          job.raf = requestAnimationFrame(step);
        }
      } else {
        // 全部构建完成后清空队列状态。
        cardBuildQueue = null;
      }
    }
    // 优先使用 requestIdleCallback，降级到 RAF。
    if (window.requestIdleCallback) requestIdleCallback(step, { timeout: 180 });
    else job.raf = requestAnimationFrame(step);
  }

  // 同步当前中心卡片附近的渲染窗口。
  function syncRenderedWindow(force, asyncBuild) {
    // 根据 centerTarget 计算当前可见窗口；窗口未变化时只补绘内容变化的卡片，窗口变化时整体重建。
    if (!group) return;
    // 全量条目数。
    var total = allItems.length;
    if (!total) { disposeRenderedCards(); return; }
    // 当前中心索引取整。
    var center = Math.round(centerTarget);
    // 可见窗口起点。
    var start = Math.max(0, center - SHELF_VISIBLE_RADIUS);
    // 可见窗口终点。
    var end = Math.min(total - 1, start + SHELF_MAX_RENDER - 1);
    // 靠近队尾时回推起点，保持窗口尽量满。
    start = Math.max(0, end - SHELF_MAX_RENDER + 1);
    if (!force && start === renderedStart && cards.length === (end - start + 1)) {
      // 窗口未变化时只检查条目引用变化并局部重绘。
      cards.forEach(function(c) {
        // 当前卡片索引对应的新条目。
        var nextItem = allItems[c.index] || c.item;
        if (c.item !== nextItem) {
          c.item = nextItem;
          c.drawKey = '';
          drawCard(c, c.item);
        }
      });
      return;
    }
    // 窗口变化时销毁旧窗口。
    disposeRenderedCards();
    // 记录新窗口起点。
    renderedStart = start;
    if (asyncBuild) {
      // 异步构建队列状态。
      cardBuildQueue = { start:start, end:end, next:start, cancelled:false, raf:0 };
      scheduleQueuedCardBuild(cardBuildQueue);
      return;
    }
    // 同步构建窗口内全部卡片。
    for (var itemIdx = start; itemIdx <= end; itemIdx++) {
      // 构建并绘制单张卡片。
      var card = buildOneCard(allItems[itemIdx], itemIdx);
      cards.push(card);
      drawCard(card, card.item);
    }
  }

  // 重建歌单架当前内容和模式相关附加物。
  function rebuild(asyncCards) {
    // 队列、主题或模式发生变化时重建歌单架；舞台附加物和二级列表会跟随当前模式重新初始化。
    if (!group) return;
    // 先释放当前窗口卡片。
    disposeRenderedCards();
    if (connectorParticles) {
      // 清理舞台连接粒子。
      if (connectorParticles.parent) connectorParticles.parent.remove(connectorParticles);
      if (connectorParticles.geometry) connectorParticles.geometry.dispose();
      if (connectorParticles.material) connectorParticles.material.dispose();
      connectorParticles = null;
    }
    if (floorMirror) {
      // 清理舞台地面倒影。
      if (floorMirror.parent) floorMirror.parent.remove(floorMirror);
      if (floorMirror.geometry) floorMirror.geometry.dispose();
      if (floorMirror.material) floorMirror.material.dispose();
      floorMirror = null;
    }
    // 从当前播放队列重新生成条目。
    allItems = currentItems();
    // 保存新条目签名。
    lastSig = sig(allItems);
    // 让下次 tick 重新计算卡片重绘节流。
    lastCardRedrawAt = -10;
    lastCardPulseBucket = -1;
    // center 起始 = currentIdx (如果是 queue), 否则 0
    if (allItems.length && allItems[0].type === 'queue' && currentIdx >= 0) {
      // 队列模式默认居中到当前播放歌曲。
      centerTarget = Math.min(allItems.length - 1, currentIdx);
      centerSmooth = centerTarget;
      centerIdx = centerTarget;
    } else if (centerTarget >= allItems.length) {
      // 条目减少后把中心索引夹回有效范围。
      centerTarget = Math.max(0, allItems.length - 1);
      centerSmooth = centerTarget;
    }
    // 选中索引越界时清空选中。
    if (selectedIdx >= allItems.length) selectedIdx = -1;
    // 按最新中心同步渲染窗口。
    syncRenderedWindow(true, !!asyncCards);
    if (mode === 'stage') {
      // 舞台模式需要创建粒子连接和倒影等附加物。
      createStageExtras();
    }
  }

  // ====================================================
  //  PSP 弧形布局: 以 centerSmooth 为基准, 卡片绕弧排列
  //  i 距离 center 越远 → 越靠后, 越小, 越淡
  // ====================================================
  // 根据当前模式和中心索引摆放一张卡片。
  function placeCard(card, i, totalCards, modeIs) {
    var delta = card.index - centerSmooth;     // 正=下方, 负=上方
    // 与中心卡片的绝对距离。
    var absD = Math.abs(delta);
    // 隐藏太远的卡 (>4 全隐藏)
    if (absD > SHELF_VISIBLE_RADIUS + 0.5) { card.mesh.visible = false; return; }
    card.mesh.visible = true;
    // 中心附近卡片 renderOrder 更高，保证叠放关系稳定。
    card.mesh.renderOrder = 60 + Math.round((SHELF_VISIBLE_RADIUS + 1 - Math.min(absD, SHELF_VISIBLE_RADIUS + 1)) * 10);
    // 当前指针视差 X。
    var parX = pointerParallax.x || 0;
    // 当前指针视差 Y。
    var parY = pointerParallax.y || 0;
    // 卡片离中心越远，指针视差影响越小。
    var parWeight = Math.max(0, 1 - absD * 0.16);
    // 卡片点击或节奏触发的额外脉冲。
    var pulse = card.fxPulse || 0;
    // 当前响应式布局参数。
    var layout = shelfLayoutProfile();
    // 当前歌单架视觉设置。
    var shelfLook = shelfSettings();
    // 离中心越远景深越强。
    var nextDof = Math.max(0, Math.min(1, (absD - 0.45) / 3.2));
    // 景深分桶，只有桶变化才重绘 canvas。
    var nextDofBucket = Math.round(nextDof * 5);
    if (card.dofBucket !== nextDofBucket) {
      // 写入新的景深状态并触发卡片贴图重绘。
      card.dofBucket = nextDofBucket;
      card.dofBlur = nextDof;
      drawCard(card, card.item);
    }

    if (modeIs === 'side') {
      // 右侧 3D 架: 恢复更靠近、更斜切的打开姿态，让卡片有真正的前后层次。
      // 侧边二级内容是否打开。
      var detailOpenSide = contentList && contentList.isOpen();
      // 当前 shader 时间。
      var nowT = uniforms.uTime.value;
      // 未固定且未打开详情时，用整体可见度驱动轻微呼吸。
      var hoverBreath = (!shelfPinnedOpen && !detailOpenSide) ? shelfVisibility : 0;
      // 常显但未固定时使用更低的渲染层级。
      var passiveAlways = shelfAlwaysVisible() && !shelfPinnedOpen && !detailOpenSide;
      // 选中卡片的浮起目标值。
      var liftTarget = card.selected && !detailOpenSide ? 1 : 0;
      // 浮起和回落使用不同速率。
      var liftRate = liftTarget > (card.floatMix || 0) ? 0.20 : 0.13;
      card.floatMix = (card.floatMix || 0) + (liftTarget - (card.floatMix || 0)) * liftRate;
      if (!liftTarget && card.floatMix < 0.004) card.floatMix = 0;
      // 当前浮起插值。
      var lift = card.floatMix || 0;
      // 侧边层级权重，中心附近更靠前。
      var sideLayer = Math.max(0, SHELF_VISIBLE_RADIUS + 1 - Math.min(absD, SHELF_VISIBLE_RADIUS + 1));
      card.mesh.renderOrder = passiveAlways
        ? (30 + Math.round(sideLayer * 1.1) + Math.round(lift * 96))
        : (60 + Math.round(sideLayer * 10) + Math.round(lift * 70));
      // 侧边悬停呼吸强度。
      var breathPulse = hoverBreath * (0.5 + 0.5 * Math.sin(nowT * 1.22 + card.index * 0.74));
      // 打开动画原始进度。
      var revealRaw = Math.max(0, Math.min(1, (nowT - shelfOpenAnimAt - absD * 0.035) / 0.62));
      // 打开动画平滑进度。
      var reveal = revealRaw * revealRaw * (3 - 2 * revealRaw);
      // 入场偏移强度。
      var entry = (1 - reveal) * (0.82 + absD * 0.075);
      // 二级面板切换动画原始进度。
      var paneRaw = Math.max(0, Math.min(1, (nowT - paneSwitchAt - absD * 0.030) / 0.72));
      // 二级面板切换残余偏移强度。
      var paneEase = 1 - paneRaw * paneRaw * (3 - 2 * paneRaw);
      // 壁纸预设的安全歌单架姿态。
      var wallpaperShelfPose = shouldUseWallpaperSafeShelfCamera();
      // 骷髅预设的安全歌单架姿态。
      var skullShelfPose = shouldUseSkullSafeShelfCamera();
      // 任一安全姿态启用时，减少旋转和位移侵入主视觉。
      var safeShelfPose = wallpaperShelfPose || skullShelfPose;
      // 侧边卡片 X 坐标。
      var px = layout.sideX + absD * layout.sideXStep - (detailOpenSide ? layout.sideDetailShift : 0) + entry * layout.sideEntryX;
      // 侧边卡片 Y 坐标。
      var py = (layout.sideY || 0) - delta * layout.sideYStep + (1 - reveal) * (delta < 0 ? -0.18 : 0.18);
      // 侧边卡片 Z 坐标。
      var pz = layout.sideZ - absD * layout.sideZStep - (1 - reveal) * 0.20;
      // 二级面板切换时给卡片一个横向让位偏移。
      px += paneEase * paneSwitchDir * 0.60;
      py += paneEase * (delta < 0 ? -0.16 : 0.16);
      pz -= paneEase * 0.22;
      // 叠加指针视差。
      px += parX * 0.060 * parWeight;
      py += parY * 0.046 * parWeight;
      pz += (parY * 0.026 - parX * 0.028) * parWeight;
      // 悬停预览时给卡片轻微漂浮。
      py += Math.sin(nowT * 0.92 + card.index * 0.64) * 0.052 * hoverBreath * Math.max(0.20, parWeight);
      pz += Math.cos(nowT * 0.78 + card.index * 0.52) * 0.030 * hoverBreath * parWeight;
      if (lift > 0.001) {
        // 选中卡片略微向用户方向浮起。
        px -= lift * (skullShelfPose ? 0.035 : (layout.portrait ? 0.065 : 0.145));
        py += lift * (skullShelfPose ? 0.045 : (layout.portrait ? 0.075 : 0.105));
        pz += lift * (skullShelfPose ? 0.080 : 0.220);
      }
      // 侧边卡片最终缩放。
      var scale = (absD < 0.5 ? 1.12 : Math.max(0.55, 1.04 - absD * 0.14)) * (0.88 + reveal * 0.12) * (1 + pulse * 0.056 + breathPulse * 0.026 + lift * (skullShelfPose ? 0.045 : 0.075)) * layout.sideScale;
      if (wallpaperShelfPose) scale *= 1.22;
      else if (skullShelfPose) scale *= 1.04;
      card.mesh.position.set(px, py, pz);
      if (skullShelfPose && camera) {
        // 骷髅安全姿态使用相机朝向作为基准，再叠加轻微旋转。
        card.mesh.quaternion.copy(camera.quaternion);
        card.mesh.rotateX(layout.sideRotX - delta * 0.008 - parY * 0.004 * parWeight);
        card.mesh.rotateY(layout.sideRotY + (1 - reveal) * 0.012 + parX * 0.006 * parWeight);
      } else {
        // 普通和壁纸姿态直接写欧拉角。
        var safeRotY = wallpaperShelfPose ? 0.12 : layout.sideRotY;
        var safeEntryRotY = wallpaperShelfPose ? 0.05 : 0.16;
        card.mesh.rotation.y = (safeShelfPose ? safeRotY : layout.sideRotY) + (1 - reveal) * safeEntryRotY + parX * (safeShelfPose ? 0.014 : 0.038) * parWeight;
        var safeRotX = wallpaperShelfPose ? 0.020 : layout.sideRotX;
        card.mesh.rotation.x = -delta * (safeShelfPose ? safeRotX : layout.sideRotX) - parY * (safeShelfPose ? 0.010 : 0.024) * parWeight;
      }
      card.mesh.scale.setScalar(scale);
      // 详情打开时弱化主卡片交互感。
      var disabledByDetail = detailOpenSide;
      // 基于中心距离计算基础透明度。
      var opacity = absD < 0.5 ? 1.0 : Math.max(0.22, 1.0 - absD * 0.30);
      if (disabledByDetail) {
        // 内容打开后原卡片退到背景。
        opacity *= card.index === openCardIdx ? 0.16 : 0.08;
        card.mesh.material.color.setScalar(card.index === openCardIdx ? 0.42 : 0.25);
      } else {
        // 常显状态略微压低亮度，选中浮起时恢复。
        if (passiveAlways) opacity *= 0.92 + lift * 0.08;
        card.mesh.material.color.setScalar(passiveAlways ? (0.96 + lift * 0.04) : 1);
      }
      // v8: 自动隐藏 — shelf 不在 focus 区时整体淡化
      card.mesh.material.opacity = Math.min(1, opacity * (shelfVisibility != null ? shelfVisibility : 1) * reveal * (1 - paneEase * 0.24) + pulse * 0.10 * reveal + breathPulse * 0.035) * shelfLook.opacity;
      setCardCenter(card, absD < 0.5);
    } else {
      // 舞台 PSP: 水平展开 + center 突出, dock 在底部
      // 舞台模式 X 坐标。
      var pxStage = (layout.stageX || 0) + delta * layout.stageXStep;
      // 舞台模式 Y 坐标。
      var pyStage = layout.stageY;
      // 舞台模式 Z 坐标，中心卡更靠前。
      var pzStage = absD < 0.5 ? layout.stageZ : (layout.stageZ - Math.min(2.0, absD) * 0.55);
      // 舞台二级面板切换原始进度。
      var paneRawS = Math.max(0, Math.min(1, (uniforms.uTime.value - paneSwitchAt - absD * 0.030) / 0.72));
      // 舞台二级面板切换残余偏移强度。
      var paneEaseS = 1 - paneRawS * paneRawS * (3 - 2 * paneRawS);
      pxStage += paneEaseS * paneSwitchDir * 0.80;
      pzStage -= paneEaseS * 0.28;
      // 叠加舞台模式指针视差。
      pxStage += parX * 0.110 * parWeight;
      pyStage += parY * 0.060 * parWeight;
      pzStage += (parY * 0.040 - parX * 0.035) * parWeight;
      // 舞台卡片最终缩放。
      var scaleS = (absD < 0.5 ? 1.20 : Math.max(0.45, 1.0 - absD * 0.22)) * (1 + pulse * 0.060) * layout.stageScale;
      card.mesh.position.set(pxStage, pyStage, pzStage);
      card.mesh.rotation.y = -delta * 0.22 + parX * 0.050 * parWeight;
      card.mesh.rotation.x = 0.10 - absD * 0.04 - parY * 0.028 * parWeight;
      card.mesh.scale.setScalar(scaleS);
      // 舞台详情打开状态。
      var disabledStage = contentList && contentList.isOpen();
      // 舞台卡片基础透明度。
      var opS = absD < 0.5 ? 1.0 : Math.max(0.18, 1.0 - absD * 0.32);
      if (disabledStage) {
        // 详情打开后舞台卡片退到背景。
        opS *= card.index === openCardIdx ? 0.16 : 0.08;
        card.mesh.material.color.setScalar(card.index === openCardIdx ? 0.42 : 0.25);
      } else {
        card.mesh.material.color.setScalar(1);
      }
      card.mesh.material.opacity = Math.min(1, opS * (shelfVisibility != null ? shelfVisibility : 1) * (1 - paneEaseS * 0.24) + pulse * 0.10) * shelfLook.opacity;
      setCardCenter(card, absD < 0.5);
    }
  }

  // 同步卡片是否为中心态，并在状态变化时重绘贴图。
  function setCardCenter(card, isCenter) {
    if (card.isCenter !== isCenter) {
      card.isCenter = isCenter;
      drawCard(card, card.item);
    } else {
      card.isCenter = isCenter;
    }
  }

  // 处理在线歌单卡片点击；当前版本该功能已移除。
  function playPlaylistCard(card) {
    // 即使功能移除，也保留一次卡片脉冲作为点击反馈。
    if (card) pulseCard(card, 1.05);
    showToast('在线歌单功能已移除');
    return true;
  }

  // 给卡片施加一次可衰减的视觉脉冲。
  function pulseCard(card, amount) {
    if (!card) return;
    pulseObjectValue(card, 'fxPulse', amount || 1, 0.46);
  }

  // 创建舞台模式专用的连接粒子和底部倒影。
  function createStageExtras() {
    if (!group) return;
    // 连接粒子数量。
    var pcount = 80;
    // 连接粒子几何体。
    var pgeo = new THREE.BufferGeometry();
    // 粒子位置数组。
    var ppos = new Float32Array(pcount * 3);
    // 粒子颜色数组。
    var pcol = new Float32Array(pcount * 3);
    // 粒子随机种子数组。
    var prnd = new Float32Array(pcount);
    for (var i = 0; i < pcount; i++) {
      // 粒子在舞台底部附近随机散布。
      ppos[i*3] = (Math.random() - 0.5) * 6;
      ppos[i*3+1] = (Math.random() - 0.5) * 1.2 + 0.3;
      ppos[i*3+2] = 1.0 + Math.random() * 1.5;
      // 使用偏青色的连接粒子。
      pcol[i*3] = 0.56; pcol[i*3+1] = 0.91; pcol[i*3+2] = 1.0;
      // 每个粒子保存一个随机相位。
      prnd[i] = Math.random();
    }
    // 写入粒子几何属性。
    pgeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
    pgeo.setAttribute('aColor',   new THREE.BufferAttribute(pcol, 3));
    pgeo.setAttribute('aRand',    new THREE.BufferAttribute(prnd, 1));
    // 舞台连接粒子材质，直接使用 uTime 驱动漂浮。
    var pmat = new THREE.ShaderMaterial({
      uniforms:{ uTime: uniforms.uTime, uPixel: uniforms.uPixel, uDotTex: uniforms.uDotTex },
      vertexShader:`precision highp float; uniform float uTime, uPixel; attribute vec3 aColor; attribute float aRand;
varying vec3 vC; varying float vA;
void main(){
  vec3 p = position;
  p.x += sin(uTime * 0.4 + aRand * 6.0) * 1.5;
  p.y += sin(uTime * 0.6 + aRand * 4.0) * 0.2;
  p.z += cos(uTime * 0.5 + aRand * 5.0) * 0.4;
  vC = aColor; vA = 0.4 + 0.4 * sin(uTime * 1.5 + aRand * 7.0);
  vec4 m = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = 4.0 * uPixel;
  gl_Position = projectionMatrix * m;
}`,
      fragmentShader:`precision highp float; uniform sampler2D uDotTex;
varying vec3 vC; varying float vA;
void main(){ vec4 t = texture2D(uDotTex, gl_PointCoord); if (t.a < 0.02) discard; gl_FragColor = vec4(vC, t.a * vA); }`,
      transparent:true, depthWrite:false, blending: THREE.AdditiveBlending,
    });
    // 连接粒子点云对象。
    connectorParticles = new THREE.Points(pgeo, pmat);
    connectorParticles.frustumCulled = false;
    connectorParticles.renderOrder = 49;
    connectorParticles.position.set(0, -2.2, 0);
    // 粒子挂到歌单架同级，避免继承卡片组的全部变换。
    if (group.parent) group.parent.add(connectorParticles); else scene.add(connectorParticles);
    // 底部地面反射
    // 倒影平面几何。
    var mGeo = new THREE.PlaneGeometry(10, 1.8);
    // 倒影渐变贴图 canvas。
    var mCanvas = document.createElement('canvas'); mCanvas.width = 256; mCanvas.height = 64;
    // 倒影 canvas 绘制上下文。
    var mctx = mCanvas.getContext('2d');
    // 从上到下淡出的白色渐变。
    var mg = mctx.createLinearGradient(0, 0, 0, 64);
    mg.addColorStop(0, 'rgba(255,255,255,0.07)'); mg.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = mg; mctx.fillRect(0, 0, 256, 64);
    // 倒影贴图。
    var mTex = new THREE.CanvasTexture(mCanvas);
    mTex.generateMipmaps = false;
    // 倒影材质。
    var mMat = new THREE.MeshBasicMaterial({ map: mTex, transparent:true, depthWrite:false, opacity:0.55 });
    // 倒影网格。
    floorMirror = new THREE.Mesh(mGeo, mMat);
    floorMirror.position.set(0, -2.85, 0.4);
    floorMirror.rotation.x = -Math.PI / 2;
    // 倒影同样挂到歌单架同级。
    if (group.parent) group.parent.add(floorMirror); else scene.add(floorMirror);
  }

  // 生成当前歌单架内容签名，用于判断是否需要重建。
  function sig(items) {
    // 未传入条目时，根据播放队列构造轻量签名条目。
    items = items || playQueue.map(function(song, idx){
      return { type:'queue', title: song.name, queueIndex: idx };
    });
    // 只采样首尾少量条目，避免长队列每次拼接过大字符串。
    var sample = items.slice(0, 3).concat(items.slice(Math.max(3, items.length - 3)));
    return ['queue', items.length, currentIdx, sample.map(function(it){ return [it.type, it.playlistId||'', it.queueIndex||'', it.title||''].join('|'); }).join('||')].join('::');
  }

  // 应用当前选中索引，并刷新受影响卡片。
  function applySelectedIndex(idx) {
    // 选中索引归一化，负数表示无选中。
    idx = idx == null || idx < 0 ? -1 : Math.round(idx);
    selectedIdx = idx;
    cards.forEach(function(c) {
      // 当前卡片是否应进入选中态。
      var next = c.index === selectedIdx;
      if (c.selected !== next) {
        c.selected = next;
        drawCard(c, c.item);
      }
    });
  }

  // 歌单架中心卡片按方向步进。
  function step(direction) {
    if (!allItems.length) return;
    // 步进前的目标中心索引。
    var prevTarget = Math.round(centerTarget);
    // 夹紧到条目范围内的新目标中心索引。
    centerTarget = Math.max(0, Math.min(allItems.length - 1, centerTarget + direction));
    // 步进后的目标中心索引。
    var nextTarget = Math.round(centerTarget);
    // 中心变化可能跨出当前窗口，需要同步渲染窗口。
    syncRenderedWindow(false);
    // 选中步进后的中心卡片。
    applySelectedIndex(nextTarget);
    // 实际变化时播放选择反馈。
    if (nextTarget !== prevTarget) playShelfSelectTick(direction, 'card');
    // 给目标卡片一次轻脉冲。
    pulseCard(cards.find(function(c){ return c.index === nextTarget; }), 0.55);
  }

  // 用屏幕坐标粗略命中一张 3D 卡片的投影矩形。
  function screenHitCard(card, sx, sy, pad) {
    // 无效、不可见或管理器未显示时不命中。
    if (!card || !card.mesh || !card.mesh.visible || !group || !group.visible) return null;
    // 读取平面几何尺寸。
    var params = card.mesh.geometry && card.mesh.geometry.parameters || {};
    // 半宽。
    var hw = (params.width || 1.7) / 2;
    // 半高。
    var hh = (params.height || 0.85) / 2;
    // 卡片四角本地坐标。
    var pts = [
      new THREE.Vector3(-hw, -hh, 0),
      new THREE.Vector3( hw, -hh, 0),
      new THREE.Vector3( hw,  hh, 0),
      new THREE.Vector3(-hw,  hh, 0),
    ];
    // 投影后的屏幕包围盒。
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    card.mesh.updateMatrixWorld(true);
    for (var i = 0; i < pts.length; i++) {
      // 世界坐标投影到 NDC，再转成屏幕像素坐标。
      pts[i].applyMatrix4(card.mesh.matrixWorld).project(camera);
      var x = (pts[i].x + 1) * innerWidth / 2;
      var y = (1 - pts[i].y) * innerHeight / 2;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // 命中扩展边距，便于侧边卡片点击。
    pad = pad == null ? 28 : pad;
    if (sx < minX - pad || sx > maxX + pad || sy < minY - pad || sy > maxY + pad) return null;
    // 计算近似 UV，供后续区分卡片内区域。
    var u = clampRange((sx - minX) / Math.max(1, maxX - minX), 0, 1);
    var v = 1 - clampRange((sy - minY) / Math.max(1, maxY - minY), 0, 1);
    return { x: u, y: v };
  }

  // 按屏幕坐标从前到后拾取一张歌单架卡片。
  function pickCardAtScreen(sx, sy, pad) {
    // 无卡片或歌单架不可见时无法拾取。
    if (!cards.length || !group || !group.visible) return null;
    // 按 renderOrder 从前到后排序，优先命中视觉最前面的卡。
    var ordered = cards.slice().sort(function(a, b){ return (b.mesh.renderOrder || 0) - (a.mesh.renderOrder || 0); });
    for (var i = 0; i < ordered.length; i++) {
      // 使用扩展边距做屏幕矩形命中。
      var uv = screenHitCard(ordered[i], sx, sy, pad == null ? 72 : pad);
      if (uv) return { card: ordered[i], uv: uv, screenPick: true };
    }
    return null;
  }

  // 暴露给外部的歌单架控制接口。
  return {
    // 切换歌单架模式，并按需创建或销毁 Three.js 组。
    setMode: function(m) {
      if (m === mode && group) return;
      mode = m;
      if (m === 'off') {
        // 关闭模式下释放卡片和舞台附加资源。
        if (group) { scene.remove(group); cards.forEach(function(c){ c.texture.dispose(); c.mesh.material.dispose(); c.mesh.geometry.dispose(); }); }
        if (connectorParticles) { scene.remove(connectorParticles); connectorParticles.geometry.dispose(); connectorParticles.material.dispose(); connectorParticles = null; }
        if (floorMirror) { scene.remove(floorMirror); floorMirror.geometry.dispose(); floorMirror.material.dispose(); floorMirror = null; }
        group = null; cards = [];
        if (contentList) contentList.close();
        return;
      }
      if (!group) {
        // 首次启用时创建歌单架根组。
        group = new THREE.Group();
        group.renderOrder = 50;
        scene.add(group);
      }
      // 模式切换后同步重建卡片和附加物。
      rebuild(false);
    },
    // 获取当前歌单架模式。
    getMode: function(){ return mode; },
    // 每帧更新歌单架动画、显隐和内容刷新。
    update: function(dt) {
      if (!group) return;
      // PSP 滚动平滑
      centerSmooth += (centerTarget - centerSmooth) * 0.16;
      if (Math.abs(centerSmooth - centerTarget) < 0.001) centerSmooth = centerTarget;
      // 当前指针视差。
      var px = pointerParallax.x, py = pointerParallax.y;
      // 悬停提示显隐进度。
      var cueVis = tickShelfHoverCue(dt);
      // 侧栏只在右侧停留时淡入。
      // 本帧目标可见度。
      var targetVis;
      if (mode === 'side') {
        // 二级内容打开状态。
        var contentOpen = contentList && contentList.isOpen();
        if (!allItems.length && !contentOpen) targetVis = 0;
        else targetVis = (contentOpen || shelfPinnedOpen || shelfAlwaysVisible()) ? 1.0 : (cueVis > 0.01 ? Math.max(0.16, cueVis * 0.88) : 0);
      } else {
        targetVis = allItems.length ? 1.0 : 0;
      }
      // 平滑逼近目标可见度。
      shelfVisibility += (targetVis - shelfVisibility) * (targetVis > shelfVisibility ? 0.22 : 0.18);
      if (shelfVisibility < 0.01 && targetVis === 0) shelfVisibility = 0;
      // 根组可见性同时受启动揭示、模式和内容状态控制。
      group.visible = isShelfAppRevealed() && (mode !== 'side' || shelfVisibility > 0) && (allItems.length > 0 || (contentList && contentList.isOpen()));
      if (connectorParticles) connectorParticles.visible = group.visible && mode === 'stage';
      if (floorMirror) floorMirror.visible = group.visible && mode === 'stage';
      if (mode === 'side') {
        // 常显但未固定时，组层级更低，避免抢占主视觉。
        var passiveAlwaysGroup = shelfAlwaysVisible() && !shelfPinnedOpen && !(contentList && contentList.isOpen());
        // 有卡片浮起时临时提高层级。
        var liftedCardActive = passiveAlwaysGroup && cards.some(function(c){ return c.selected || (c.floatMix || 0) > 0.025; });
        group.renderOrder = passiveAlwaysGroup && !liftedCardActive ? 30 : 50;
        group.position.set(0, 0, 0);
        // 常显歌单架可轻微绑定主封面旋转。
        var bindToCover = shelfAlwaysVisible() && particles && particles.rotation && !(contentList && contentList.isOpen());
        if (bindToCover) {
          group.rotation.x += ((particles.rotation.x - py * 0.010) - group.rotation.x) * 0.075;
          group.rotation.y += ((particles.rotation.y + px * 0.018) - group.rotation.y) * 0.075;
          group.rotation.z += (particles.rotation.z - group.rotation.z) * 0.075;
        } else {
          group.rotation.y += ((px * 0.018) - group.rotation.y) * 0.045;
          group.rotation.x += ((-py * 0.010) - group.rotation.x) * 0.045;
          group.rotation.z += (0 - group.rotation.z) * 0.045;
        }
      } else {
        // 舞台模式让整组有轻微漂浮和指针视差。
        group.renderOrder = 50;
        var t = uniforms.uTime.value;
        group.position.y = Math.sin(t * 0.3) * 0.04;
        group.position.x = px * 0.10;
        group.rotation.y = px * 0.025;
        group.rotation.x = -py * 0.012;
      }
      // 逐张摆放卡片。
      for (var i = 0; i < cards.length; i++) {
        placeCard(cards[i], i, cards.length, mode);
      }
      // 内容更新 (节流)
      // 卡片文字、封面和节拍光效不用每帧重绘，节流后只在签名变化或脉冲桶变化时刷新贴图。
      if (uniforms.uTime.value - lastUpdate > 0.8) {
        lastUpdate = uniforms.uTime.value;
        // 当前内容签名。
        var nextSig = sig();
        if (nextSig !== lastSig) rebuild();
        else {
          // 节奏脉冲分桶，用于节流卡片重绘。
          var pulseBucket = Math.round((bass + beatPulse * 0.85) * 10);
          // 播放中刷新更频繁，暂停时降低频率。
          var redrawInterval = playing ? 1.35 : 4.0;
          if (pulseBucket !== lastCardPulseBucket || uniforms.uTime.value - lastCardRedrawAt > redrawInterval) {
            lastCardPulseBucket = pulseBucket;
            lastCardRedrawAt = uniforms.uTime.value;
            cards.forEach(function(c){
              // 同步条目引用和中心态，必要时重绘。
              c.item = allItems[c.index] || c.item;
              c.isCenter = Math.abs(c.index - centerSmooth) < 0.5;
              if (c.isCenter || c.dofBucket <= 1 || c.index === currentIdx) drawCard(c, c.item);
            });
          }
        }
      }
      // 二级内容框 update
      if (contentList) contentList.update(dt);
    },
    // 当前封面变化后触发歌单架重建，刷新队列卡封面。
    onCoverChange: function() {
      if (group && mode !== 'off' && uniforms.uTime.value - lastUpdate > 0.2) {
        lastUpdate = uniforms.uTime.value;
        rebuild();
      }
    },
    // 暴露重建函数给安全包装和外部调度器。
    rebuild: rebuild,
    // 刷新主题相关绘制，例如强调色和背景透明度。
    refreshTheme: function() {
      cards.forEach(function(c) {
        c.drawKey = '';
        drawCard(c, c.item);
      });
      if (contentList && contentList.refreshTheme) contentList.refreshTheme();
    },
    // 使用 Three.js 射线拾取可见卡片。
    raycastCards: function(raycaster) {
      if (!group || !group.visible || !cards.length) return null;
      // 只把可见 mesh 交给射线检测。
      var visibleMeshes = cards.filter(function(c){ return c.mesh.visible; }).map(function(c){ return c.mesh; });
      // 射线命中结果。
      var hits = raycaster.intersectObjects(visibleMeshes, false);
      if (!hits.length) return null;
      // 命中的卡片状态对象。
      var card = cards.find(function(c){ return c.mesh === hits[0].object; });
      return { card: card, point: hits[0].point, uv: hits[0].uv };
    },
    // 屏幕坐标拾取卡片。
    pickCardAtScreen: pickCardAtScreen,
    // PSP 步进
    // 移到下一张卡。
    next: function() { step(1); },
    // 移到上一张卡。
    prev: function() { step(-1); },
    // 按给定方向滚动。
    scrollBy: function(d) { step(d); },
    // 获取当前中心卡片索引。
    getCenterIdx: function() { return Math.round(centerSmooth); },
    // 获取指定索引对应的已渲染卡片。
    getCardAt: function(idx) { return cards.find(function(c){ return c.index === idx; }); },
    // 获取当前已渲染卡片数组。
    getCards: function() { return cards; },
    // 播放指定索引的在线歌单卡片；当前只保留移除提示。
    playPlaylistAt: function(idx) {
      return playPlaylistCard(cards.find(function(c){ return c.index === idx; }));
    },
    // 清空当前选中卡片。
    clearSelected: function() {
      applySelectedIndex(-1);
    },
    // 设置当前选中卡片。
    setSelected: function(idx) {
      applySelectedIndex(idx);
    },
    // 执行卡片 userData 中记录的动作。
    triggerAction: function(action) {
      if (!action) return;
      // 找到动作对应的卡片用于反馈。
      var card = cards.find(function(c) { return c.mesh.userData.action === action; });
      pulseCard(card, action.kind === 'loadPlaylist' ? 1.0 : 0.70);
      if (action.kind === 'playQueue') {
        // 队列卡片直接播放指定队列项。
        playQueueAt(action.index);
      } else if (action.kind === 'loadPlaylist') {
        // 在线歌单动作保留内容框入口兼容旧结构。
        if (!contentList) contentList = makeContentListManager();
        openCardIdx = card ? card.index : -1;
        contentList.open(action.playlistId, action.title || (card && card.item.title), card);
        setShelfPinnedOpen(true, true);
        if (typeof setFocusZone === 'function') setFocusZone('shelf-detail', true);
      } else if (action.kind === 'empty') {
        // 空卡片打开底部迷你队列。
        setMiniQueueOpen(true);
      }
    },
    // 二级内容框 open/close
    // 打开指定卡片的二级内容，或对队列卡片直接播放。
    openContent: function(cardIdx) {
      // 查找目标卡片。
      var card = cards.find(function(c){ return c.index === cardIdx; });
      if (!card) return;
      // 卡片动作描述。
      var action = card.mesh.userData.action;
      if (!action) return;
      pulseCard(card, 1.0);
      // queue 类型 → 直接播放, 不需要内容框
      if (action.kind === 'playQueue') {
        playQueueAt(action.index);
        return;
      }
      if (action.kind === 'loadPlaylist') {
        // 在线歌单内容列表兼容旧逻辑。
        if (!contentList) contentList = makeContentListManager();
        openCardIdx = card.index;
        contentList.open(action.playlistId, action.title || card.item.title, card);
        setShelfPinnedOpen(true, true);
        if (typeof setFocusZone === 'function') setFocusZone('shelf-detail', true);
      }
      if (action.kind === 'empty') setMiniQueueOpen(true);
    },
    // 关闭二级内容框。
    closeContent: function() {
      // 清空打开卡片索引。
      openCardIdx = -1;
      if (contentList) contentList.close();
      // 恢复主提示显隐。
      var hint = document.getElementById('hint');
      if (hint) hint.classList.toggle('shelf-hidden', shelfPinnedOpen);
      // 焦点区回到侧边歌单架或主视觉。
      if (typeof setFocusZone === 'function') setFocusZone(shelfPinnedOpen ? 'shelf-side' : null, true);
    },
    // 判断是否有二级内容打开。
    hasOpenContent: function() { return contentList && contentList.isOpen(); },
    // 获取二级内容管理器。
    getContentList: function() { return contentList; },
    // 获取当前打开二级内容的卡片索引。
    getOpenContentIndex: function() { return openCardIdx; },
    // 当前歌单架是否可交互。
    canInteract: function() { return mode !== 'off' && allItems.length > 0; }
  };
}
// 创建全局歌单架管理器实例。
shelfManager = makeShelfManager();
// 安全重建歌单架，捕获异常避免影响主播放流程。
function safeShelfRebuild(reason, asyncCards) {
  if (!shelfManager || typeof shelfManager.rebuild !== 'function') return false;
  try {
    shelfManager.rebuild(asyncCards);
    return true;
  } catch (e) {
    console.warn('[ShelfRebuild]', reason || 'unknown', e);
    return false;
  }
}
// 延迟重建歌单架的调度状态。
var deferredShelfRebuild = { raf: 0, reason: '', asyncCards: true, token: 0 };
// 延迟调度歌单架重建，把重活放到 UI 预热任务中执行。
function scheduleShelfRebuild(reason, asyncCards) {
  // 记录最近一次重建原因。
  deferredShelfRebuild.reason = reason || deferredShelfRebuild.reason || 'deferred';
  // 默认使用异步建卡。
  deferredShelfRebuild.asyncCards = asyncCards !== false;
  // token 用于让旧调度失效。
  deferredShelfRebuild.token += 1;
  // 当前调度 token。
  var token = deferredShelfRebuild.token;
  if (deferredShelfRebuild.raf) cancelAnimationFrame(deferredShelfRebuild.raf);
  deferredShelfRebuild.raf = requestAnimationFrame(function(){
    deferredShelfRebuild.raf = 0;
    scheduleUiWarmTask(function(){
      // 只有最新调度可以执行。
      if (token !== deferredShelfRebuild.token) return;
      safeShelfRebuild(deferredShelfRebuild.reason, deferredShelfRebuild.asyncCards);
    }, 260);
  });
}
// 安全关闭歌单架二级内容。
function safeShelfCloseContent(reason) {
  if (!shelfManager || typeof shelfManager.closeContent !== 'function') return false;
  try {
    shelfManager.closeContent();
    return true;
  } catch (e) {
    console.warn('[ShelfCloseContent]', reason || 'unknown', e);
    return false;
  }
}
// 窗口失焦时清理歌单架预览状态。
window.addEventListener('blur', clearShelfPreviewOnPointerExit);
// 鼠标离开文档时清理歌单架预览状态。
document.addEventListener('mouseleave', clearShelfPreviewOnPointerExit);
// 兼容部分浏览器只触发 mouseout 的离开文档场景。
document.addEventListener('mouseout', function(e) {
  if (!e.relatedTarget && !e.toElement) clearShelfPreviewOnPointerExit();
});

// ============================================================
//  二级内容框 (旧在线歌单内容已移除) — 同样 PSP 风格滚动
// ============================================================
// 创建歌单架二级内容列表管理器。
function makeContentListManager() {
  // 二级内容 Three.js 根组。
  var group = null;
  // 当前渲染的歌曲行卡片。
  var rows = [];           // 每行一张卡 (歌曲)
  // 背景面板对象。
  var panel = null;
  // 二级内容中的完整歌曲列表。
  var allTracks = [];
  // 当前行渲染窗口起点。
  var renderedStart = -1;
  // 二级内容可见行半径。
  var CONTENT_VISIBLE_RADIUS = 5;
  // 二级内容最多渲染行数。
  var CONTENT_MAX_RENDER = CONTENT_VISIBLE_RADIUS * 2 + 1;
  // 二级内容是否打开。
  var open = false;
  // 内容列表目标中心和实际平滑中心。
  var centerTarget = 0, centerSmooth = 0;
  // 当前二级内容标题。
  var playlistTitle = '';
  // 打开二级内容的来源卡片。
  var sourceCard = null;
  // 异步请求 token，用于防止旧请求回写。
  var requestToken = 0;
  // 打开动画起始时间。
  var openAnimAt = -10;
  // 行动画起始时间。
  var rowAnimAt = -10;
  // 面板和行的脏标记。
  var panelDirty = true, rowsDirty = true;
  // 最近面板和行绘制时间。
  var panelDrawAt = -10, rowDrawAt = -10;
  // 加载态动画刷新间隔。
  var LOADING_ANIM_INTERVAL = 1 / 30;
  // 二级内容默认布局参数。
  var DETAIL_BASE = { x: 1.28, y: 0.18, z: 1.36, rx: -0.008, ry: 0.020 };
  // 获取当前二级内容布局，优先使用歌单架响应式布局。
  function detailLayout() {
    return shelfLayoutProfile().detail || DETAIL_BASE;
  }

  // 在 canvas 中创建圆角矩形路径。
  function makeRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  // 将文本缩短到指定宽度，超出时追加省略号。
  function ellipsize(ctx, text, maxWidth) {
    text = String(text || '');
    if (ctx.measureText(text).width <= maxWidth) return text;
    // 逐字符裁剪直到省略号也能放入宽度。
    var out = text;
    while (out.length > 1 && ctx.measureText(out + '...').width > maxWidth) out = out.slice(0, -1);
    return out + '...';
  }
  // 获取 canvas 绘制用强调色。
  function canvasAccent(alpha, fallback) {
    return shelfAccentRgba(alpha, fallback);
  }

  // 确保二级内容背景面板已创建。
  function ensurePanel() {
    if (panel || !group) return;
    // 面板 canvas。
    var cv = document.createElement('canvas');
    cv.width = 900; cv.height = 1024;
    // 面板 canvas 纹理。
    var tx = new THREE.CanvasTexture(cv);
    tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
    tx.generateMipmaps = false;
    // 面板材质。
    var mat = new THREE.MeshBasicMaterial({ map:tx, transparent:true, opacity:0.86, depthWrite:false, depthTest:false, side:THREE.DoubleSide });
    // 面板平面几何。
    var geo = new THREE.PlaneGeometry(2.62, 3.02, 1, 1);
    // 面板网格。
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(-0.02, 0.0, 0.20);
    mesh.renderOrder = 232;
    group.add(mesh);
    // 保存面板运行期对象。
    panel = { canvas:cv, texture:tx, mesh:mesh };
  }

  // 绘制二级内容背景面板。
  function drawPanel() {
    ensurePanel();
    if (!panel) return;
    // 面板 canvas 上下文。
    var ctx = panel.canvas.getContext('2d');
    // 面板画布尺寸。
    var W = panel.canvas.width, H = panel.canvas.height;
    ctx.clearRect(0, 0, W, H);
    makeRoundRect(ctx, 24, 28, W - 48, H - 56, 34);
    // 背景渐变。
    var bg = ctx.createLinearGradient(0, 0, W, H);
    // 面板背景透明度来自歌单架设置。
    var panelBgAlpha = shelfSettings().bgOpacity;
    bg.addColorStop(0, 'rgba(0,0,0,' + Math.min(0.98, panelBgAlpha + 0.02).toFixed(3) + ')');
    bg.addColorStop(0.42, 'rgba(0,0,0,' + panelBgAlpha.toFixed(3) + ')');
    bg.addColorStop(1, 'rgba(0,0,0,' + Math.max(0.20, panelBgAlpha - 0.04).toFixed(3) + ')');
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.font = '800 38px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = 'rgba(255,246,220,0.94)';
    ctx.fillText(ellipsize(ctx, playlistTitle || '队列详情', W - 310), 72, 92);
    ctx.font = '500 18px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = canvasAccent(0.62);
    // 可播放歌曲数量。
    var playableCount = allTracks.filter(function(song){ return song && song.id; }).length;
    // 当前是否为加载占位内容。
    var isLoading = allTracks.length === 1 && isLoadingLabel(allTracks[0] && allTracks[0].name);
    // 歌曲数量或加载/空态文案。
    var countLabel = playableCount ? (playableCount + ' 首歌曲') : (isLoading ? '正在载入' : '暂无可播放歌曲');
    ctx.fillText(countLabel, 74, 128);
    // 来源卡片封面地址。
    var coverUrl = sourceCard && sourceCard.item && sourceCard.item.cover;
    // 右上角封面尺寸和位置。
    var coverSize = 96, coverX = W - 172, coverY = 56;
    makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 22);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    if (coverUrl) {
      // 封面缓存。
      var coverRec = playlistCoverCache[coverUrl];
      if (coverRec && coverRec.loaded && coverRec.img) {
        // 封面可用时裁剪到圆角区域。
        ctx.save();
        makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 22);
        ctx.clip();
        ctx.drawImage(coverRec.img, coverX, coverY, coverSize, coverSize);
        ctx.restore();
      } else if (!coverRec || (!coverRec.loading && !coverRec.failed)) {
        // 封面未加载时异步请求，完成后重绘面板。
        requestPlaylistCover(coverUrl, function(){ drawPanel(); });
      }
    }
    // 顶部分割线高光扫动进度。
    var sweep = (Math.sin((uniforms.uTime.value || 0) * 1.7) + 1) * 0.5;
    // 分割线渐变。
    var shine = ctx.createLinearGradient(70, 154, W - 80, 154);
    shine.addColorStop(0, canvasAccent(0));
    shine.addColorStop(Math.max(0.01, sweep * 0.72), canvasAccent(0.14));
    shine.addColorStop(Math.min(0.99, sweep * 0.72 + 0.14), canvasAccent(0.56));
    shine.addColorStop(1, canvasAccent(0));
    ctx.fillStyle = shine;
    ctx.fillRect(72, 154, W - 144, 2);
    // 标记面板纹理需要上传。
    panel.texture.needsUpdate = true;
  }

  // 释放一个二级内容面板对象。
  function disposePanelObject(targetPanel) {
    if (!targetPanel) return;
    // 从场景中移除 mesh。
    if (targetPanel.mesh && targetPanel.mesh.parent) targetPanel.mesh.parent.remove(targetPanel.mesh);
    // 释放纹理。
    if (targetPanel.texture) targetPanel.texture.dispose();
    // 释放材质。
    if (targetPanel.mesh && targetPanel.mesh.material) targetPanel.mesh.material.dispose();
    // 释放几何体。
    if (targetPanel.mesh && targetPanel.mesh.geometry) targetPanel.mesh.geometry.dispose();
  }

  // 释放当前二级内容面板。
  function disposePanel() {
    disposePanelObject(panel);
    panel = null;
  }

  // 判断文本是否为加载占位。
  function isLoadingLabel(text) {
    return /加载中|正在载入/.test(String(text || ''));
  }

  // 判断当前二级内容是否只有加载占位。
  function isLoadingContent() {
    return allTracks.length === 1 && isLoadingLabel(allTracks[0] && allTracks[0].name);
  }

  // 在面板脏或加载动画需要刷新时绘制面板。
  function drawPanelIfNeeded(force, nowT) {
    nowT = nowT == null ? (uniforms.uTime.value || 0) : nowT;
    if (!force && !panelDirty && (!isLoadingContent() || nowT - panelDrawAt < LOADING_ANIM_INTERVAL)) return;
    drawPanel();
    panelDirty = false;
    panelDrawAt = nowT;
  }

  // 绘制二级内容中的一行歌曲卡片。
  function drawRow(row, song, isCenter) {
    // 行 canvas 和上下文。
    var cv = row.canvas, ctx = cv.getContext('2d');
    // 行画布尺寸。
    var W = cv.width, H = cv.height;
    // 是否具备可播放歌曲 id。
    var playable = !!(song && song.id);
    // 当前行动作是否可用。
    var actionReady = playable;
    ctx.clearRect(0, 0, W, H);
    makeRoundRect(ctx, 14, 10, W - 28, H - 20, 22);
    // 行背景渐变。
    var rowGrad = ctx.createLinearGradient(0, 0, W, H);
    // 行背景透明度来自歌单架设置。
    var rowBgAlpha = shelfSettings().bgOpacity;
    // 中心行背景至少保持较高不透明度。
    var centerRowBgAlpha = isCenter ? Math.max(rowBgAlpha, 0.92) : rowBgAlpha;
    if (isCenter) {
      // 中心行使用更亮的层次。
      rowGrad.addColorStop(0, 'rgba(8,14,24,' + Math.min(0.985, centerRowBgAlpha + 0.040).toFixed(3) + ')');
      rowGrad.addColorStop(0.48, 'rgba(0,0,0,' + Math.min(0.985, centerRowBgAlpha + 0.030).toFixed(3) + ')');
      rowGrad.addColorStop(1, 'rgba(0,0,0,' + Math.min(0.98, centerRowBgAlpha + 0.015).toFixed(3) + ')');
    } else {
      // 普通行更低对比。
      rowGrad.addColorStop(0, 'rgba(16,16,20,' + Math.max(0.20, rowBgAlpha - 0.02).toFixed(3) + ')');
      rowGrad.addColorStop(1, 'rgba(0,0,0,' + Math.max(0.20, rowBgAlpha - 0.04).toFixed(3) + ')');
    }
    if (isCenter) {
      // 中心行给轻微强调色阴影。
      ctx.shadowColor = canvasAccent(0.20);
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = rowGrad;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = isCenter ? canvasAccent(0.48) : 'rgba(255,255,255,0.10)';
    ctx.lineWidth = isCenter ? 1.6 : 1;
    ctx.stroke();
    ctx.font = '700 18px Inter, Arial';
    ctx.fillStyle = isCenter ? canvasAccent(0.95) : 'rgba(255,255,255,0.34)';
    // 行号文本。
    var n = String(row.index + 1);
    if (n.length < 2) n = '0' + n;
    ctx.fillText(n, 32, 52);
    // 歌曲封面尺寸。
    var coverSize = 54;
    // 歌曲封面 X 坐标。
    var coverX = 84;
    // 歌曲封面 Y 坐标。
    var coverY = H/2 - coverSize/2;
    // 歌曲封面地址。
    var songCover = songCoverSrc(song, 80);
    // 是否存在歌曲封面。
    var hasSongCover = !!songCover;
    if (actionReady || hasSongCover) {
      // 行封面底板。
      makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 13);
      ctx.fillStyle = isCenter ? canvasAccent(0.12) : 'rgba(255,255,255,0.07)';
      ctx.fill();
      if (hasSongCover) {
        // 歌曲封面缓存。
        var songCoverRec = playlistCoverCache[songCover];
        if (songCoverRec && songCoverRec.loaded && songCoverRec.img) {
          // 封面已加载时裁剪绘制。
          ctx.save();
          makeRoundRect(ctx, coverX, coverY, coverSize, coverSize, 13);
          ctx.clip();
          ctx.drawImage(songCoverRec.img, coverX, coverY, coverSize, coverSize);
          ctx.restore();
        } else if (!songCoverRec || (!songCoverRec.loading && !songCoverRec.failed)) {
          // 封面未加载时请求并在完成后重绘当前行。
          requestPlaylistCover(songCover, function(){
            if (row && row.mesh && row.mesh.parent) drawRow(row, row.song, !!row.lastCenter);
          });
        }
      }
    }
    // 标题
    // 文本起始 X 会根据是否有封面调整。
    var textX = (actionReady || hasSongCover) ? 154 : 82;
    // 播放按钮尺寸和位置。
    var btnW = 104, btnH = 48, btnX = W - 144, btnY = H/2 - btnH/2;
    // 下一首按钮尺寸和位置。
    var miniBtn = 44, nextX = btnX - 52;
    // 文本最大宽度，中心行需要给按钮预留空间。
    var textMax = actionReady && isCenter ? nextX - textX - 24 : W - textX - 42;
    // 当前行是否为加载骨架行。
    var loadingRow = !playable && isLoadingLabel(song && song.name);
    if (loadingRow) {
      // 加载骨架标题。
      ctx.font = '700 22px Inter, "Microsoft YaHei", Arial';
      ctx.fillStyle = 'rgba(255,247,224,0.88)';
      ctx.fillText('正在更新队列', textX, 42);
      // 骨架扫光相位。
      var phase = ((uniforms.uTime.value || 0) * 0.85) % 1;
      for (var sk = 0; sk < 3; sk++) {
        // 骨架条 Y 坐标。
        var barY = 58 + sk * 13;
        // 骨架条宽度。
        var barW = sk === 0 ? 330 : (sk === 1 ? 250 : 180);
        makeRoundRect(ctx, textX, barY, barW, 7, 4);
        // 骨架条扫光渐变。
        var skGrad = ctx.createLinearGradient(textX, barY, textX + barW, barY);
        // 当前骨架条高光位置。
        var hot = (phase + sk * 0.14) % 1;
        skGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
        skGrad.addColorStop(Math.max(0, hot - 0.18), canvasAccent(0.10));
        skGrad.addColorStop(Math.min(0.99, hot), canvasAccent(0.34));
        skGrad.addColorStop(1, 'rgba(255,255,255,0.08)');
        ctx.fillStyle = skGrad; ctx.fill();
      }
      // 加载行纹理需要随动画刷新。
      row.texture.needsUpdate = true;
      return;
    }
    // 歌曲标题。
    ctx.font = isCenter ? '800 24px Inter, "Microsoft YaHei", Arial' : '600 20px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = isCenter ? 'rgba(255,247,224,0.96)' : 'rgba(255,255,255,0.80)';
    ctx.fillText(ellipsize(ctx, song.name || '', textMax), textX, 44);
    // 歌手文本。
    ctx.font = '500 15px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = isCenter ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.64)';
    ctx.fillText(ellipsize(ctx, song.artist || '', textMax), textX, 72);
    // center 行右侧显示下一首/播放按钮
    if (isCenter && actionReady) {
      // 下一首按钮底板。
      makeRoundRect(ctx, nextX, btnY + 2, miniBtn, btnH - 4, 15);
      // 下一首按钮渐变。
      var nextGrad = ctx.createLinearGradient(nextX, btnY + 2, nextX + miniBtn, btnY + btnH);
      nextGrad.addColorStop(0, 'rgba(255,255,255,0.082)');
      nextGrad.addColorStop(0.62, 'rgba(255,255,255,0.045)');
      nextGrad.addColorStop(1, canvasAccent(0.055));
      ctx.fillStyle = nextGrad;
      ctx.fill();
      ctx.strokeStyle = canvasAccent(0.24);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      // 下一首按钮中心点。
      var nextCx = nextX + miniBtn / 2;
      // 下一首按钮中心 Y。
      var nextCy = btnY + btnH / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.90)';
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(nextCx, nextCy - 8);
      ctx.lineTo(nextCx, nextCy + 8);
      ctx.moveTo(nextCx - 8, nextCy);
      ctx.lineTo(nextCx + 8, nextCy);
      ctx.stroke();

      // 播放按钮底板。
      makeRoundRect(ctx, btnX, btnY, btnW, btnH, 18);
      // 播放按钮渐变。
      var btnGrad = ctx.createLinearGradient(btnX, btnY, btnX + btnW, btnY + btnH);
      btnGrad.addColorStop(0, 'rgba(255,255,255,0.88)');
      btnGrad.addColorStop(0.56, canvasAccent(0.94));
      btnGrad.addColorStop(1, canvasAccent(0.58));
      ctx.fillStyle = btnGrad; ctx.fill();
      ctx.strokeStyle = canvasAccent(0.42);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.font = '700 15px Inter, Arial';
      ctx.fillStyle = readableInkForHex(shelfAccentHex());
      ctx.fillText('播放', btnX + 36, btnY + 29);
    }
    // 标记行纹理需要上传。
    row.texture.needsUpdate = true;
  }

  // 按当前中心索引摆放二级内容中的一行。
  function place(row, i) {
    // 与中心行的距离。
    var delta = row.index - centerSmooth;
    // 距离绝对值。
    var absD = Math.abs(delta);
    if (absD > CONTENT_VISIBLE_RADIUS + 0.5) { row.mesh.visible = false; return; }
    row.mesh.visible = true;
    // 中心附近行层级更高。
    row.mesh.renderOrder = 240 + Math.round((CONTENT_VISIBLE_RADIUS + 1 - Math.min(absD, CONTENT_VISIBLE_RADIUS + 1)) * 14);
    // 当前时间。
    var nowT = uniforms.uTime.value;
    // 行入场原始进度。
    var revealRaw = Math.max(0, Math.min(1, (nowT - rowAnimAt - absD * 0.040) / 0.72));
    // 行入场平滑进度。
    var reveal = revealRaw * revealRaw * (3 - 2 * revealRaw);
    // 指针视差 X。
    var parX = pointerParallax.x || 0;
    // 指针视差 Y。
    var parY = pointerParallax.y || 0;
    // 离中心越远，指针影响越弱。
    var parWeight = Math.max(0, 1 - absD * 0.12);
    // 行点击脉冲。
    var pulse = row.fxPulse || 0;
    // 列表整体加载完成后的收敛动画。
    var settle = group && group.userData ? (group.userData.rowSettle || 0) : 0;
    // 当前详情布局。
    var layout = detailLayout();
    // 当前歌单架视觉设置。
    var shelfLook = shelfSettings();
    // 骷髅预设下详情面板使用更保守布局。
    var skullDetail = shouldUseSkullSafeShelfCamera();
    // 行基础 X。
    var rowBaseX = skullDetail ? 0.22 : -0.04;
    // 行随距离展开的 X 偏移。
    var rowSpreadX = skullDetail ? 0.030 : 0.014;
    // 行入场 X 偏移。
    var rowIntroX = skullDetail ? 0.58 : 0.38;
    // 中心行 Z。
    var rowCenterZ = skullDetail ? 0.62 : 0.62;
    // 非中心行基础 Z。
    var rowBackZ = skullDetail ? 0.58 : 0.58;
    // 行深度步进。
    var rowDepthStep = skullDetail ? 0.046 : 0.048;
    // 行最终 X。
    var px = rowBaseX + absD * rowSpreadX + (1 - reveal) * (rowIntroX + absD * rowSpreadX);
    // 行最终 Y。
    var py = -delta * layout.rowStep + (1 - reveal) * (0.20 + (delta < 0 ? -0.10 : 0.10));
    // 行最终 Z。
    var pz = (absD < 0.5 ? rowCenterZ : (rowBackZ - absD * rowDepthStep)) - (1 - reveal) * (skullDetail ? 0.10 : 0.16);
    // 叠加载入完成后的收敛偏移。
    px += settle * ((skullDetail ? 0.11 : 0.12) + absD * (skullDetail ? 0.010 : 0.012));
    py += settle * (delta < 0 ? -0.08 : 0.08);
    pz -= settle * (skullDetail ? 0.045 : 0.08);
    // 叠加指针视差。
    px += parX * (skullDetail ? 0.022 : 0.026) * parWeight;
    py += parY * (skullDetail ? 0.024 : 0.036) * parWeight;
    pz += (parY * (skullDetail ? 0.014 : 0.024) - parX * (skullDetail ? 0.010 : 0.020)) * parWeight;
    // 行缩放。
    var scale = (absD < 0.5 ? 1.00 : Math.max(0.66, 0.94 - absD * 0.070)) * (0.90 + reveal * 0.10) * (1 + pulse * 0.052) * (1 - settle * 0.025) * layout.rowScale;
    row.mesh.position.set(px, py, pz);
    row.mesh.scale.setScalar(scale);
    // 行基础透明度。
    var rowOpacityBase = Math.min(1, (absD < 0.5 ? 1.0 : Math.max(0.34, 1.0 - absD * 0.12)) * reveal + pulse * 0.14);
    // 中心行保持更高不透明度。
    var rowOpacityScale = absD < 0.5 ? Math.max(0.94, shelfLook.opacity) : shelfLook.opacity;
    row.mesh.material.opacity = Math.min(1, rowOpacityBase * rowOpacityScale);
    row.mesh.rotation.y = (skullDetail ? -0.070 : 0.10) + (1 - reveal) * (skullDetail ? 0.018 : 0.052) + parX * (skullDetail ? 0.010 : 0.018) * parWeight;
    row.mesh.rotation.x = (skullDetail ? 0.010 : 0) - delta * (skullDetail ? 0.010 : 0.022) - parY * (skullDetail ? 0.006 : 0.014) * parWeight;
  }

  // 释放一组二级内容行资源。
  function disposeRowList(rowList) {
    while (rowList.length) {
      // 取出一行。
      var row = rowList.pop();
      // 从场景中移除行 mesh。
      if (row.mesh && row.mesh.parent) row.mesh.parent.remove(row.mesh);
      if (row.mesh && row.mesh.material) {
        // 释放行贴图。
        if (row.mesh.material.map) row.mesh.material.map.dispose();
        // 释放行材质。
        row.mesh.material.dispose();
      }
      // 释放行几何。
      if (row.mesh && row.mesh.geometry) row.mesh.geometry.dispose();
    }
  }

  // 释放当前二级内容行窗口。
  function disposeRows() {
    disposeRowList(rows);
    renderedStart = -1;
  }

  // 释放被动画捕获的旧详情组、旧行和旧面板。
  function disposeCapturedDetail(targetGroup, targetRows, targetPanel) {
    if (targetGroup && targetGroup.parent) targetGroup.parent.remove(targetGroup);
    disposeRowList(targetRows || []);
    disposePanelObject(targetPanel);
  }

  // 二级内容行加载完成后启动一次收敛入场动画。
  function startRowsLoadedIntro() {
    // 重置行动画时间。
    rowAnimAt = uniforms.uTime.value;
    // 标记面板和行需要重绘。
    panelDirty = true;
    rowsDirty = true;
    if (!group || !group.userData) return;
    // rowSettle 从 1 缓动到 0。
    group.userData.rowSettle = 1;
    if (window.gsap) {
      window.gsap.killTweensOf(group.userData, 'rowSettle');
      window.gsap.to(group.userData, { rowSettle: 0, duration: 0.76, ease: 'expo.out' });
    } else {
      group.userData.rowSettle = 0;
    }
  }

  // 同步二级内容当前中心附近的行渲染窗口。
  function syncRenderedRows(force) {
    if (!group) return;
    // 当前视觉时间。
    var nowT = uniforms.uTime.value || 0;
    // 加载占位需要按固定间隔刷新骨架动画。
    var refreshLoading = isLoadingContent() && nowT - rowDrawAt >= LOADING_ANIM_INTERVAL;
    drawPanelIfNeeded(force || refreshLoading, nowT);
    // 全量歌曲行数。
    var total = allTracks.length;
    if (!total) { disposeRows(); return; }
    // 当前中心索引。
    var center = Math.round(centerTarget);
    // 行窗口起点。
    var start = Math.max(0, center - CONTENT_VISIBLE_RADIUS);
    // 行窗口终点。
    var end = Math.min(total - 1, start + CONTENT_MAX_RENDER - 1);
    // 靠近末尾时回推起点，让窗口尽量填满。
    start = Math.max(0, end - CONTENT_MAX_RENDER + 1);
    if (!force && start === renderedStart && rows.length === (end - start + 1)) {
      // 窗口未变时同步行数据引用。
      rows.forEach(function(row) { row.song = allTracks[row.index] || row.song; });
      if (rowsDirty || refreshLoading) {
        // 行脏或加载动画刷新时重绘当前窗口行。
        rows.forEach(function(row) {
          // 当前行是否为中心行。
          var isCenter = Math.abs(row.index - centerSmooth) < 0.5;
          drawRow(row, row.song, isCenter);
          row.lastCenter = isCenter;
        });
        rowsDirty = false;
        rowDrawAt = nowT;
      }
      return;
    }
    // 窗口变化时销毁旧行。
    disposeRows();
    // 保存新窗口起点。
    renderedStart = start;
    for (var idx = start; idx <= end; idx++) {
      // 创建并绘制窗口内每一行。
      var row = makeRow(allTracks[idx], idx);
      rows.push(row);
      drawRow(row, row.song, idx === Math.round(centerSmooth));
      row.lastCenter = idx === Math.round(centerSmooth);
    }
    rowsDirty = false;
    rowDrawAt = nowT;
  }

  // 暴露二级内容列表管理器接口。
  return {
    // 二级内容是否打开。
    isOpen: function() { return open; },
    // 主题变化后强制重绘面板和行。
    refreshTheme: function() {
      panelDirty = true;
      rowsDirty = true;
      if (!open || !group) return;
      drawPanelIfNeeded(true);
      syncRenderedRows(true);
    },
    // 打开二级内容列表。
    open: async function(playlistId, title, fromCard) {
      // 标记打开状态并记录标题和来源卡片。
      open = true;
      playlistTitle = title;
      sourceCard = fromCard;
      // 请求 token 防止旧异步流程回写。
      var token = ++requestToken;
      // 打开和行动画时间。
      openAnimAt = uniforms.uTime.value;
      rowAnimAt = openAnimAt;
      // 打开时从第一行开始。
      centerTarget = 0;
      centerSmooth = 0;
      // 标记所有画布需要重绘。
      panelDirty = true;
      rowsDirty = true;
      panelDrawAt = -10;
      rowDrawAt = -10;
      if (!group) {
        // 首次打开时创建详情根组。
        group = new THREE.Group();
        scene.add(group);
      }
      // 打开时的响应式布局。
      var openLayout = detailLayout();
      // 骷髅预设详情安全姿态。
      var openSkullDetail = shouldUseSkullSafeShelfCamera();
      // 非骷髅预设可根据相机动态姿态打开。
      var openDynamicDetail = !openSkullDetail && shouldUseShelfDynamicCamera('shelf-detail') && camera;
      // 当前封面粒子旋转，普通姿态会继承一部分。
      var openCoverRx = particles && particles.rotation ? particles.rotation.x : 0;
      var openCoverRy = particles && particles.rotation ? particles.rotation.y : 0;
      var openCoverRz = particles && particles.rotation ? particles.rotation.z : 0;
      // detailIntro 控制打开入场偏移。
      group.userData.detailIntro = 1;
      group.position.set(openLayout.x + (openSkullDetail ? 0.10 : 0.16), openLayout.y - (openSkullDetail ? 0.02 : 0.024), openLayout.z - (openSkullDetail ? 0.05 : 0.070));
      if ((openSkullDetail || openDynamicDetail) && camera) {
        // 安全或动态姿态使用相机朝向作为基准。
        group.quaternion.copy(camera.quaternion);
        group.rotateX(openLayout.rx);
        group.rotateY(openLayout.ry + (openSkullDetail ? 0.014 : 0.018));
      } else {
        // 普通姿态继承封面粒子部分旋转。
        group.rotation.y = openCoverRy * 0.82 + openLayout.ry + 0.018;
        group.rotation.x = openCoverRx * 0.72 + openLayout.rx;
        group.rotation.z = openCoverRz * 0.70;
      }
      group.scale.setScalar(openLayout.scale * 0.965);
      if (window.gsap) {
        // 使用 GSAP 平滑收敛入场偏移。
        window.gsap.killTweensOf(group.userData);
        window.gsap.to(group.userData, { detailIntro: 0, duration: 0.48, ease: 'power3.out' });
      } else {
        group.userData.detailIntro = 0;
      }
      try {
        // 先绘制面板和加载行，让打开动作有即时反馈。
        drawPanelIfNeeded(true);
        // 清旧
        disposeRows();
        // loading 行
        // 加载占位行。
        allTracks = [{ name: '加载中…', artist: '' }];
        panelDirty = true;
        rowsDirty = true;
        syncRenderedRows(true);
      } catch (renderLoadingErr) {
        console.warn('[ShelfContentLoadingRender]', playlistId, renderLoadingErr);
      }
      if (!open || token !== requestToken) return;
      try {
        // 在线歌单入口已移除，仅保留宿主队列展示。
        disposeRows();
        // 用固定文案替代旧在线歌单内容。
        allTracks = [{ name: '在线歌单已移除', artist: '播放队列由宿主同步' }];
        centerTarget = 0; centerSmooth = 0;
        panelDirty = true;
        rowsDirty = true;
        startRowsLoadedIntro();
        syncRenderedRows(true);
      } catch (renderReadyErr) {
        console.warn('[ShelfContentReadyRender]', playlistId, renderReadyErr);
        showToast('在线歌单已移除');
      }
    },
    close: function() {
      open = false;
      requestToken++;
      var targetGroup = group;
      var targetRows = rows.slice();
      var targetPanel = panel;
      group = null;
      rows = [];
      panel = null;
      renderedStart = -1;
      allTracks = [];
      sourceCard = null;
      panelDirty = true;
      rowsDirty = true;
      panelDrawAt = -10;
      rowDrawAt = -10;
      if (!targetGroup) return;
      var materials = targetRows.map(function(row){ return row.mesh && row.mesh.material; }).filter(Boolean);
      if (targetPanel && targetPanel.mesh && targetPanel.mesh.material) materials.push(targetPanel.mesh.material);
      if (window.gsap) {
        window.gsap.killTweensOf(targetGroup.position);
        window.gsap.killTweensOf(targetGroup.scale);
        window.gsap.to(targetGroup.scale, { x: 0.965, y: 0.965, z: 0.965, duration: 0.18, ease: 'power2.in' });
        window.gsap.to(targetGroup.position, {
          x: targetGroup.position.x + 0.18,
          y: targetGroup.position.y - 0.02,
          z: targetGroup.position.z - 0.10,
          duration: 0.18,
          ease: 'power2.in'
        });
        var finishClose = function(){ disposeCapturedDetail(targetGroup, targetRows, targetPanel); };
        if (materials.length) {
          window.gsap.to(materials, {
            opacity: 0,
            duration: 0.16,
            ease: 'power2.in',
            onComplete: finishClose
          });
        } else {
          window.gsap.delayedCall(0.18, finishClose);
        }
      } else {
        disposeCapturedDetail(targetGroup, targetRows, targetPanel);
      }
    },
    update: function(dt) {
      if (!group || !open) return;
      var intro = group.userData.detailIntro || 0;
      var parX = pointerParallax.x || 0;
      var parY = pointerParallax.y || 0;
      var layout = detailLayout();
      var skullDetail = shouldUseSkullSafeShelfCamera();
      var dynamicDetail = !skullDetail && shouldUseShelfDynamicCamera('shelf-detail') && camera;
      var coverBoundDetail = !skullDetail && !dynamicDetail && particles && particles.rotation;
      var coverBindX = coverBoundDetail ? particles.rotation.y * 0.18 : 0;
      var coverBindY = coverBoundDetail ? particles.rotation.x * -0.16 : 0;
      var coverBindZ = coverBoundDetail ? Math.abs(particles.rotation.y) * 0.030 : 0;
      group.position.set(
        layout.x + coverBindX + intro * (skullDetail ? 0.10 : 0.16) + parX * (skullDetail ? 0.024 : 0.030),
        layout.y + coverBindY - intro * (skullDetail ? 0.02 : 0.024) + parY * (skullDetail ? 0.026 : 0.026),
        layout.z + coverBindZ - intro * (skullDetail ? 0.05 : 0.070) + parY * (skullDetail ? 0.014 : 0.016) - parX * (skullDetail ? 0.010 : 0.010)
      );
      if (skullDetail && camera) {
        group.quaternion.copy(camera.quaternion);
        group.rotateX(layout.rx - parY * 0.004);
        group.rotateY(layout.ry + intro * 0.004 + parX * 0.004);
      } else if (dynamicDetail) {
        group.quaternion.copy(camera.quaternion);
        group.rotateX(layout.rx - parY * 0.006);
        group.rotateY(layout.ry + intro * 0.012 + parX * 0.008);
      } else {
        var coverRx = particles && particles.rotation ? particles.rotation.x : 0;
        var coverRy = particles && particles.rotation ? particles.rotation.y : 0;
        var coverRz = particles && particles.rotation ? particles.rotation.z : 0;
        group.rotation.x += ((coverRx * 0.72 + layout.rx - parY * 0.010) - group.rotation.x) * 0.16;
        group.rotation.y += ((coverRy * 0.82 + layout.ry + intro * 0.018 + parX * 0.014) - group.rotation.y) * 0.16;
        group.rotation.z += ((coverRz * 0.70) - group.rotation.z) * 0.14;
      }
      group.scale.setScalar(layout.scale * (1 - intro * (skullDetail ? 0.020 : 0.035)));
      centerSmooth += (centerTarget - centerSmooth) * 0.18;
      if (Math.abs(centerSmooth - centerTarget) < 0.001) centerSmooth = centerTarget;
      syncRenderedRows(false);
      if (panel && panel.mesh) {
        var pr = Math.max(0, Math.min(1, (uniforms.uTime.value - openAnimAt) / 0.72));
        pr = pr * pr * (3 - 2 * pr);
        panel.mesh.material.opacity = 0.86 * pr * shelfSettings().opacity;
      }
      for (var i = 0; i < rows.length; i++) {
        place(rows[i], i);
        var isC = Math.abs(rows[i].index - centerSmooth) < 0.5;
        if (rows[i].lastCenter !== isC) {
          rows[i].lastCenter = isC;
          drawRow(rows[i], rows[i].song, isC);
        }
      }
    },
    next: function() {
      if (allTracks.length) {
        var prevTarget = Math.round(centerTarget);
        centerTarget = Math.min(allTracks.length - 1, centerTarget + 1);
        var nextTarget = Math.round(centerTarget);
        syncRenderedRows(false);
        if (nextTarget !== prevTarget) playShelfSelectTick(1, 'row');
        pulseObjectValue(rows.find(function(r){ return r.index === nextTarget; }), 'fxPulse', 0.48, 0.36);
      }
    },
    // 二级内容向上一行移动。
    prev: function() {
      if (allTracks.length) {
        // 移动前中心索引。
        var prevTarget = Math.round(centerTarget);
        // 目标索引向前夹紧。
        centerTarget = Math.max(0, centerTarget - 1);
        // 移动后中心索引。
        var nextTarget = Math.round(centerTarget);
        syncRenderedRows(false);
        if (nextTarget !== prevTarget) playShelfSelectTick(-1, 'row');
        pulseObjectValue(rows.find(function(r){ return r.index === nextTarget; }), 'fxPulse', 0.48, 0.36);
      }
    },
    // 二级内容按给定步长滚动。
    scrollBy: function(d) {
      if (allTracks.length) {
        // 滚动前中心索引。
        var prevTarget = Math.round(centerTarget);
        // 滚动后目标中心索引。
        centerTarget = Math.max(0, Math.min(allTracks.length - 1, centerTarget + d));
        // 归一化后的目标中心索引。
        var nextTarget = Math.round(centerTarget);
        syncRenderedRows(false);
        if (nextTarget !== prevTarget) playShelfSelectTick(d, 'row');
        pulseObjectValue(rows.find(function(r){ return r.index === nextTarget; }), 'fxPulse', 0.48, 0.36);
      }
    },
    // 获取当前已渲染行。
    getRows: function() { return rows; },
    // 获取当前中心行索引。
    getCenterIdx: function() { return Math.round(centerSmooth); },
    // 给指定行施加脉冲反馈。
    pulseRow: function(row, amount) {
      if (!row) return;
      pulseObjectValue(row, 'fxPulse', amount || 1, 0.42);
    },
    // 使用 Three.js 射线拾取二级内容行。
    raycastRows: function(rc) {
      if (!rows.length) return null;
      // 可见行 mesh 列表。
      var vm = rows.filter(function(r){return r.mesh.visible;}).map(function(r){return r.mesh;});
      // 射线命中结果。
      var hits = rc.intersectObjects(vm, false);
      if (!hits.length) return null;
      // 命中的行对象。
      var row = rows.find(function(r){ return r.mesh === hits[0].object; });
      return { row: row, uv: hits[0].uv };
    },
    // 用屏幕坐标粗略拾取二级内容行。
    pickRowAtScreen: function(sx, sy) {
      if (!rows.length || !open) return null;
      // 按层级从前到后检查。
      var ordered = rows.filter(function(r){ return r.mesh && r.mesh.visible; }).sort(function(a, b){
        return (b.mesh.renderOrder || 0) - (a.mesh.renderOrder || 0);
      });
      for (var ri = 0; ri < ordered.length; ri++) {
        // 当前候选行。
        var row = ordered[ri];
        // 行几何尺寸。
        var params = row.mesh.geometry && row.mesh.geometry.parameters || {};
        // 半宽。
        var hw = (params.width || 2.50) / 2;
        // 半高。
        var hh = (params.height || 0.36) / 2;
        // 行四角本地坐标。
        var pts = [
          new THREE.Vector3(-hw, -hh, 0),
          new THREE.Vector3( hw, -hh, 0),
          new THREE.Vector3( hw,  hh, 0),
          new THREE.Vector3(-hw,  hh, 0),
        ];
        // 屏幕包围盒。
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        row.mesh.updateMatrixWorld(true);
        for (var pi = 0; pi < pts.length; pi++) {
          // 投影到屏幕坐标。
          pts[pi].applyMatrix4(row.mesh.matrixWorld).project(camera);
          var x = (pts[pi].x + 1) * innerWidth / 2;
          var y = (1 - pts[pi].y) * innerHeight / 2;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        // 命中扩展边距。
        var padX = 24, padY = 16;
        if (sx < minX - padX || sx > maxX + padX || sy < minY - padY || sy > maxY + padY) continue;
        // 近似 UV。
        var u = clampRange((sx - minX) / Math.max(1, maxX - minX), 0, 1);
        var v = 1 - clampRange((sy - minY) / Math.max(1, maxY - minY), 0, 1);
        return { row: row, uv: { x: u, y: v }, screenPick: true };
      }
      return null;
    },
    // 射线拾取二级内容背景面板。
    raycastPanel: function(rc) {
      if (!panel || !panel.mesh) return null;
      var hits = rc.intersectObject(panel.mesh, false);
      return hits && hits.length ? hits[0] : null;
    },
    // 判断屏幕坐标是否落在二级内容面板投影范围内。
    screenContainsPanel: function(sx, sy) {
      if (!panel || !panel.mesh || !open) return false;
      // 面板几何尺寸。
      var params = panel.mesh.geometry && panel.mesh.geometry.parameters || {};
      // 半宽。
      var hw = (params.width || 2.62) / 2;
      // 半高。
      var hh = (params.height || 3.02) / 2;
      // 面板四角本地坐标。
      var pts = [
        new THREE.Vector3(-hw, -hh, 0),
        new THREE.Vector3( hw, -hh, 0),
        new THREE.Vector3( hw,  hh, 0),
        new THREE.Vector3(-hw,  hh, 0),
      ];
      // 面板屏幕包围盒。
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      panel.mesh.updateMatrixWorld(true);
      for (var pi = 0; pi < pts.length; pi++) {
        // 投影到屏幕坐标。
        pts[pi].applyMatrix4(panel.mesh.matrixWorld).project(camera);
        var x = (pts[pi].x + 1) * innerWidth / 2;
        var y = (1 - pts[pi].y) * innerHeight / 2;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      // 面板命中边距。
      var pad = 42;
      return sx >= minX - pad && sx <= maxX + pad && sy >= minY - pad && sy <= maxY + pad;
    },
    // 判断点击中心行右侧按钮区域对应的动作。
    rowActionAtScreen: function(row, sx, sy) {
      if (!row || !row.mesh || !row.mesh.visible) return null;
      // 行歌曲数据。
      var song = row.song || {};
      // 只有中心行有按钮动作。
      var isCenter = Math.abs(row.index - Math.round(centerSmooth)) < 0.5;
      if (!isCenter || !(song && song.id)) return null;
      // 行几何尺寸。
      var params = row.mesh.geometry && row.mesh.geometry.parameters || {};
      // 半宽。
      var hw = (params.width || 2.50) / 2;
      // 半高。
      var hh = (params.height || 0.36) / 2;
      // 行四角坐标。
      var corners = [
        new THREE.Vector3(-hw, -hh, 0),
        new THREE.Vector3( hw, -hh, 0),
        new THREE.Vector3( hw,  hh, 0),
        new THREE.Vector3(-hw,  hh, 0),
      ];
      // 投影包围盒。
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      row.mesh.updateMatrixWorld(true);
      for (var i = 0; i < corners.length; i++) {
        // 投影到屏幕坐标。
        corners[i].applyMatrix4(row.mesh.matrixWorld).project(camera);
        var x = (corners[i].x + 1) * innerWidth / 2;
        var y = (1 - corners[i].y) * innerHeight / 2;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      // 包围盒宽度。
      var w = Math.max(1, maxX - minX);
      // 包围盒高度。
      var h = Math.max(1, maxY - minY);
      // 点击点在行内的归一化 X。
      var u = clampRange((sx - minX) / w, 0, 1);
      // 点击点在行内的归一化 Y。
      var v = clampRange((sy - minY) / h, 0, 1);
      if (u >= 0.75 && u < 0.82 && v > 0.12 && v < 0.88) return 'next';
      if (u >= 0.82 && v > 0.10 && v < 0.90) return 'play';
      return null;
    },
    // 播放二级内容中的歌曲行。
    playRow: function(row) {
      // 旧在线歌单播放入口已移除。
      pulseObjectValue(row, 'fxPulse', 1.0, 0.34);
      // 行索引。
      var idx = row.index;
      if (idx < 0) return;
      // 只有真实歌曲才可播放。
      var songToPlay = row.song && row.song.id ? row.song : null;
      if (!songToPlay) return;
      forcePlaybackControlsInteractive();
      requestHostPlaySong(songToPlay);
      // 关闭内容框
      // 播放后关闭二级内容框。
      var sm = shelfManager;
      if (sm) safeShelfCloseContent('content-play-row');
    }
  };

  // 构建二级内容中的一行 3D 网格。
  function makeRow(song, i) {
    // 行 canvas。
    var cv = document.createElement('canvas');
    cv.width = 800; cv.height = 104;
    // 行绘制上下文。
    var ctx = cv.getContext('2d');
    // 行 canvas 纹理。
    var tx = new THREE.CanvasTexture(cv);
    tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
    tx.generateMipmaps = false;
    // 行材质。
    var mat = new THREE.MeshBasicMaterial({ map: tx, transparent: true, opacity: 0.96, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    // 行几何体。
    var geo = new THREE.PlaneGeometry(2.50, 0.36, 1, 1);
      // 行 mesh。
      var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 240 + i;
      group.add(mesh);
      // 行运行期对象。
      return { canvas: cv, texture: tx, mesh: mesh, song: song, index: i, fxPulse: 0 };
    }
}

// 将大数字压缩成中文单位显示。
function compactCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}
// 请求并缓存播放列表或歌曲封面图片。
function requestPlaylistCover(url, cb) {
  if (!url) { if (cb) cb(null); return; }
  // 当前 URL 的缓存记录。
  var rec = playlistCoverCache[url];
  if (rec && rec.loaded) { if (cb) setTimeout(function(){ cb(rec.img); }, 0); return; }
  if (rec && rec.loading) { if (cb) rec.waiters.push(cb); return; }
  // 创建新的加载记录。
  rec = playlistCoverCache[url] = { loaded:false, loading:true, waiters: cb ? [cb] : [], img:null, failed:false };

  // 封面加载成功收尾。
  function finish(img) {
    rec.loaded = true; rec.loading = false; rec.failed = false; rec.img = img;
    rec.waiters.splice(0).forEach(function(fn){ setTimeout(function(){ fn(img); }, 0); });
  }
  // 封面加载失败收尾。
  function fail() {
    rec.loading = false; rec.failed = true;
    rec.waiters.splice(0).forEach(function(fn){ setTimeout(function(){ fn(null); }, 0); });
  }
  // 按候选地址顺序尝试加载封面。
  function loadCandidate(srcList, index) {
    // 当前候选地址。
    var src = srcList[index];
    if (!src) { fail(); return; }
    // 图片对象。
    var img = new Image();
    if (!isInlineCoverSrc(src)) img.crossOrigin = 'anonymous';
    img.onload = function(){ finish(img); };
    img.onerror = function(){ loadCandidate(srcList, index + 1); };
    img.src = src;
  }

  // 优先尝试代理地址，避免 canvas 污染。
  var proxied = coverProxySrc(url);
  // 候选加载源列表。
  var sources = [];
  if (proxied) sources.push(proxied);
  if (url && sources.indexOf(url) === -1 && (isInlineCoverSrc(url) || isProxyableCoverUrl(url))) sources.push(url);
  loadCandidate(sources, 0);
}

// ============================================================
//  3D 卡片交互 - PSP 风格
//   - 滚轮: 滚动 center 卡 (一级或二级)
//   - 点击 center 卡: 播放队列
//   - 点击两侧卡: 滚到那张
//   - ESC: 关闭内容框
// ============================================================
// 根据指针事件创建 Three.js 射线。
function raycasterFromPointerEvent(e) {
  // 归一化设备坐标 X。
  var mx = (e.clientX / innerWidth) * 2 - 1;
  // 归一化设备坐标 Y。
  var my = -(e.clientY / innerHeight) * 2 + 1;
  // 射线对象。
  var rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(mx, my), camera);
  return rc;
}
// 优先用射线拾取歌单架卡片，失败时回退到屏幕矩形拾取。
function pointerCardHit(rc, e, screenPad) {
  if (!shelfManager) return null;
  return shelfManager.raycastCards(rc) || (shelfManager.pickCardAtScreen && shelfManager.pickCardAtScreen(e.clientX, e.clientY, screenPad));
}
// 判断当前指针位置是否命中侧边歌单架焦点区。
function isSideShelfFocusHit(e) {
  if (!e || !shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfPinnedOpen) return true;
  if (shelfAlwaysVisible()) return !!pointerCardHit(raycasterFromPointerEvent(e), e, 18);
  if (!shelfAutoHiddenInputReady()) return false;
  if (shelfVisibility > 0.34 && (isShelfClickZone(e) || isShelfPreviewUseZone(e))) return true;
  return !!(shelfPreviewIsVisible() && pointerCardHit(raycasterFromPointerEvent(e), e, 24));
}
// 根据鼠标位置刷新歌单架卡片悬停选中态。
function updateShelfCardHoverSelection(e) {
  if (!shelfManager || !shelfManager.clearSelected || !shelfManager.setSelected) return;
  if (!e || isPointerOverUi(e)) {
    shelfManager.clearSelected();
    return;
  }
  // 当前歌单架模式。
  var mode = shelfManager.getMode && shelfManager.getMode();
  if (!mode || mode === 'off') {
    shelfManager.clearSelected();
    return;
  }
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    shelfManager.clearSelected();
    return;
  }
  // 管理器是否允许交互。
  var canInteract = shelfManager.canInteract && shelfManager.canInteract();
  if (!canInteract) {
    shelfManager.clearSelected();
    return;
  }
  if (mode === 'side') {
    if (!shelfPinnedOpen && shelfAlwaysVisible()) {
      // 常显侧边模式下只在真实命中卡片时选中。
      var alwaysHit = pointerCardHit(raycasterFromPointerEvent(e), e, 18);
      if (alwaysHit && alwaysHit.card) shelfManager.setSelected(alwaysHit.card.index);
      else shelfManager.clearSelected();
      return;
    }
    // 自动隐藏侧栏必须先进入可交互状态。
    var sideUsable = shelfPinnedOpen || shelfAutoHiddenInputReady();
    if (!sideUsable) {
      shelfManager.clearSelected();
      return;
    }
  } else if (mode !== 'stage') {
    shelfManager.clearSelected();
    return;
  }
  // 最终命中的卡片。
  var hit = pointerCardHit(raycasterFromPointerEvent(e), e);
  if (hit && hit.card) shelfManager.setSelected(hit.card.index);
  else shelfManager.clearSelected();
}
// 判断是否命中旧在线歌单播放按钮；当前功能已移除。
function isShelfPlaylistPlayHit(hit) {
  return false;
}
// 歌单架主点击事件。
renderer.domElement.addEventListener('click', function(e){
  if (!shelfManager || shelfManager.getMode() === 'off') return;
  if (isPointerOverUi(e)) return;
  if (mouseDownAt.hadDrag) { mouseDownAt.hadDrag = false; return; }

  // 当前点击射线。
  var rc = raycasterFromPointerEvent(e);
  // 当前歌单架模式。
  var mode = shelfManager.getMode();
  // 当前是否可交互。
  var canInteract = shelfManager.canInteract && shelfManager.canInteract();

  // 优先二级内容框
  if (shelfManager.hasOpenContent()) {
    // 二级内容管理器。
    var cl = shelfManager.getContentList && shelfManager.getContentList();
    if (cl) {
      // 先拾取二级行。
      var rowHit = cl.raycastRows(rc);
      if (!rowHit && cl.pickRowAtScreen) rowHit = cl.pickRowAtScreen(e.clientX, e.clientY);
      if (rowHit) {
        if (cl.pulseRow) cl.pulseRow(rowHit.row, 0.72);
        // 是否点击了中心行。
        var selectedRow = Math.abs(rowHit.row.index - cl.getCenterIdx()) < 0.5;
        // 行是否可播放。
        var rowIsPlayable = !!(rowHit.row.song && rowHit.row.song.id);
        // 是否命中下一首按钮。
        var hitNextButton = rowHit.uv && rowHit.uv.x >= 0.75 && rowHit.uv.x < 0.82 && rowHit.uv.y > 0.20 && rowHit.uv.y < 0.82;
        // 是否命中播放按钮。
        var hitPlayButton = rowHit.uv && rowHit.uv.x >= 0.82 && rowHit.uv.y > 0.20 && rowHit.uv.y < 0.82;
        // 屏幕坐标回退动作识别。
        var screenAction = (!rowHit.uv && cl.rowActionAtScreen) ? cl.rowActionAtScreen(rowHit.row, e.clientX, e.clientY) : null;
        hitNextButton = hitNextButton || screenAction === 'next';
        hitPlayButton = hitPlayButton || screenAction === 'play';
        if (selectedRow && rowIsPlayable && hitNextButton) {
          queueDetailSongNext(rowHit.row.song);
        } else if (rowIsPlayable || (selectedRow && rowIsPlayable && hitPlayButton)) {
          cl.playRow(rowHit.row);
        } else {
          // 滚到这行
          cl.scrollBy(rowHit.row.index - cl.getCenterIdx());
        }
        return;
      }
      // 未点中行时，点击一级卡片区域视为返回一级。
      var returnHit = shelfManager.raycastCards(rc);
      safeShelfCloseContent('shelf-card-return');
      if (mode === 'side') setShelfPinnedOpen(true, true);
      if (returnHit && returnHit.card) {
        shelfManager.scrollBy(returnHit.card.index - shelfManager.getCenterIdx());
      }
      return;
    }
  }

  // 一级卡片
  // 一级卡片命中。
  var hit = pointerCardHit(rc, e, mode === 'side' && !shelfPinnedOpen && shelfAlwaysVisible() ? 18 : undefined);
  if (mode === 'side' && !shelfPinnedOpen && !canUseSideShelfWithoutPinnedOpen()) return;

  if (hit) {
    if (mode === 'side') setShelfPinnedOpen(true, true);
    // 命中卡片索引。
    var idx = hit.card.index;
    if (Math.abs(idx - shelfManager.getCenterIdx()) < 0.5) {
      if (isShelfPlaylistPlayHit(hit) && shelfManager.playPlaylistAt && shelfManager.playPlaylistAt(idx)) return;
      shelfManager.openContent(idx);
    } else {
      shelfManager.scrollBy(idx - shelfManager.getCenterIdx());
    }
  } else if (mode === 'side' && shelfPinnedOpen) {
    setShelfPinnedOpen(false, true);
  }
});

// 画布右键保持无动作，仅阻止默认菜单。
renderer.domElement.addEventListener('contextmenu', function(e){
  e.preventDefault();
  e.stopPropagation();
});

// 滚轮: 在真实卡片或右侧窄热区内滚卡片; 否则保留给封面粒子/视角
//   side 模式: 常驻不再用半屏预览区接管滚轮
//   stage 模式: 鼠标 y > 60% 屏幕高
//   shift + wheel: 强制滚卡片
// 最近一次滚轮是否由歌单架接管。
var wheelOverShelf = false;
// 歌单架滚轮事件，优先让二级内容和卡片滚动响应。
renderer.domElement.addEventListener('wheel', function(e){
  if (isPointerOverUi(e)) return;
  if (!shelfManager || shelfManager.getMode() === 'off') return;
  markRenderInteraction('shelf-wheel', 900);
  // 当前滚轮射线。
  var rc = raycasterFromPointerEvent(e);
  // 二级框打开时, 只有真正命中详情行才接管滚轮
  if (shelfManager.hasOpenContent()) {
    // 二级内容管理器。
    var cl = shelfManager.getContentList();
    if (cl) {
      // 二级行命中。
      var rowHit = cl.raycastRows(rc);
      // 面板射线命中。
      var panelHit = !rowHit && cl.raycastPanel ? cl.raycastPanel(rc) : null;
      // 屏幕坐标面板命中回退。
      var panelScreenHit = !rowHit && !panelHit && cl.screenContainsPanel ? cl.screenContainsPanel(e.clientX, e.clientY) : false;
      if (!rowHit && !panelHit && !panelScreenHit) return;
      e.preventDefault(); e.stopImmediatePropagation();
      cl.scrollBy(e.deltaY > 0 ? 1 : -1);
      return;
    }
  }
  // 当前歌单架模式。
  var mode = shelfManager.getMode();
  // 当前滚轮是否落在歌单架区域。
  var inShelfArea = false;
  // 歌单架是否允许滚动交互。
  var canScrollShelf = shelfManager.canInteract && shelfManager.canInteract();
  // 自动隐藏侧栏是否处于可交互状态。
  var shelfPreviewActive = shelfAutoHiddenInputReady();
  // 滚轮位置是否命中卡片。
  var cardWheelHit = canScrollShelf ? pointerCardHit(rc, e, mode === 'side' && !shelfPinnedOpen && shelfAlwaysVisible() ? 18 : undefined) : null;
  if (canScrollShelf && e.shiftKey && (mode !== 'side' || shelfPinnedOpen || shelfPreviewActive || shelfAlwaysVisible())) inShelfArea = true;
  else if (canScrollShelf && mode === 'side') {
    // 侧边模式根据固定、常显和预览状态决定是否接管滚轮。
    if (shelfPinnedOpen) inShelfArea = isShelfWheelZone(e) || !!cardWheelHit;
    else if (shelfAlwaysVisible()) inShelfArea = !!cardWheelHit;
    else if (shelfPreviewActive) inShelfArea = isShelfWheelZone(e) || !!cardWheelHit;
  }
  else if (canScrollShelf && mode === 'stage' && cardWheelHit) inShelfArea = true;
  if (inShelfArea) {
    // 接管滚轮后阻止主粒子或页面处理。
    e.preventDefault();
    e.stopImmediatePropagation();
    shelfManager.scrollBy(e.deltaY > 0 ? 1 : -1);
  }
}, { passive: false, capture: true });

// 键盘 / 全局事件
// 判断按键是否属于自由相机控制键。
function isFreeCameraControlCode(code) {
  return /^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(code);
}
// 尝试消费自由相机键盘事件。
function consumeFreeCameraKeyEvent(e, isDown) {
  if (isTypingTarget(e.target)) return false;
  if (isDown && e.code === 'KeyR') {
    // R 用于切换自由相机。
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return true;
    toggleFreeCamera();
    return true;
  }
  if (!freeCamera || !freeCamera.active) return false;
  if (isDown && e.code === 'KeyK') {
    // 自由相机开启时 K 重置自由相机位置。
    e.preventDefault();
    e.stopImmediatePropagation();
    resetFreeCameraToDefault();
    return true;
  }
  if (!isFreeCameraControlCode(e.code)) return false;
  // 自由相机移动键由这里拦截，避免触发页面其他快捷键。
  e.preventDefault();
  e.stopImmediatePropagation();
  freeCamera.keys = freeCamera.keys || {};
  freeCamera.keys[e.code] = !!isDown;
  markRenderInteraction('free-camera-key', 900);
  return true;
}
// 捕获 keydown，优先交给自由相机。
document.addEventListener('keydown', function(e){
  consumeFreeCameraKeyEvent(e, true);
}, true);
// 捕获 keyup，释放自由相机按键状态。
document.addEventListener('keyup', function(e){
  consumeFreeCameraKeyEvent(e, false);
}, true);
// 全局键盘快捷键。
document.addEventListener('keydown', function(e){
  if (isTypingTarget(e.target)) return;
  markRenderInteraction('keyboard', 700);
  if (e.code === 'KeyK') {
    // K 在普通模式下回正镜头，在自由相机锁定时重置自由相机。
    e.preventDefault();
    if (freeCamera && (freeCamera.active || freeCamera.locked)) resetFreeCameraToDefault();
    else {
      recenterCamera();
      showToast('镜头已回正');
    }
    return;
  }
  if (e.code === 'KeyR') {
    // R 切换自由相机。
    if (e.repeat) return;
    e.preventDefault();
    toggleFreeCamera();
    return;
  }
  if (freeCamera && freeCamera.active) {
    // 自由相机激活时，移动键不再继续传递。
    if (/^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      freeCamera.keys[e.code] = true;
      return;
    }
  }
  if (!shelfManager) return;
  // 方括号和翻页键控制歌单架上下步进。
  if (e.code === 'BracketRight' || e.code === 'PageDown') shelfManager.next();
  else if (e.code === 'BracketLeft' || e.code === 'PageUp') shelfManager.prev();
});
// 全局 keyup 兜底释放自由相机按键。
document.addEventListener('keyup', function(e){
  if (!freeCamera || !freeCamera.keys) return;
  if (/^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(e.code)) {
    freeCamera.keys[e.code] = false;
  }
});
// 窗口失焦时清空自由相机按键状态，避免按键卡住。
window.addEventListener('blur', function(){
  if (freeCamera && freeCamera.keys) freeCamera.keys = {};
});

