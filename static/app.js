/* =============================================================
   B 站集锦 · 前端（B 站视频网站风格）
   兼容目标：Chrome 74 WebView（不用 ??. ?? replaceAll :is() gap aspect-ratio clamp inset）
   ============================================================= */
'use strict';

var $ = function (s) { return document.querySelector(s); };

var el = {
  netDot: $('#netDot'), netText: $('#netText'),
  vtitle: $('#vtitle'), vowner: $('#vowner'), vdur: $('#vdur'), vqn: $('#vqn'), vsrc: $('#vsrc'),
  metaCard: $('#metaCard'), autoStatus: $('#autoStatus'),
  stage: $('#stage'), placeholder: $('#placeholder'),
  veil: $('#veil'), veilText: $('#veilText'),
  errLayer: $('#errLayer'), errText: $('#errText'), errRetry: $('#errRetry'),
  ribbon: $('#ribbon'), trackFill: $('#trackFill'),
  segList: $('#segList'), listStat: $('#listStat'),
  side: $('#side'), sideClose: $('#sideClose'), sideTabs: $('#sideTabs'),
  sideMask: $('#sideMask'), sideMode: $('#sideMode'),
  paneSegs: $('#paneSegs'), paneText: $('#paneText'),
  btnList: $('#btnList'), btnSet: $('#btnSet'),
  settings: $('#settings'), setClose: $('#setClose'),
  text: $('#text'), parseInfo: $('#parseInfo'), replyStat: $('#replyStat'),
  padFront: $('#padFront'), padBack: $('#padBack'),
  btnFetchReplies: $('#btnFetchReplies'), btnDemo: $('#btnDemo'), btnClear: $('#btnClear'),
  btnTestVideo: $('#btnTestVideo'),
  btnPrev: $('#btnPrev'), btnNext: $('#btnNext'), btnToggle: $('#btnToggle'), btnFull: $('#btnFull'),
  btnMute: $('#btnMute'),
  loop: $('#loop'), rate: $('#rate'), vol: $('#vol'),
  statLeft: $('#statLeft'), statRight: $('#statRight'),
  nowseg: $('#nowseg'),
  centerPlay: $('#centerPlay'),
  fsExit: $('#fsExit'), fsLock: $('#fsLock'), fsKeep: $('#fsKeep'), fsBar: $('#fsBar'),
  fsBarFill: $('#fsBarFill'), seekPreview: $('#seekPreview'),
  resume: $('#resume'), resumeText: $('#resumeText'), resumeGo: $('#resumeGo'), resumeReset: $('#resumeReset'),
  shareFallback: $('#shareFallback'), sfRaw: $('#sfRaw'), sfInput: $('#sfInput'), sfGo: $('#sfGo'), sfClose: $('#sfClose'),
};

var S = {
  token: null, info: null, hasAudio: false, videoDuration: 0,
  segs: [], idx: -1, pendingIdx: -1, active: 0, playing: false, busy: false,
  loop: 'all', rate: 1, vol: 1, lead: 0.35,
  padFront: 1, padBack: 2,
  qn: 80, page: 1, lastSwitchAt: 0, lastSync: 0, lastHud: 0, audioBlocked: false,
  resolving: false,
  decks: [], parsed: null,
  uiMode: 'normal', muted: false, locked: false, keepUi: false,
  gesturing: false, scrubbing: false,
  resumeInfo: null, sharedTitle: null, lastPosSave: 0,
  // 侧栏（片段+时间戳）默认收起，画面优先；sideMode: inline=内嵌 / float=右侧浮窗
  sideOpen: false, sideMode: 'inline', sideTab: 'segs', settingsOpen: false,
};

/* ---------------------- 工具 ---------------------- */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function fmt(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return h > 0 ? (h + ':' + p(m) + ':' + p(s)) : (m + ':' + p(s));
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function once(target, evt, timeout) {
  timeout = timeout || 8000;
  return new Promise(function (resolve) {
    var done = false;
    var on = function () {
      if (done) return; done = true;
      target.removeEventListener(evt, on); resolve(true);
    };
    target.addEventListener(evt, on);
    setTimeout(function () {
      if (!done) { done = true; target.removeEventListener(evt, on); resolve(false); }
    }, timeout);
  });
}

function seekTo(media, t, timeout) {
  timeout = timeout || 9000;
  return new Promise(function (resolve) {
    if (!media || media.readyState < 1) return resolve(false);
    var dur = (isFinite(media.duration) && media.duration > 0) ? media.duration : null;
    t = Math.max(0, dur ? Math.min(t, dur - 0.1) : t);
    if (Math.abs(media.currentTime - t) < 0.03) return resolve(true);
    var on = function () { media.removeEventListener('seeked', on); resolve(true); };
    media.addEventListener('seeked', on);
    try { media.currentTime = t; } catch (e) { /* ignore */ }
    setTimeout(function () { media.removeEventListener('seeked', on); resolve(false); }, timeout);
  });
}

function waitBuffered(media, need, timeout) {
  timeout = timeout || 15000;
  function covered() {
    try {
      var b = media.buffered;
      for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= media.currentTime + 0.15 && b.end(i) >= media.currentTime + need) return true;
      }
    } catch (e) {}
    return false;
  }
  return new Promise(function (resolve) {
    if (covered()) return resolve(true);
    var t0 = performance.now();
    var iv = setInterval(function () {
      if (covered() || performance.now() - t0 > timeout) { clearInterval(iv); resolve(covered()); }
    }, 90);
  });
}

async function safePlay(media) {
  if (!media) return false;
  try { await media.play(); return true; }
  catch (e) {
    if (e && e.name === 'NotAllowedError') S.audioBlocked = true;
    console.error('play() rejected:', e && (e.name || e.message));
    return false;
  }
}

function setNet(kind, text) {
  el.netDot.className = 'net-dot ' + (kind || '');
  el.netText.textContent = text || '';
}
function setStatus(kind, text) {
  el.statLeft.className = 'dot ' + (kind || '');
  el.statLeft.textContent = text || '';
}
function setSub(text) { el.statRight.textContent = text || ''; }
function veil(on, text) {
  if (text) el.veilText.textContent = text;
  el.veil.classList.toggle('on', !!on);
}
function showErr(msg) {
  el.errText.textContent = msg;
  el.errLayer.hidden = false;
}
function hideErr() { el.errLayer.hidden = true; }

/* ---------------------- 分享兜底（读不到链接时） ---------------------- */
/**
 * 原生在 handleIntent 没能抽出 B 站链接时调用。
 * 触发场景实测主要是折叠屏外屏分享：外屏 Sharesheet 可能只传了标题、只传了缩略图，
 * 或者把链接塞在 text/html 的 href 里而系统没透传过来。
 * 此时必须给用户一条出路（手动粘贴），否则表现就是"点了分享毫无反应"。
 */
function showShareFallback(raw) {
  if (!el.shareFallback) return;
  el.sfRaw.textContent = raw ? ('收到的分享内容：' + raw) : '收到的分享内容为空';
  el.shareFallback.hidden = false;
  try { el.sfInput.focus(); } catch (e) {}
  reportDiag('share-fallback raw=' + (raw || '').slice(0, 80));
}
function submitFallback() {
  var v = (el.sfInput.value || '').trim();
  if (!v) { setStatus('err', '请先粘贴链接或 BV 号'); return; }
  el.shareFallback.hidden = true;
  setStatus('busy', '解析中');
  resolveVideo(v);
}

/* ---------------------- localStorage 安全封装 ---------------------- */
function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function safeDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

/* ---------------------- 文本解析 ---------------------- */
function toSec(tok) {
  tok = String(tok == null ? '' : tok).trim().toLowerCase().replace(/：/g, ':').replace(/[^\d\.:hms]/g, '');
  if (!tok) return null;
  if (tok.indexOf(':') >= 0) {
    var p = tok.split(':').map(parseFloat);
    if (p.some(isNaN)) return null;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0];
  }
  var m = tok.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (m && (m[1] || m[2] || m[3])) return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  if (/^\d+(\.\d+)?$/.test(tok)) return parseFloat(tok);
  return null;
}

