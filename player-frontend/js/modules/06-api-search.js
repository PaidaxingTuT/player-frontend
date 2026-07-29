// ===== js/06-api-search.js =====

// ============================================================
//  API 助手
// ============================================================
// 转义 HTML 文本，供动态插入面板时避免标签被解释。
function escHtml(s){ var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
// 判断事件目标是否是可输入文本的控件。
function isTypingTarget(target) {
  if (!target) return false;
  // 标签名统一转大写。
  var tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(target.isContentEditable || (target.closest && target.closest('[contenteditable="true"]')));
}
// 判断封面地址是否为内联或 blob 地址。
function isInlineCoverSrc(src) {
  return typeof src === 'string' && (/^data:image\//i.test(src) || /^blob:/i.test(src));
}
// 判断封面地址是否是可直接代理或加载的 HTTP(S) 地址。
function isProxyableCoverUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}
// 生成封面代理地址；当前桥接模式下 HTTP(S) 直接返回。
function coverProxySrc(url) {
  if (!url) return '';
  if (isInlineCoverSrc(url)) return url;
  return isProxyableCoverUrl(url) ? url : '';
}
// 给封面 URL 添加或替换指定尺寸参数。
function coverUrlWithSize(url, size) {
  if (!url || isInlineCoverSrc(url) || !/^https?:\/\//i.test(url)) return url || '';
  if (!size) return url;
  // 网易/QQ 常用的尺寸参数格式。
  var param = 'param=' + size + 'y' + size;
  if (/[?&]param=\d+y\d+/i.test(url)) return url.replace(/([?&])param=\d+y\d+/i, '$1' + param);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + param;
}
// 从歌曲对象中提取封面地址并按需请求尺寸。
function songCoverSrc(song, size) {
  var cover = song && (song.cover || song.coverUrl || song.picUrl || song.albumCover || song.albumImg || song.img || song.image || song.cover_url);
  return cover ? coverUrlWithSize(cover, size) : '';
}
// 转义可用于 CSS background-image 的 URL 片段。
function cssImageUrl(url) {
  return String(url || '').replace(/\\/g, '\\\\').replace(/"/g, '%22');
}
// 获取当前正在展示封面的歌曲。
function currentCoverSong() {
  if (currentIdx >= 0 && playQueue[currentIdx]) return playQueue[currentIdx];
  return null;
}
// 浅克隆歌曲对象，避免调用方直接修改原队列对象。
function cloneSong(song){ return Object.assign({}, song); }
// 将秒数格式化为 m:ss 或 h:mm:ss。
function formatProgramTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  // 小时。
  var h = Math.floor(sec / 3600);
  // 分钟。
  var m = Math.floor((sec % 3600) / 60);
  // 秒。
  var s = Math.floor(sec % 60);
  return h ? (h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')) : (m + ':' + String(s).padStart(2, '0'));
}

// 判断歌曲来源 key，默认按网易云处理。
function songProviderKey(song) {
  if (song && (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq')) return 'qq';
  return 'netease';
}