function normalizeEol(s) {
return (s == null ? '' : String(s)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseText(raw, fallbackDur) {
fallbackDur = fallbackDur || 10;
var segs = [], bad = [], warn = [];
// 换行兼容：Windows(\r\n) / 旧 Mac(\r) / Linux(\n) 统一按 \n 切分，
// 否则 \r 残留会让时间戳与备注文本被截断或挤成一行
var lines = normalizeEol(raw).split('\n');
  for (var n = 0; n < lines.length; n++) {
    var s = (lines[n] || '').trim();
    if (!s) continue;
    s = s.replace(/^[\s\-–—•*·>#]+/, '').replace(/^\d+[\.、\)）]\s*/, '');
    s = s.replace(/[\[\]【】（）()]/g, ' ').replace(/\s+/g, ' ').trim();

    var tm = s.match(/^(\d{1,2}(?::\d{1,2}){1,2})\s*(?:[-~–—]+\s*(\d{1,2}(?::\d{1,2}){1,2}))?/);
    if (!tm) { bad.push({ line: n + 1, text: lines[n].trim() }); continue; }

    var authStart = toSec(tm[1]);
    if (authStart == null) { bad.push({ line: n + 1, text: lines[n].trim() }); continue; }

    var rest = s.slice(tm[0].length).trim();
    var authDur = null;
    if (tm[2]) authDur = toSec(tm[2]) - authStart;
    if (authDur == null || !isFinite(authDur) || authDur <= 0) {
      var dm = rest.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|秒)(?![a-z])/i) || rest.match(/^(\d+(?:\.\d+)?)(?=\s|$)/);
      if (dm) { authDur = parseFloat(dm[1]); rest = rest.slice(dm[0].length).trim(); }
    }
    var inferred = false;
    if (authDur == null || !isFinite(authDur) || authDur <= 0) { authDur = fallbackDur; inferred = true; }

    var padFront = S.padFront || 0;
    var padBack = S.padBack || 0;
    var start = Math.max(0, authStart - padFront);
    var dur = authDur + padFront + padBack;

    var tags = rest.replace(/[，,、]+/g, ' · ').trim();
    segs.push({ start: start, dur: dur, authStart: authStart, authDur: authDur, tags: tags, raw: lines[n].trim(), inferred: inferred, srcLine: n + 1 });
  }

  if (S.videoDuration > 0) {
    for (var k = 0; k < segs.length; k++) {
      var g = segs[k];
      if (g.start >= S.videoDuration - 0.2) {
        bad.push({ line: g.srcLine, text: g.raw, why: '时间戳超出视频总长 ' + fmt(S.videoDuration) });
        g.invalid = true;
      } else if (g.start + g.dur > S.videoDuration) {
        warn.push('第 ' + g.srcLine + ' 行超出片尾，时长已截到 ' + (S.videoDuration - g.start).toFixed(1) + 's');
        g.dur = Math.max(0.6, S.videoDuration - g.start);
      }
    }
  }
  var good = segs.filter(function (g) { return !g.invalid; });
  return { segs: good, bad: bad, warn: warn, inferred: segs.filter(function (g) { return g.inferred; }).length };
}

function renderParseInfo(res) {
  var info = el.parseInfo;
  if (!res.segs.length) {
    info.className = 'parse-info bad';
    info.textContent = '没有识别到任何片段。每行格式：「时间戳 时长 备注」，例如 0:04:02 17s M dr m';
    return;
  }
  var total = res.segs.reduce(function (a, b) { return a + b.dur; }, 0);
  var html = '<b>已识别 ' + res.segs.length + ' 段</b> · 集锦时长 ' + fmt(total);
  if (S.videoDuration > 0) html += ' · 占原片 ' + (total / S.videoDuration * 100).toFixed(1) + '%（' + fmt(S.videoDuration) + '）';
  if (S.padFront > 0 || S.padBack > 0) html += '<br>前补 ' + S.padFront + 's · 后补 ' + S.padBack + 's';
  if (res.inferred) html += '<br>有 ' + res.inferred + ' 行没写时长，按 10s 处理';
  if (res.bad.length) html += '<br>跳过 ' + res.bad.length + ' 行无效时间戳';
  info.className = 'parse-info good';
  info.innerHTML = html;
}

/* ---------------------- 解析视频 ---------------------- */
async function resolveVideo(rawUrl) {
  console.log('[resolve] enter raw=' + rawUrl);
  hideErr();
  var raw = (rawUrl == null ? '' : rawUrl).trim();
  if (!raw) { setStatus('err', '请提供视频链接'); return; }
  stopAll();
  S.token = null; S.info = null; S.hasAudio = false; S.videoDuration = 0;
  S.resumeInfo = null;
  S.resolving = true;
  setNet('busy', '解析视频…');
  setStatus('busy', '解析中');
  setSub('');
  el.metaCard.hidden = true;
  el.resume.hidden = true;
  el.btnFetchReplies.disabled = true;
  try {
    console.log('[resolve] fetching /api/resolve');
    var j = await (await fetch('/api/resolve?url=' + encodeURIComponent(raw)
      + '&p=' + S.page + '&qn=' + S.qn)).json();
    console.log('[resolve] got ok=' + j.ok + ' title=' + (j.title || j.error || ''));
    if (!j.ok) {
      S.resolving = false;
      setNet('err', '解析失败');
      setStatus('err', j.error || '解析失败');
      if (S.sharedTitle) { el.vtitle.textContent = S.sharedTitle; el.metaCard.hidden = false; }
      showErr(j.error || '解析失败');
      return false;
    }
    S.token = j.token; S.info = j; S.videoDuration = j.duration; S.page = j.page;
    S.hasAudio = !!(j.audio && j.audio.id);
    S.resolving = false;
    renderMeta(j);
    setNet('ok', j.title.slice(0, 30));
    setStatus('ok', '已解析');
    setSub(fmt(j.duration) + ' · ' + j.qualityName);
    el.btnFetchReplies.disabled = false;
    // 解析结果已内联时间戳（与 playurl 并行抓取）：有内联结果（即便为空）就直接用，避免重复拉评论；
    // 只有服务端没返回 matched 字段时才回退到单独接口
    if (j.matched !== undefined && j.matched !== null) applyMatched(j.matched || [], j.replyCount || 0, false);
    else fetchRepliesAndRender(j.aid);
    reparse();
    checkResume();
    console.log('[resolve] done, token=' + (S.token || '').slice(0, 8) + ' dur=' + S.videoDuration);
    return true;
  } catch (e) {
    console.error('[resolve] failed: ' + (e && (e.message || e)));
    S.resolving = false;
    setNet('err', '网络错误');
    setStatus('err', '网络错误：' + e.message);
    showErr('网络错误：' + e.message);
    return false;
  }
}

function renderMeta(j) {
  var title = (j.title && j.title.trim()) ? j.title : (S.sharedTitle || '—');
  el.vtitle.textContent = title;
  el.vowner.textContent = j.owner || '—';
  el.vdur.textContent = '时长 ' + fmt(j.duration);
  el.vqn.textContent = (j.qualityName || '') + ' ' + (j.video.width || '?') + '×' + (j.video.height || '?');
  el.vsrc.textContent = j.pages && j.pages.length > 1 ? ('P' + j.page + '/' + j.pages.length) : '单 P';
  el.metaCard.hidden = false;
}

/* ---------------------- 自动从评论拉时间戳 ---------------------- */
function applyMatched(matched, count, doReparse) {
  var m = matched || [];
  el.replyStat.textContent = '已扫 ' + (count || 0) + ' 条评论 · 匹配 ' + m.length + ' 个时间戳';
  el.autoStatus.hidden = false;
  el.autoStatus.textContent = m.length
      ? ('自动从评论扫到 ' + m.length + ' 个时间戳')
      : '该视频评论区没扫到时间戳，可点「示例」或手动输入';
  if (m.length) {
    // 评论是按热度排序返回的，先按时间戳排序（顺带保证片段按时间顺序连播），
    // 再用相邻间隔推断每段时长（封顶 30s，保底 3s），末段用 10s
    var items = [];
for (var i = 0; i < m.length; i++) {
var mm = m[i];
var s0 = toSec(mm.time || '');
// end 可能是 "mm:ss+N"（服务端标记显式时长），这种不能当区间终点
var s1 = (mm.end && mm.end.indexOf('+') < 0) ? toSec(mm.end) : null;
if (s0 == null) continue;
items.push({ m: mm, s0: s0, s1: s1 });
}
items.sort(function (a, b) { return a.s0 - b.s0; });
var lines = items.map(function (it, i) {
var d;
// 服务端给出的显式时长（评论里写了「0:06:48 9s」）优先
if (it.m.dur > 0) d = it.m.dur;
else if (it.s1 != null && it.s1 > it.s0) d = Math.max(3, Math.min(60, it.s1 - it.s0));
else if (i + 1 < items.length && items[i + 1].s0 > it.s0) d = Math.max(3, Math.min(30, items[i + 1].s0 - it.s0));
else d = 10;
var tm = it.m.time || '';
var end = (it.s1 != null) ? '-' + it.m.end : '';
var note = normalizeEol(it.m.text || '').replace(/\s+/g, ' ').trim();
// 服务端未能剔除评论里的裸时长（如「0:06:48 9s …」），这里再兜底一次，
// 否则文本框会出现「0:06:48 18s 9s V m」这种重复数值
note = note.replace(/^\d+(?:\.\d+)?\s*(?:s|sec|秒)\s*/i, '').trim();
return (tm + end + ' ' + d.toFixed(0) + 's ' + note).trim();
});
el.text.value = normalizeEol(lines.join('\n'));
    if (doReparse) reparse();
  }
}

async function fetchRepliesAndRender(aid) {
  if (!aid) return;
  el.replyStat.textContent = '拉取评论中…';
  el.autoStatus.hidden = false;
  el.autoStatus.textContent = '正在拉取评论…';
  el.btnFetchReplies.disabled = true;
  try {
    var j = await (await fetch('/api/replies?aid=' + aid + '&pages=5&ps=20')).json();
    el.btnFetchReplies.disabled = false;
    if (!j.ok) {
      el.replyStat.textContent = '评论拉取失败';
      el.autoStatus.textContent = '评论拉取失败：' + (j.error || '');
      return;
    }
    applyMatched(j.matched || [], j.count || 0, true);
  } catch (e) {
    el.replyStat.textContent = '评论拉取失败';
    el.autoStatus.textContent = '评论拉取失败：' + e.message;
    el.btnFetchReplies.disabled = false;
  }
}

/* ---------------------- 播放器 ---------------------- */
function buildDecks() {
  for (var i = 0; i < 2; i++) {
    var wrap = document.createElement('div');
    wrap.className = 'deck';
    var v = document.createElement('video');
    v.playsInline = true; v.muted = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.addEventListener('error', function () {
      setStatus('err', '视频流中断');
      showErr('视频元素报错 (readyState=' + v.readyState + '，networkState=' + v.networkState + ')');
    });
    var a = document.createElement('audio');
    a.preload = 'auto'; a.muted = true;
    wrap.appendChild(v);
    wrap.appendChild(a);
    el.stage.appendChild(wrap);
    S.decks.push({ el: wrap, v: v, a: a, seg: -1, ready: false, rolling: false, lead: 0 });
  }
}
function activeDeck() { return S.decks[S.active]; }
function otherDeck() { return S.decks[1 - S.active]; }

function setSrc(media, url) {
  if (media.dataset.src === url) return false;
  media.dataset.src = url;
  media.src = url;
  try { media.load(); } catch (e) {}
  return true;
}

async function prepare(d, i, lead) {
  var seg = S.segs[i];
  if (!seg || !S.token) return false;
  var t = Math.max(0, seg.start - lead);
  d.seg = i; d.ready = false; d.rolling = false; d.lead = lead;
  // 先停掉可能正在预热的旧播放，否则换 src 后旧音频会继续外放
  try { d.v.pause(); if (S.hasAudio) d.a.pause(); } catch (e) {}
  setSrc(d.v, '/api/media/' + S.token + '/v?i=0');
  if (S.hasAudio) setSrc(d.a, '/api/media/' + S.token + '/a?i=0');

  if (d.v.readyState < 1) await once(d.v, 'loadedmetadata', 15000);
  if (S.hasAudio && d.a.readyState < 1) await once(d.a, 'loadedmetadata', 15000);
  if (d.v.readyState < 1) {
    console.error('video loadedmetadata timeout, readyState=' + d.v.readyState + ' networkState=' + d.v.networkState
        + ' errCode=' + (d.v.error ? d.v.error.code : '-') + ' src=' + (d.v.currentSrc || d.v.src || '(none)'));
    reportDiag('prepare-fail rs=' + d.v.readyState + ' net=' + d.v.networkState
        + ' err=' + (d.v.error ? d.v.error.code : '-'));
    return false;
  }
  await seekTo(d.v, t);
  if (S.hasAudio) await seekTo(d.a, t);
  await waitBuffered(d.v, Math.min(2.4, Math.max(1.0, seg.dur * 0.5)), 15000);
  if (S.hasAudio) await waitBuffered(d.a, 0.8, 12000);
  d.ready = true;
  d.everReady = true;   // 记住「这个 deck 至少成功准备过一次」，
                         // 老 WebView 上 readyState 会偶发回落，不能只信瞬时值
  return true;
}

/**
 * 预热起播：下一段在「当前段还在播」时就静音滚动起来。
 * 这是让段末切换像分镜一样自然的关键——
 *   旧写法：切换时才开始加载 → 必须显示转圈遮罩 → 观众明确看到「卡了一下」
 *   新写法：画面早已在另一层就位，切换只是把它显示出来 → 硬切，无黑帧、无转圈
 * 音频必须保持 muted，否则会出现两段声音重叠。
 */
async function warmDeck(d) {
  if (!d || !d.ready) return false;
  // readyState<3 (HAVE_FUTURE_DATA) 说明还没拿到可显示帧，此时起播只会播黑，
  // 宁可等到切换时再播（那时才需要 veil）
  if (d.v.readyState < 3) return false;
  d.rolling = true;
  d.v.muted = true;
  if (S.hasAudio) d.a.muted = true;
  try { await d.v.play(); } catch (e) { return false; }
  if (S.hasAudio) { try { await d.a.play(); } catch (e) {} }
  return true;
}

/**
 * 显示第 k 个 deck。
 * hard=true 时（段末硬切）走「立即切换」：不加过渡，保证切换点没有残影；
 * hard=false 时（首播/手动跳段）走 160ms 淡入，掩盖首次解码的黑帧。
 */
function showDeck(k, hard) {
  S.active = k;
  S.decks.forEach(function (d, i) {
    var on = (i === k);
    if (on) {
      if (hard) {
        // 先清掉过渡再置 on，避免与上一镜的淡出状态叠加产生中间灰帧
        d.el.style.transition = 'none';
        d.el.style.opacity = '1';
        d.el.classList.add('on');
        void d.el.offsetWidth;   // 强制回流，让下面的 transition 生效于「之后」的改动
        d.el.style.transition = '';
      } else {
        d.el.classList.add('on');
      }
    } else {
      d.el.classList.remove('on');
    }
    d.v.muted = true;
    d.a.muted = !on || !S.hasAudio || S.muted;
    d.a.volume = clamp(S.vol, 0, 1);
    d.v.playbackRate = S.rate;
    d.a.playbackRate = S.rate;
  });
}

async function startDeck(d) {
  d.rolling = true;
  var ps = [safePlay(d.v)];
  if (S.hasAudio) ps.push(safePlay(d.a));
  await Promise.all(ps);
  if (S.hasAudio && d.v.readyState >= 2 && d.a.readyState >= 2) {
    if (Math.abs(d.a.currentTime - d.v.currentTime) > 0.025) d.a.currentTime = d.v.currentTime;
    d.a.playbackRate = S.rate;
  }
  if (S.audioBlocked) setSub('浏览器拦截了声音，点一下画面任意处即可开启');
}

function nextIndex(i) {
  var n = S.segs.length;
  if (!n) return -1;
  if (S.loop === 'one') return i;
  if (i + 1 < n) return i + 1;
  return S.loop === 'all' ? 0 : -1;
}

function prepareNext() {
  var j = nextIndex(S.idx);
  if (j < 0 || !S.token) { S.pendingIdx = -1; return; }
  var d = otherDeck();
  S.pendingIdx = j;
  var lead = Math.min(S.lead, S.segs[j].start);
  // 提前量：不是"提前 0.35s 就位"，而是要覆盖 lead 秒的时长，
  // 这样预热的 deck 在切换瞬间已经播到 seg.start 附近，硬切才不会有跳帧感。
  var warmLead = Math.min(Math.max(S.lead, 0.6), Math.max(0, S.segs[j].start));
  S.preparing = prepare(d, j, warmLead).then(function (ok) {
    // prepare 成功就立刻静音起播，让浏览器把解码器/渲染管线全部预热，
    // 切换时只需解除静音并显示，不再有「第一帧卡住」
    if (ok) warmDeck(d);
    return ok;
  });
}

/**
 * 切换到第 i 段。
 *
 * 【原来的问题】段末连播也走同一条路径：veil(true) 显示转圈遮罩 → prepare 重新加载
 * → sleep(120) → veil(false)。即使 prepareNext() 已经把下一段准备好了也会重做一遍，
 * 于是每切一段都必然闪一次「载入中」遮罩 + 黑屏，观众看到的是一卡一卡的跳变。
 *
 * 【现在的做法】分两条路径：
 *   fastCut  —— 目标 deck 已 ready 且有可显示帧：直接硬切，不显示任何遮罩。
 *              这就是「分镜」：上一镜结束的那一帧，下一镜已经在画面上了。
 *   slowPath —— 首播 / 缓冲不足 / 用户手动乱跳：才需要 veil 兜底，
 *              并且只在等待超过 400ms 后才显示，避免一闪而过更难看。
 */
async function jumpTo(i, opts) {
  opts = opts || {};
  if (S.busy || i < 0 || i >= S.segs.length || !S.token) return;

  // ---- 快速路径：已预热，直接硬切 ----
  var d = otherDeck();
  // readyState 门槛从 3 放宽到「>=2 或 已预热完成」：
  // 老 WebView 上预热 deck 的 readyState 会偶发掉回 1（缓冲被重置），
  // 严格要求 >=3 会让每次段末切换都退回慢路径、闪一次加载遮罩。
  // 这里只要 deck 确实 ready过，就走硬切 —— 画面已经在那层就位了。
  if (d.seg === i && d.ready && (d.v.readyState >= 2 || d.everReady)) {
    S.busy = true;
    S.idx = i;
    S.pendingIdx = -1;
    S.lastSwitchAt = performance.now();
    showDeck(S.decks.indexOf(d), true);   // 硬切：不加过渡，避免残影
    setStatus('busy', '播放中');
    // 预热阶段 audio 是 muted，这里恢复正常并对齐音画
    await startDeck(d);
    S.playing = true;
    updateToggle();
    el.placeholder.classList.add('hide');
    el.errLayer.hidden = true;
    veil(false);
    S.busy = false;
    updateUI(true);
    updateFsBar();
    revealFsControls(true);
    prepareNext();
    console.log('[cut] fast idx=' + i + ' t=' + d.v.currentTime.toFixed(2));
    return;
  }

  // ---- 慢路径：需要真的加载 ----
  S.busy = true;
  var veilShown = false;
  var veilTimer = setTimeout(function () {
    // 等了 400ms 还没好才亮遮罩：很快的加载根本不需要提示，
    // 一闪而过的遮罩比不显示更容易让人以为卡了
    if (S.busy && !veilShown) { veil(true, opts.text || ('载入第 ' + (i + 1) + ' 段')); veilShown = true; }
  }, 400);
  d.rolling = false;
  var ok = await prepare(d, i, 0);
  if (!ok) { await sleep(500); ok = await prepare(d, i, 0); }
  clearTimeout(veilTimer);
  if (!ok) {
    veil(false);
    setStatus('err', '视频流加载失败');
    showErr('准备第 ' + (i + 1) + ' 段失败：视频元素 15s 内未收到 loadedmetadata。请检查网络或重新解析。');
    S.busy = false;
    return;
  }
  S.idx = i; S.pendingIdx = -1;
  S.lastSwitchAt = performance.now();
  showDeck(S.decks.indexOf(d));
  setStatus('busy', '播放中');
  await startDeck(d);
  S.playing = true;
  updateToggle();
  el.placeholder.classList.add('hide');
  el.errLayer.hidden = true;
  veil(false);
  S.busy = false;
  updateUI(true);
  // 记忆播放：跳转到指定片段内偏移
  if (opts.seekOffset && opts.seekOffset > 0.05) {
    var seg = S.segs[i];
    var rt = seg.start + opts.seekOffset;
    var cur = activeDeck();
    try { cur.v.currentTime = rt; if (S.hasAudio) cur.a.currentTime = rt; } catch (e) {}
    updateHud(rt, seg.start + seg.dur);
  }
  updateFsBar();
  revealFsControls(true);
  console.log('[cut] slow idx=' + i + ' veil=' + veilShown);
  prepareNext();
}

function pauseAll() {
  S.playing = false;
  S.decks.forEach(function (d) { d.v.pause(); if (S.hasAudio) d.a.pause(); });
  updateToggle();
  updateFsBar();
  savePos();
}
async function resumeAll() {
  if (S.idx < 0) { if (S.segs.length) await jumpTo(0); return; }
  S.playing = true;
  var cur = activeDeck();
  await safePlay(cur.v);
  if (S.hasAudio && !cur.a.muted) await safePlay(cur.a);
  updateToggle();
  updateFsBar();
}
function stopAll() {
  S.playing = false;
  S.idx = -1; S.pendingIdx = -1;
  S.decks.forEach(function (d) {
    try { d.v.pause(); d.a.pause(); } catch (e) {}
    d.rolling = false; d.ready = false; d.seg = -1;
    d.el.classList.remove('on');
  });
  S.active = 0;
  updateToggle();
}

/**
 * 把预热中的 deck 钉在正确的时间轴位置上。
 *
 * 预热 deck 从 (下一段.start - warmLead) 开始静音播放，如果不干预，它会一直往前走。
 * 我们要的效果是：当前段播到 ct 时，预热 deck 恰好停在 ct 对应的位置。
 * 因为两段是同一个视频文件里的不同时段，"对应位置" 就是「当前段已播时长 + 下一段起点」。
 *
 * 做法：不真的实时 seek（seek 本身会造成卡顿/闪帧），
 * 而是用 playbackRate 微调 + 偏差超过阈值时才做一次硬 seek。
 * 这样预热 deck 始终"待命"在切换点，一按即切，不会有任何加载动作。
 */
/** 当前播放位置之后已缓冲的秒数（没有缓冲信息时返回 0） */
function bufferedAhead(media) {
  try {
    var b = media.buffered, ct = media.currentTime, best = 0;
    for (var i = 0; i < b.length; i++) {
      if (b.start(i) <= ct + 0.2 && b.end(i) - ct > best) best = b.end(i) - ct;
    }
    return best;
  } catch (e) { return 0; }
}

function followPreheated(ct, curEnd) {
  if (S.pendingIdx < 0 || S.busy) return;
  var d = otherDeck();
  if (!d || !d.ready || !d.rolling || d.seg !== S.pendingIdx) return;
  var nseg = S.segs[S.pendingIdx];
  if (!nseg) return;

  // 当前段的进度（0 ~ seg.dur）映射到下一段内部
  var curSeg = S.segs[S.idx];
  var intoCur = clamp(ct - curSeg.start, 0, curSeg.dur);
  // 目标播放位置 = 下一段起点 + 与当前段相同的相对进度
  // 但只在切换点附近才对齐；远离切换点时让它自由播（省 CPU）
  var target = nseg.start + intoCur;
  var diff = target - d.v.currentTime;

  // 距离切换点还早：让它自由播，不干预（避免频繁 seek 卡顿）
  var remain = curEnd - ct;
  if (remain > 1.2) return;

  if (Math.abs(diff) > 0.28) {
    // 偏差过大：硬 seek 一次对齐（剩余时间已经很短，这一次 seek 用户基本感知不到）
    //
    // 【为什么先查缓冲】老 WebView（实测 Chrome 74 / Note8 Android 9）上，
    // 对一个已经 readyState=4、正在滚动的 video 做 currentTime 硬 seek，
    // 会把缓冲清掉、readyState 掉回 1，等于把这个「已经预热好」的 deck 打回原形——
    // 结果段末切换时 fastCut 判定失败，退回慢路径，每切一段都闪一次加载圈圈。
    // 而N6（WebView 138）上同样 seek 却毫无影响，属老内核特性差异。
    // 缓冲本来就够（覆盖到切换点之后）时完全不需要 seek，直接跳过。
    if (bufferedAhead(d.v) < remain + 0.6) {
      try {
        d.v.currentTime = target;
        if (S.hasAudio) d.a.currentTime = target;
      } catch (e) {}
    }
  } else if (Math.abs(diff) > 0.015) {
    // 偏差很小：用播放速率微调，避免 seek 的卡顿感
    var rate = S.rate * (1 + clamp(-diff * 0.5, -0.06, 0.06));
    d.v.playbackRate = rate;
    if (S.hasAudio) d.a.playbackRate = rate;
  }
  // 偏差已足够小：维持 S.rate 正常速率
  if (Math.abs(diff) <= 0.015) {
    d.v.playbackRate = S.rate;
    if (S.hasAudio) d.a.playbackRate = S.rate;
  }
}

function onSegmentEnd() {
  if (S.busy || performance.now() - S.lastSwitchAt < 150) return;
  var j = nextIndex(S.idx);
  if (j < 0) { pauseAll(); return; }
  jumpTo(j, { text: '切换到第 ' + (j + 1) + ' 段' });
}

/* 相对/绝对 seek（手势拖动用，不重排片段） */
function seekActiveTo(t) {
  if (S.idx < 0 || !S.token) return;
  var seg = S.segs[S.idx];
  var rt = clamp(t, seg.start - S.lead, seg.start + seg.dur - 0.05);
  var d = activeDeck();
  try { d.v.currentTime = rt; if (S.hasAudio) d.a.currentTime = rt; } catch (e) {}
  updateHud(rt, seg.start + seg.dur);
  updateFsBar();
}
function doSeek(deltaSec) {
  if (S.idx < 0) return;
  var d = activeDeck();
  seekActiveTo(d.v.currentTime + deltaSec);
}

/**
 * 主循环：声画对时 + 预热跟随 + 段末切换
 */
function tick() {
  requestAnimationFrame(tick);
  if (S.hasAudio) syncAudio();

  // 位置落盘放在「播放中」判断【之前】：
  // 折叠切屏 / Activity 重建续播依赖这份数据，若只在播放中落盘，
  // 用户暂停后切屏就丢位置（tick 会在下面直接 return）。
  var now = performance.now();
  if (S.idx >= 0 && now - S.lastPosSave > 2000) {
    S.lastPosSave = now;
    savePos();
    updateFsBar();
  }

  if (!S.playing || S.busy || S.idx < 0) return;
  var cur = activeDeck();
  var seg = S.segs[S.idx];
  if (!seg) return;
  var end = seg.start + seg.dur;
  var ct = cur.v.currentTime;

  // 预热 deck 跟随：它已经静音起播，必须被钉在「当前段播放到它自己该出现的位置」上，
  // 否则它会一路播到片段结尾，切换时就成了「跳到片尾」而不是「接着放」。
  followPreheated(ct, end);

  if (ct >= end - 0.012) onSegmentEnd();

  if (now - S.lastHud > 100) {
    S.lastHud = now;
    updateHud(ct, end);
    updateRibbonCursor(ct);
    updateFsBar();
  }
  // 周期性状态上报：便于在无法截图/点击的设备上通过 logcat 观测播放是否真的在推进、
  // 段末是否自动切换（这两项在真机上肉眼难验证，却最容易被机型差异破坏）
  if (now - (S.lastDiag || 0) > 5000) {
    S.lastDiag = now;
    console.log('[tick] idx=' + S.idx + '/' + S.segs.length + ' playing=' + S.playing
        + ' busy=' + S.busy + ' t=' + ct.toFixed(2) + ' end=' + end.toFixed(2)
        + ' paused=' + cur.v.paused + ' rs=' + cur.v.readyState + ' net=' + cur.v.networkState);
  }
}

function syncAudio() {
  var now = performance.now();
  if (now - S.lastSync < 150) return;
  S.lastSync = now;
  S.decks.forEach(function (d) {
    if (d.v.readyState < 2 || d.a.readyState < 2) return;
    if (d.v.paused || d.a.paused) return;
    var err = d.a.currentTime - d.v.currentTime;
    if (Math.abs(err) > 0.35) {
      d.a.currentTime = d.v.currentTime;
      d.v.playbackRate = S.rate;
      d.a.playbackRate = S.rate;
      return;
    }
    d.a.playbackRate = S.rate;
    d.v.playbackRate = S.rate * (1 + clamp(err * 0.45, -0.03, 0.03));
  });
}

/* ---------------------- UI ---------------------- */
function updateToggle() {
  el.btnToggle.disabled = S.idx < 0 && !S.segs.length;
  el.btnToggle.textContent = S.playing ? '❚❚' : '▶';
  el.btnPrev.disabled = S.idx < 1 && !S.segs.length;
  el.btnNext.disabled = S.segs.length === 0;
}
function updateUI(full) {
  var n = S.segs.length;
  el.listStat.textContent = n ? ((S.idx >= 0 ? (S.idx + 1) : '—') + ' / ' + n + ' 段') : '—';
  if (full && n) {
    var nodes = el.segList.querySelectorAll('.seg');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('on', i === S.idx);
    var on = nodes[S.idx];
    if (on) keepSegVisible(on);
    var blocks = el.ribbon.querySelectorAll('.seg-block');
    for (var j = 0; j < blocks.length; j++) blocks[j].classList.toggle('on', j === S.idx);
  }
}
// 只滚动片段列表容器内部，把当前段滚进可视区；
// 不能用 scrollIntoView——它会滚动整个页面，把播放器藏出屏幕（手机上尤其明显）。
function keepSegVisible(node) {
  var list = el.segList;
  if (list.scrollHeight <= list.clientHeight + 2) return;
  var nr = node.getBoundingClientRect(), lr = list.getBoundingClientRect();
  if (nr.top < lr.top) list.scrollTop -= (lr.top - nr.top) + 4;
  else if (nr.bottom > lr.bottom) list.scrollTop += (nr.bottom - lr.bottom) + 4;
}
function updateHud(ct, end) {
  var seg = S.segs[S.idx];
  if (!seg) { el.nowseg.textContent = S.segs.length ? ('0/' + S.segs.length + ' · 0:00') : '--:--'; return; }
  var done = Math.max(0, Math.min(seg.dur, ct - seg.start));
  // 控制条空间有限，段号用「当前/总数」的紧凑写法
  el.nowseg.textContent = (S.idx + 1) + '/' + S.segs.length + ' · ' + fmt(seg.start + done);
}
/** 时间轴：游标 + 已播填充。两者都用「全片位置」表达，与时间轴上的分段块对齐 */
function updateRibbonCursor(ct) {
  if (!S.videoDuration) return;
  var p = clamp(ct / S.videoDuration * 100, 0, 100);
  var cursor = el.ribbon.querySelector('.cursor');
  if (cursor) cursor.style.left = p + '%';
  if (el.trackFill) el.trackFill.style.width = p + '%';
}

function renderSegList() {
  var segs = S.segs;
  el.segList.innerHTML = segs.length ? '' : '<p class="empty">解析后显示片段</p>';
  for (var i = 0; i < segs.length; i++) {
    (function (g, idx) {
      var div = document.createElement('div');
      div.className = 'seg';
      div.innerHTML = '<span class="no">' + (idx + 1) + '</span>'
        + '<span class="mid"><div class="ts">' + fmt(g.authStart || g.start) + '</div>'
        + '<div class="tg">' + (g.tags || '—') + '</div></span>'
        + '<span class="dur">' + g.dur.toFixed(1) + 's</span>';
      div.onclick = function () {
        this.blur();   // 防止点击聚焦时浏览器把页面滚走
        if (S.token) jumpTo(idx); else setStatus('err', '请先解析视频');
      };
      el.segList.appendChild(div);
    })(segs[i], i);
  }
}
function renderRibbon() {
  // 只清段块：.trk-fill 与 .cursor 是常驻节点，整块 innerHTML='' 会把它们一起清掉，
  // 之后 updateRibbonCursor 就再也找不到游标（表现为进度指示不动）。
  var olds = el.ribbon.querySelectorAll('.seg-block');
  for (var n = 0; n < olds.length; n++) {
    if (olds[n].parentNode) olds[n].parentNode.removeChild(olds[n]);
  }
  var total = S.videoDuration || Math.max.apply(null, S.segs.map(function (s) { return s.start + s.dur; }).concat([1]));
  for (var i = 0; i < S.segs.length; i++) {
    (function (g, idx) {   // IIFE 包住 idx，否则 var 捕获会让所有块都跳最后一段
      var b = document.createElement('div');
      b.className = 'seg-block';
      b.style.left = (g.start / total * 100) + '%';
      b.style.width = Math.max(0.4, g.dur / total * 100) + '%';
      b.onclick = function (e) { e.stopPropagation(); if (S.token) jumpTo(idx); };
      el.ribbon.appendChild(b);
    })(S.segs[i], i);
  }
  if (!el.ribbon.querySelector('.cursor')) {
    var c = document.createElement('div');
    c.className = 'cursor';
    c.style.left = '0%';
    el.ribbon.appendChild(c);
  }
  if (el.trackFill) el.trackFill.style.width = '0%';
  el.ribbon.onclick = function (e) {
    if (!S.token || !S.segs.length) return;
    var r = el.ribbon.getBoundingClientRect();
    var t = (e.clientX - r.left) / r.width * total;
    var best = 0, bd = Infinity;
    for (var k = 0; k < S.segs.length; k++) {
      var d = Math.abs(S.segs[k].start - t);
      if (d < bd) { bd = d; best = k; }
    }
    jumpTo(best);
  };
}

function reparse() {
  try {
    S.padFront = +el.padFront.value || 0;
    S.padBack = +el.padBack.value || 0;
    var res = parseText(el.text.value, 10);
    S.segs = res.segs; S.parsed = res;
    renderParseInfo(res);
    renderSegList();
    renderRibbon();
    S.idx = -1;
    updateUI(true);
    // 侧栏默认收起，所以按钮上要有「里面有几段」的提示，否则用户不知道能点开
    if (el.btnList) {
      el.btnList.title = '片段 / 时间戳（' + res.segs.length + ' 段）';
      el.btnList.classList.toggle('on', res.segs.length > 0 && !S.sideOpen);
    }
    updateToggle();
    checkResume();
    console.log('[reparse] ok segs=' + res.segs.length);
  } catch (e) {
    // 逐段定位是哪个渲染函数在不同内核/机型上抛错，避免整条链路静默中断
    console.error('[reparse] FAILED: ' + (e && e.message ? e.message : e)
        + ' @' + (e && e.stack ? String(e.stack).split('\n')[1] : ''));
    reportDiag('reparse-fail ' + (e && e.message ? e.message : e));
    throw e;
  }
}

/* ---------------------- 记忆播放（续播） ---------------------- */
function posKey() { return S.info && S.info.bvid ? ('hplayer_pos_' + S.info.bvid) : null; }
function savePos() {
  // 暂停时也要落盘：Activity 被回收/折叠重建后正要靠这份数据续播，
  // 若这里因为 !S.playing 直接返回，重建后就只能从头播。
  if (S.idx < 0 || !S.token) return;
  var key = posKey();
  if (!key) return;
  var d = activeDeck();
  if (!d || !d.v || !isFinite(d.v.currentTime)) return;
  var t = d.v.currentTime;
  safeSet(key, JSON.stringify({ idx: S.idx, t: t }));
  reportPos(S.idx, t);
}
/** 把当前播放位置推给原生，供 Activity 被回收/重建后接续（native 的 onSaveInstanceState 会读这份缓存） */
function reportPos(idx, t) {
  try {
    if (window.BiliBridge && BiliBridge.reportPos) BiliBridge.reportPos(idx, t);
  } catch (e) {}
}
/** 供 native 在 onSaveInstanceState 里同步调用：立刻把位置刷进 localStorage + 上报原生 */
function savePosNow() {
  savePos();
  try { if (window.BiliBridge && BiliBridge.diag) BiliBridge.diag('[savePosNow] idx=' + S.idx); } catch (e) {}
}
function checkResume() {
  el.resume.hidden = true;
  var key = posKey();
  if (!key || !S.segs.length) return;
  var raw = safeGet(key);
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (p && typeof p.idx === 'number' && p.idx >= 0 && p.idx < S.segs.length && isFinite(p.t)) {
      S.resumeInfo = p;
      var seg = S.segs[p.idx];
      el.resumeText.textContent = '上次看到 第 ' + (p.idx + 1) + ' 段 ' + fmt(seg.authStart || seg.start)
        + '（' + fmt(p.t - seg.start) + ' 处）';
      el.resume.hidden = false;
    }
  } catch (e) {}
}

/* ---------------------- 静音 ---------------------- */
function applyMute() {
  S.decks.forEach(function (d, i) {
    d.a.muted = (i !== S.active) || !S.hasAudio || S.muted;
    d.a.volume = clamp(S.vol, 0, 1);
  });
  el.btnMute.textContent = S.muted ? '🔇' : '🔊';
  el.btnMute.title = S.muted ? '取消静音' : '静音';
}
function toggleMute() {
  S.muted = !S.muted;
  applyMute();
  if (!S.muted && S.audioBlocked) S.audioBlocked = false;
}

/* ---------------------- 侧栏（片段 + 时间戳）与二级设置 ---------------------- */
/**
 * 侧栏默认收起 —— 用户明确要求「给画面留出足够空间」：
 * 片段列表和评论时间戳都是「要看才开」的辅助信息，不该常驻占屏。
 * 两种形态二选一（设置里切换）：
 *   inline：排在视频下方，宽屏时靠右侧成两列；
 *   float ：覆盖在页面右侧的浮窗，点遮罩收起。
 */
function applySideMode() {
  document.body.classList.toggle('side-float', S.sideMode === 'float');
  document.body.classList.toggle('side-open', !!S.sideOpen);
  if (el.sideMode) el.sideMode.value = S.sideMode;
  if (el.side) el.side.hidden = !S.sideOpen;
  if (el.sideMask) el.sideMask.hidden = !(S.sideOpen && S.sideMode === 'float');
}
function toggleSide(force) {
  S.sideOpen = (force === undefined) ? !S.sideOpen : !!force;
  if (S.sideOpen && S.settingsOpen) toggleSettings(false);
  applySideMode();
  // 展开时把当前段滚进可视区（只滚列表容器内部 —— scrollIntoView 会把播放器顶出屏幕）
  if (S.sideOpen && S.sideTab === 'segs' && S.idx >= 0) {
    var nodes = el.segList.querySelectorAll('.seg');
    if (nodes[S.idx]) keepSegVisible(nodes[S.idx]);
  }
  if (el.btnList) el.btnList.classList.toggle('on', !S.sideOpen && S.segs.length > 0);
  reportDiag('side-' + (S.sideOpen ? 'open' : 'close') + ' mode=' + S.sideMode);
}
function setSideMode(mode) {
  S.sideMode = (mode === 'float') ? 'float' : 'inline';
  safeSet('hplayer_side_mode', S.sideMode);
  applySideMode();
  BiliBridgeToast(S.sideMode === 'float' ? '片段面板：右侧浮窗' : '片段面板：内嵌');
}
function switchTab(tab) {
  S.sideTab = (tab === 'text') ? 'text' : 'segs';
  var btns = (el.sideTabs ? el.sideTabs.querySelectorAll('.stab') : []);
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === S.sideTab);
  }
  if (el.paneSegs) el.paneSegs.classList.toggle('on', S.sideTab === 'segs');
  if (el.paneText) el.paneText.classList.toggle('on', S.sideTab === 'text');
}
function toggleSettings(force) {
  S.settingsOpen = (force === undefined) ? !S.settingsOpen : !!force;
  if (el.settings) el.settings.hidden = !S.settingsOpen;
}

/* ---------------------- 全屏模式 ---------------------- */
function setUiMode(mode) {
  S.uiMode = mode;
  if (mode === 'fullscreen') {
    // 全屏要的是纯画面：侧栏与设置抽屉必须先收起，否则会叠在视频上
    if (S.sideOpen) toggleSide(false);
    if (S.settingsOpen) toggleSettings(false);
    document.body.classList.add('fullscreen');
    document.body.classList.remove('fs-hide');
    // 进入全屏时清掉可能的缩放（横屏后由 resize 重新计算）
    var w = document.querySelector('#appWrap');
    if (w) { w.style.transform = ''; w.style.webkitTransform = ''; }
    if (typeof revealFsControls === 'function') revealFsControls();
  } else {
    document.body.classList.remove('fullscreen', 'fs-hide', 'fs-lock', 'fs-keep');
    S.locked = false; S.keepUi = false;
    if (fsTimer) { clearTimeout(fsTimer); fsTimer = 0; }
    if (el.fsLock) el.fsLock.textContent = '🔒';
    if (el.fsKeep) el.fsKeep.textContent = '📍';
    if (el.fsBarFill) el.fsBarFill.style.width = '0%';
    applyViewportScale();
  }
}
function enterFullscreen() {
  if (window.BiliBridge && BiliBridge.toggleFullScreen) BiliBridge.toggleFullScreen();
  else setUiMode('fullscreen');
}
var fsTimer = 0;
var FS_HIDE_MS = 3600;
/**
 * 全屏控制条显隐。
 * 原实现只有一个 3.2s 定时器无条件加 .fs-hide，用户反馈「播放时进度条自己消失了」——
 * 根因是：定时器在「刚进入全屏」「刚拖完进度条」「刚做完双击跳转」后都会继续计时，
 * 于是控件在用户还在看的时候淡出，且淡出后连进度指示也一起没了，看起来像进度条坏了。
 * 现在的规则：
 *   1) 暂停时永不隐藏（用户需要按钮）；
 *   2) 手势/拖动进行中永不隐藏；
 *   3) 常显开关（S.keepUi）打开时永不隐藏；
 *   4) 锁定态（S.locked）仍按旧逻辑隐藏叠加层，这是防误触的设计意图；
 *   5) 无论控制条显隐，底部 #fsBar 这条细进度条始终可见并反映当前段进度。
 */
function revealFsControls(sticky) {
  if (S.uiMode !== 'fullscreen') return;
  document.body.classList.remove('fs-hide');
  if (fsTimer) { clearTimeout(fsTimer); fsTimer = 0; }
  if (sticky || fsShouldKeep()) return;
  fsTimer = setTimeout(function () { fsTimer = 0; hideFsControls(); }, FS_HIDE_MS);
}
function fsShouldKeep() {
  return !!(S.keepUi || !S.playing || S.gesturing || S.scrubbing || gs.mode);
}
/** 播放进度推进时刷新常驻细进度条（控制条隐藏时也能看到播到哪里） */
function updateFsBar() {
  if (!el.fsBarFill) return;
  if (S.uiMode !== 'fullscreen' || S.idx < 0 || !S.segs[S.idx]) { el.fsBarFill.style.width = '0%'; return; }
  var seg = S.segs[S.idx];
  var d = activeDeck();
  var t = d && d.v ? d.v.currentTime : 0;
  var p = seg.dur > 0 ? clamp((t - seg.start) / seg.dur, 0, 1) : 0;
  el.fsBarFill.style.width = (p * 100).toFixed(2) + '%';
}
function hideFsControls() {
  if (S.uiMode !== 'fullscreen') return;
  if (fsShouldKeep()) return;
  document.body.classList.add('fs-hide');
}
function toggleKeepUi() {
  S.keepUi = !S.keepUi;
  if (el.fsKeep) {
    el.fsKeep.textContent = S.keepUi ? '📌' : '📍';
    el.fsKeep.title = S.keepUi ? '常显已开启：控制条不再自动隐藏' : '常显已关闭：控制条 3.6s 无操作自动隐藏';
  }
  document.body.classList.toggle('fs-keep', S.keepUi);
  revealFsControls(true);
  BiliBridgeToast(S.keepUi ? '控制条常显' : '控制条自动隐藏');
}

/* 中心播放/暂停图标闪现 */
function flashCenter(playing) {
  el.centerPlay.textContent = playing ? '❚❚' : '▶';
  el.centerPlay.classList.add('show');
  clearTimeout(el.centerPlay._t);
  el.centerPlay._t = setTimeout(function () { el.centerPlay.classList.remove('show'); }, 600);
}

/* 暂停/播放切换（供按钮与手势共用） */
function togglePlayPause() {
  if (S.idx < 0 && S.segs.length) { jumpTo(0); return; }
  if (S.playing) pauseAll(); else resumeAll();
  flashCenter(S.playing);
}

/* ---------------------- 手势（播放器内） ---------------------- */
var gs = { x0: 0, y0: 0, t0: 0, dx: 0, dy: 0, moved: false, mode: null, lastTap: 0, locked: false, skip: false };

function stageWidth() { return el.stage.clientWidth || window.innerWidth; }

function dxToTime(dx) {
  if (!S.videoDuration) return 0;
  return dx / stageWidth() * S.videoDuration * 1.2;
}
function updateSeekPreview(dx) {
  if (S.idx < 0) return;
  var d = activeDeck();
  var target = clamp(d.v.currentTime + dxToTime(dx), 0, S.videoDuration);
  el.seekPreview.textContent = '↔ ' + fmt(target);
  el.seekPreview.classList.add('show');
}
function hideSeekPreview() { el.seekPreview.classList.remove('show'); }

function adjustVol(delta) {
  S.vol = clamp(S.vol - delta * 0.005, 0, 1);
  el.vol.value = S.vol;
  S.decks.forEach(function (d) { d.a.volume = S.vol; });
  if (S.muted && S.vol > 0) { S.muted = false; applyMute(); }
  BiliBridgeToast('音量 ' + Math.round(S.vol * 100) + '%');
}
function adjustBright(delta) {
  if (!window.BiliBridge || !BiliBridge.getBrightness) return;
  var cur = BiliBridge.getBrightness();
  if (typeof cur !== 'number' || cur < 0) cur = 1;
  var v = clamp(cur - delta * 0.004, 0.05, 1);
  BiliBridge.setBrightness(v);
  BiliBridgeToast('亮度 ' + Math.round(v * 100) + '%');
}
function BiliBridgeToast(msg) {
  if (window.BiliBridge && BiliBridge.toast) { try { BiliBridge.toast(msg); } catch (e) {} }
}

/**
 * 落点是不是「按钮」——播放器上的全屏叠层按钮（✕/🔒/📍）和右上角轻按钮（☰/⚙）。
 * 这些按钮在 #stage 内部，触摸会冒泡到 stage 的手势处理。
 */
function isStageButton(target) {
  if (!target || !target.closest) return false;
  if (target.closest('.fs-btn')) return true;
  if (target.closest('.ov-btn')) return true;
  return false;
}
function onGestureStart(e) {
  // 按钮自己有 onclick，手势必须整体让开。
  // 关键：光在 touchstart 里 return 是不够的 —— touchend 仍会跑到 onGestureEnd
  // 并执行单击逻辑，于是「点一下常显按钮，视频也跟着暂停了」（用户报的冲突）。
  // 所以这里打一个 skip 标记，让 onGestureEnd 也一起跳过。
  gs.skip = false;
  if (isStageButton(e.target)) { gs.skip = true; return; }
  if (S.locked && e.target.id !== 'fsLock' && e.target.id !== 'fsKeep') { gs.skip = true; return; }
  var t = e.touches[0];
  gs.x0 = t.clientX; gs.y0 = t.clientY; gs.t0 = performance.now();
  gs.moved = false; gs.mode = null; gs.dx = 0; gs.dy = 0;
  S.gesturing = true;
}
function onGestureMove(e) {
  if (gs.skip) return;
  if (S.locked && e.target.id !== 'fsLock' && e.target.id !== 'fsKeep') return;
  if (isStageButton(e.target)) return;
  var t = e.touches[0];
  var dx = t.clientX - gs.x0, dy = t.clientY - gs.y0;
  gs.dx = dx; gs.dy = dy;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) gs.moved = true;
  if (S.uiMode !== 'fullscreen') return; // 普通模式不做滑动手势
  if (gs.mode === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
    if (Math.abs(dx) > Math.abs(dy)) gs.mode = 'seek';
    else gs.mode = (gs.x0 < window.innerWidth / 2) ? 'bright' : 'vol';
    S.scrubbing = (gs.mode === 'seek');
    revealFsControls(true); // 操作期间强制常显，抬手后再开始倒计时
  }
  if (gs.mode === 'seek') {
    e.preventDefault();
    updateSeekPreview(dx);
  } else if (gs.mode === 'vol') {
    e.preventDefault();
    adjustVol(-(t.clientY - (gs.lastY || gs.y0)));
    gs.lastY = t.clientY;
  } else if (gs.mode === 'bright') {
    e.preventDefault();
    adjustBright(-(t.clientY - (gs.lastY || gs.y0)));
    gs.lastY = t.clientY;
  }
}
function onGestureEnd() {
  S.gesturing = false; S.scrubbing = false;
  // 起点落在按钮上：整段手势作废，不产生单击/双击 —— 否则按钮会和播放/暂停打架
  if (gs.skip) { gs.skip = false; gs.moved = false; gs.mode = null; return; }
  if (S.locked) { if (gs.moved) gs.moved = false; gs.mode = null; return; }
  var dt = performance.now() - gs.t0;
  if (!gs.moved) {
    handleTap();
  } else if (S.uiMode === 'fullscreen') {
    if (gs.mode === 'seek') { doSeek(dxToTime(gs.dx)); hideSeekPreview(); }
  }
  gs.moved = false; gs.mode = null;
  if (S.uiMode === 'fullscreen') revealFsControls();
}
function handleTap() {
  var now = performance.now();
  if (now - gs.lastTap < 300) {
    gs.lastTap = 0;
    // 双击
    if (S.uiMode !== 'fullscreen') { enterFullscreen(); flashCenter(S.playing); }
    else {
      var left = gs.x0 < window.innerWidth / 2;
      doSeek(left ? -10 : 10);
      revealFsControls();
    }
  } else {
    gs.lastTap = now;
    setTimeout(function () {
      if (gs.lastTap && performance.now() - gs.lastTap >= 290) {
        gs.lastTap = 0;
        togglePlayPause();
        if (S.uiMode === 'fullscreen') revealFsControls();
      }
    }, 300);
  }
}
function bindGestures() {
  el.stage.addEventListener('touchstart', onGestureStart, { passive: true });
  el.stage.addEventListener('touchmove', onGestureMove, { passive: false });
  el.stage.addEventListener('touchend', onGestureEnd, { passive: true });
  el.stage.addEventListener('touchcancel', onGestureEnd, { passive: true });
  // 全屏下任意触摸都唤起控制条
  document.addEventListener('touchstart', function () { if (S.uiMode === 'fullscreen') revealFsControls(); }, true);
  // 鼠标（折叠屏外接键鼠 / 平板 / 桌面浏览器调试时）也要能唤起，
  // 否则外接鼠标场景下控制条一旦淡出就只能靠触摸回来
  document.addEventListener('mousemove', function () {
    if (S.uiMode === 'fullscreen') revealFsControls();
  }, true);
}

/* ---------------------- 事件 ---------------------- */
var DEMO = '0:00:12 10s 前奏起\n0:00:38 12s 主歌进\n0:01:15 10s 副歌\n0:01:52 12s 间奏\n0:02:20 10s 二段主歌\n0:02:55 15s 尾段副歌\n0:03:20 8s 收尾';
var TEST_BV = 'BV1GJ411x7h7';   // bilibili 官方"测试视频"短片

el.btnPrev.onclick = function () { if (S.idx > 0) jumpTo(S.idx - 1); else if (S.segs.length) jumpTo(S.segs.length - 1); };
el.btnNext.onclick = function () { var j = nextIndex(S.idx); if (j >= 0) jumpTo(j); };
el.btnToggle.onclick = function () { togglePlayPause(); };
el.btnFull.onclick = function () { enterFullscreen(); };
el.btnMute.onclick = function () { toggleMute(); };
el.fsExit.onclick = function () { enterFullscreen(); };
el.fsLock.onclick = function () {
  S.locked = !S.locked;
  document.body.classList.toggle('fs-lock', S.locked);
  el.fsLock.textContent = S.locked ? '🔓' : '🔒';
  BiliBridgeToast(S.locked ? '已锁定，防误触' : '已解锁');
  revealFsControls(true);
};
el.fsKeep.onclick = function () { this.blur(); toggleKeepUi(); };
el.btnDemo.onclick = function () { el.text.value = DEMO; console.log('[demo] fill', DEMO.split('\n').length, 'lines'); reparse(); };
el.btnClear.onclick = function () { el.text.value = ''; reparse(); };
el.btnFetchReplies.onclick = function () {
  if (S.info && S.info.aid) fetchRepliesAndRender(S.info.aid);
  else setStatus('err', '请先解析视频');
};
el.btnTestVideo.onclick = function () { toggleSettings(false); resolveVideo(TEST_BV); };

// 侧栏 / 二级设置
el.btnList.onclick = function () { this.blur(); toggleSide(); };
el.btnSet.onclick = function () { this.blur(); toggleSettings(); };
el.setClose.onclick = function () { toggleSettings(false); };
el.settings.onclick = function (e) { if (e.target === el.settings) toggleSettings(false); };
el.sideClose.onclick = function () { toggleSide(false); };
el.sideMask.onclick = function () { toggleSide(false); };
el.sideMode.onchange = function () { setSideMode(el.sideMode.value); };
el.sideTabs.onclick = function (e) {
  // Chrome 74 有 closest，但为了跟老内核保持一致这里手动向上找，避免 className 是 SVGAnimatedString 的坑
  var t = e.target;
  while (t && t !== el.sideTabs) {
    if (t.className && String(t.className).indexOf('stab') >= 0) break;
    t = t.parentNode;
  }
  if (!t || t === el.sideTabs) return;
  switchTab(t.getAttribute('data-tab'));
};
el.errRetry.onclick = function () {
  hideErr();
  if (S.info && S.info.bvid) resolveVideo(S.info.bvid);
  else setStatus('err', '没有可重试的视频');
};
el.resumeGo.onclick = function () {
  if (!S.resumeInfo) return;
  var p = S.resumeInfo;
  var seg = S.segs[p.idx];
  if (!seg) return;
  el.resume.hidden = true;
  jumpTo(p.idx, { seekOffset: p.t - seg.start, text: '续播 第 ' + (p.idx + 1) + ' 段' });
};
el.resumeReset.onclick = function () { var k = posKey(); if (k) safeDel(k); S.resumeInfo = null; el.resume.hidden = true; };
el.loop.onchange = function () { S.loop = el.loop.value; };
el.rate.onchange = function () {
  S.rate = +el.rate.value;
  S.decks.forEach(function (d) { d.v.playbackRate = S.rate; d.a.playbackRate = S.rate; });
};
el.vol.oninput = function () {
  S.vol = +el.vol.value;
  S.decks.forEach(function (d, i) { d.a.volume = S.vol; d.a.muted = (i !== S.active) || !S.hasAudio || S.muted; });
};
el.padFront.onchange = function () { S.padFront = +el.padFront.value || 0; reparse(); };
el.padBack.onchange = function () { S.padBack = +el.padBack.value || 0; reparse(); };
el.text.addEventListener('input', reparse);

// 分享兜底
el.sfGo.onclick = submitFallback;
el.sfClose.onclick = function () { el.shareFallback.hidden = true; };
el.sfInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); submitFallback(); }
});

document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); el.btnToggle.click(); }
  else if (e.key === 'ArrowRight') el.btnNext.click();
  else if (e.key === 'ArrowLeft') el.btnPrev.click();
  else if (e.key === 'KeyF') enterFullscreen();
  else if (e.key === 'KeyL') toggleSide();
  else if (e.key === 'Escape') {
    if (S.settingsOpen) toggleSettings(false);
    else if (S.sideOpen) toggleSide(false);
  }
});
document.addEventListener('click', function () {
  if (!S.audioBlocked) return;
  S.audioBlocked = false;
  var cur = activeDeck();
  if (cur && cur.a) { cur.a.muted = false; safePlay(cur.a); }
  setSub('');
}, true);

/* ---------------------- 启动 ---------------------- */
/**
 * 把前端内部状态回传原生日志。
 * 必要原因：部分机型（带密码锁屏）无法截图/点击，logcat 是唯一可观测通道。
 * 同时打印关键元素的布局信息，用于排查「视口宽度差异导致布局/点击错位」。
 */
function reportDiag(tag) {
  var parts = [];
  try {
    parts.push('cssW=' + window.innerWidth + 'x' + window.innerHeight);
var st = document.querySelector('#stage');
if (st) {
var r = st.getBoundingClientRect();
parts.push('stage=' + Math.round(r.width) + 'x' + Math.round(r.height)
+ '@' + Math.round(r.left) + ',' + Math.round(r.top));
//逐级量宽度：定位「视频区塌陷」到底出在哪个父级
['#appWrap', '#app', '.col-main', '.player-wrap'].forEach(function (sel) {
var e = document.querySelector(sel);
if (!e) return;
var b = e.getBoundingClientRect();
var cs = window.getComputedStyle(e);
parts.push(sel + '=' + Math.round(b.width) + 'x' + Math.round(b.height)
+ '/maxW=' + cs.maxWidth + '/disp=' + cs.display + '/padT=' + cs.paddingTop);
});
}
    var vids = document.querySelectorAll('video');
    parts.push('videos=' + vids.length);
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      var vb = v.getBoundingClientRect();
      parts.push('v' + i + '[src=' + (v.currentSrc || v.src || '(none)').slice(-28)
          + ' rs=' + v.readyState + ' net=' + v.networkState
          + ' err=' + (v.error ? v.error.code : '-')
          + ' box=' + Math.round(vb.width) + 'x' + Math.round(vb.height) + ']');
    }
    parts.push('segs=' + (S && S.segs ? S.segs.length : 0));
    // 列表项位置：真机无法截图时用于定位点击坐标，也用于验证布局在不同视口下是否合理
    var items = document.querySelectorAll('#segList .seg');
    if (items.length) {
      var f = items[Math.min(2, items.length - 1)].getBoundingClientRect();
      parts.push('segItems=' + items.length + ' item2=' + Math.round(f.left) + ',' + Math.round(f.top)
          + ' ' + Math.round(f.width) + 'x' + Math.round(f.height));
    } else {
      parts.push('segItems=0');
    }
    var lst = document.querySelector('#segList');
    if (lst) { var lb = lst.getBoundingClientRect(); parts.push('listBox=' + Math.round(lb.left) + ',' + Math.round(lb.top) + ' ' + Math.round(lb.width) + 'x' + Math.round(lb.height)); }
    var aw = document.querySelector('#appWrap');
    if (aw) parts.push('wrapTf=' + (aw.style.transform || 'none'));
  } catch (e) {
    parts.push('diagErr=' + e.message);
  }
  var line = '[diag:' + tag + '] ' + parts.join(' | ');
  console.log(line);
  try { if (window.BiliBridge && BiliBridge.diag) BiliBridge.diag(line); } catch (e2) {}
}

function loadFromNative() {
  var q;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }
  var bv = q.get('bv');
  var demo = q.get('demo') === '1';
  var title = q.get('title');
  // 折叠屏切屏 / Activity 重建后由原生带上来的续播坐标：ridx=段序号，rt=段内秒数
  var ridx = parseInt(q.get('ridx') || '-1', 10);
  var rt = parseFloat(q.get('rt') || '-1');
  var resume = (ridx >= 0 && isFinite(rt) && rt >= 0);
  if (title) S.sharedTitle = title;
  console.log('[init] bv=' + bv + ' demo=' + demo + ' title=' + title
      + ' resume=' + resume + ' ridx=' + ridx + ' rt=' + rt
      + ' cssW=' + window.innerWidth + ' dpr=' + window.devicePixelRatio);
  if (bv) {
    console.log('[init] calling resolveVideo(' + bv + ')');
    resolveVideo(bv).then(function (ok) {
      console.log('[init] resolve returned ok=' + ok + ' demo=' + demo + ' resume=' + resume);
      reportDiag('resolve-done ok=' + ok + ' resume=' + resume);
      if (!ok) return;
      if (demo) el.btnDemo.click();
      if (resume) {
        // 折叠切屏续播：直接跳到原段落与段内位置，不弹续播提示条（用户要的是「接上」）
        if (ridx < S.segs.length) jumpTo(ridx, { seekOffset: rt, text: '续播 第 ' + (ridx + 1) + ' 段' });
        else waitAndPlay(0);
      } else if (demo) {
        waitAndPlay(0);
      }
    }).catch(function (e) {
      console.error('[init] resolve threw: ' + (e && (e.message || e)));
    });
  } else if (demo) {
    el.btnDemo.click();
  }
}

function waitAndPlay(tries) {
  if (S.token && S.segs.length > 0 && S.idx < 0) {
    console.log('[autoPlay] start token=' + String(S.token).slice(0, 8) + ' segs=' + S.segs.length + ' tries=' + tries);
    // 直接调用播放函数，不走 btnToggle.click()：
    // 按钮的 disabled 状态受 updateToggle/时序影响，disabled 时 click() 会被静默忽略，
    // 导致「点了测试视频但没有任何反应」。
    jumpTo(0);
    return;
  }
  if (tries > 80) { setStatus('err', '自动播放等待超时'); reportDiag('autoplay-timeout token=' + !!S.token + ' segs=' + S.segs.length + ' idx=' + S.idx); return; }   // ~40s
  if (tries % 20 === 0) console.log('[autoPlay] wait tries=' + tries + ' token=' + !!S.token + ' segs=' + S.segs.length + ' idx=' + S.idx);
  setTimeout(function () { waitAndPlay(tries + 1); }, 500);
}

// 系统"显示大小"放大会把 WebView 实际 density 推高，innerWidth 被压到 ~125 CSS px，
// 而页面按 ~420 CSS px 设计。用 wrap 容器整体 scale 补偿（topbar/statusbar 在 wrap 外，不受影响）。
// 注意：脚本执行时 WebView 可能还没布局（innerWidth=0），这时必须跳过，否则 scale(0) 会把页面缩没。
function applyViewportScale() {
  if (document.body.classList.contains('fullscreen')) return; // 全屏横屏由 CSS 接管
  var cssW = window.innerWidth;
  if (cssW < 40) return;   // 未布局/异常宽度，不动
  var natural = 420;
  var w = document.querySelector('#appWrap');
  if (!w) return;
if (cssW >= natural - 20) {
// 视口比设计宽度更宽（平板/折叠屏展开/横屏，CSS px 可达 800~1000）：
// 不做缩放。此时 CSS 媒体查询(@min-width:700px) 会把 .app 变成两列布局
// （主列 + 340px 侧栏），这里只清理 inline 残留。
// 注意：不要在此给 .app 限宽到 ~460px —— 那与两列布局冲突：
// 460px 装不下「主列 + 340px 侧栏」，flex 会把主列压到 ~78px，
// 进而 .player-wrap 的 padding-top:56.25% 算出来只有 44px 高，
// 整个视频区塌陷（真机实测 cssW=813 时 stage 仅 78x44）。
w.style.transform = '';
w.style.webkitTransform = '';
w.style.pointerEvents = '';
w.style.width = '';
w.style.maxWidth = '';
w.style.marginLeft = '';
w.style.marginRight = '';
var appEl = document.getElementById('app');
if (appEl) appEl.style.maxWidth = '';
document.body.style.minHeight = '';
return;
}
  var scale = cssW / natural;
  // 外屏（折叠屏 cover display）可用宽度很窄，缩到 0.3x 会让文字糊到无法辨认。
  // 这里设下限：宁可让页面横向滚动/内容被裁，也不能小到看不清。
  // 外屏实测可用 CSS 宽度约 340~400，下限 0.75 对应 ~315px 已接近可读极限。
  if (scale < 0.75) {
    console.log('[vp-fix] cssW ' + cssW + ' 低于可读下限，改用下限缩放 0.75（内容会超宽）');
    scale = 0.75;
    document.body.classList.add('vp-narrow');
  } else {
    document.body.classList.remove('vp-narrow');
  }
  w.style.transformOrigin = '0 0';
  w.style.webkitTransformOrigin = '0 0';
  w.style.transform = 'scale(' + scale.toFixed(3) + ')';
  w.style.webkitTransform = 'scale(' + scale.toFixed(3) + ')';
  w.style.pointerEvents = 'auto';
  document.body.style.minHeight = (window.innerHeight / scale) + 'px';
  console.log('[vp-fix] cssW ' + cssW + ' → ' + natural + ' (' + scale.toFixed(2) + 'x)');
}

(function init() {
  window.addEventListener('error', function (e) {
    console.error('[window error] ' + (e.message || e) + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    console.error('[unhandled rejection] ' + ((e.reason && (e.reason.message || e.reason)) || e.reason));
  });
  // 侧栏形态沿用上次选择；默认收起（画面优先）
  var sm = safeGet('hplayer_side_mode');
  if (sm === 'float' || sm === 'inline') S.sideMode = sm;
  applySideMode();
  switchTab('segs');
  buildDecks();
  reparse();
  updateToggle();
  applyMute();
  bindGestures();
  requestAnimationFrame(tick);
  fetch('/api/ping').then(function (r) {
    if (S.resolving) return;
    if (r.ok) { setNet('ok', '本地服务就绪'); setStatus('ok', '就绪'); }
    else { setNet('err', '本地服务异常'); setStatus('err', '本地服务异常'); }
  }).catch(function () {
    if (S.resolving) return;
    setNet('err', '本地服务未响应'); setStatus('err', '本地服务未响应');
  });
  applyViewportScale();
  requestAnimationFrame(function () { setTimeout(applyViewportScale, 60); });
// 布局就绪后再报一次诊断：便于在无法截图的设备上确认 stage 尺寸是否正常
// （曾出现过给 #appWrap 设宽导致 padding-top:56.25% 失效、视频区塌成 38x21 的问题）
setTimeout(function () { applyViewportScale(); reportDiag('layout-ready'); }, 400);
  // 折叠屏切屏 / 转屏：视口尺寸变化后必须重新量布局。
  // 用 innerWidth/innerHeight 去重，避免旋转时连续触发几十次 resize 造成重复重排。
  var lastVp = window.innerWidth + 'x' + window.innerHeight;
  window.addEventListener('resize', function () {
    var vp = window.innerWidth + 'x' + window.innerHeight;
    if (vp === lastVp) return;
    var wasLandscape = lastVp.split('x')[0] > lastVp.split('x')[1];
    var isLandscape = window.innerWidth > window.innerHeight;
    lastVp = vp;
    applyViewportScale();
    requestAnimationFrame(function () {
      applyViewportScale();
      reportDiag('viewport-' + vp + (isLandscape !== wasLandscape ? ' orient-changed' : ''));
      try { if (window.BiliBridge && BiliBridge.reportScreen) BiliBridge.reportScreen('viewport=' + vp); } catch (e) {}
    });
  });
  // 折叠屏切屏时 WebView 有时不会派发 resize，用 orientationchange + 轮询兜底
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { applyViewportScale(); reportDiag('orientationchange'); }, 120);
  });
  var vpPoll = setInterval(function () {
    var vp = window.innerWidth + 'x' + window.innerHeight;
    if (vp === lastVp) return;
    lastVp = vp;
    applyViewportScale();
    reportDiag('vp-poll-' + vp);
  }, 400);
  // 页面隐藏（切屏/切后台）前立刻落盘，保证原生能拿到最新位置
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) savePosNow();
  });
  window.addEventListener('pagehide', function () { savePosNow(); });
  loadFromNative();
})();
