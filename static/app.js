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
  ribbon: $('#ribbon'), ribbonStat: $('#ribbonStat'),
  ribbonT0: $('#ribbonT0'), ribbonT1: $('#ribbonT1'),
  segList: $('#segList'), listStat: $('#listStat'),
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
  fsExit: $('#fsExit'), fsLock: $('#fsLock'),
  seekPreview: $('#seekPreview'),
  resume: $('#resume'), resumeText: $('#resumeText'), resumeGo: $('#resumeGo'), resumeReset: $('#resumeReset'),
};

var S = {
  token: null, info: null, hasAudio: false, videoDuration: 0,
  segs: [], idx: -1, pendingIdx: -1, active: 0, playing: false, busy: false,
  loop: 'all', rate: 1, vol: 1, lead: 0.35,
  padFront: 1, padBack: 2,
  qn: 80, page: 1, lastSwitchAt: 0, lastSync: 0, lastHud: 0, audioBlocked: false,
  resolving: false,
  decks: [], parsed: null,
  uiMode: 'normal', muted: false, locked: false,
  resumeInfo: null, sharedTitle: null, lastPosSave: 0,
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

function parseText(raw, fallbackDur) {
  fallbackDur = fallbackDur || 10;
  var segs = [], bad = [], warn = [];
  var lines = (raw || '').split(/\r?\n/);
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
  el.ribbonT1.textContent = fmt(j.duration);
}

/* ---------------------- 自动从评论拉时间戳 ---------------------- */
function applyMatched(matched, count, doReparse) {
  var m = matched || [];
  el.replyStat.textContent = '已扫 ' + (count || 0) + ' 条评论 · 匹配 ' + m.length + ' 个时间戳';
  el.autoStatus.hidden = false;
  el.autoStatus.textContent = m.length
      ? ('自动从评论扫到 ' + m.length + ' 个时间戳（已填入下方文本框，可手动调整）')
      : '该视频评论区没扫到时间戳，可点「示例」或手动输入';
  if (m.length) {
    // 评论是按热度排序返回的，先按时间戳排序（顺带保证片段按时间顺序连播），
    // 再用相邻间隔推断每段时长（封顶 30s，保底 3s），末段用 10s
    var items = [];
    for (var i = 0; i < m.length; i++) {
      var mm = m[i];
      var s0 = toSec(mm.time || '');
      var s1 = mm.end ? toSec(mm.end) : null;
      if (s0 == null) continue;
      items.push({ m: mm, s0: s0, s1: s1 });
    }
    items.sort(function (a, b) { return a.s0 - b.s0; });
    var lines = items.map(function (it, i) {
      var d;
      if (it.s1 != null && it.s1 > it.s0) d = Math.max(3, Math.min(60, it.s1 - it.s0));
      else if (i + 1 < items.length && items[i + 1].s0 > it.s0) d = Math.max(3, Math.min(30, items[i + 1].s0 - it.s0));
      else d = 10;
      var tm = it.m.time || '';
      var end = it.m.end ? '-' + it.m.end : '';
      var note = it.m.text ? it.m.text.replace(/\s+/g, ' ').trim() : '';
      return (tm + end + ' ' + d.toFixed(0) + 's ' + note).trim();
    });
    el.text.value = lines.join('\n');
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
  setSrc(d.v, '/api/media/' + S.token + '/v?i=0');
  if (S.hasAudio) setSrc(d.a, '/api/media/' + S.token + '/a?i=0');

  if (d.v.readyState < 1) await once(d.v, 'loadedmetadata', 15000);
  if (S.hasAudio && d.a.readyState < 1) await once(d.a, 'loadedmetadata', 15000);
  if (d.v.readyState < 1) {
    console.error('video loadedmetadata timeout, readyState=' + d.v.readyState + ' networkState=' + d.v.networkState);
    return false;
  }
  await seekTo(d.v, t);
  if (S.hasAudio) await seekTo(d.a, t);
  await waitBuffered(d.v, Math.min(2.4, Math.max(1.0, seg.dur * 0.5)), 15000);
  if (S.hasAudio) await waitBuffered(d.a, 0.8, 12000);
  d.ready = true;
  return true;
}

function showDeck(k) {
  S.active = k;
  S.decks.forEach(function (d, i) {
    d.el.classList.toggle('on', i === k);
    d.v.muted = true;
    d.a.muted = (i !== k) || !S.hasAudio || S.muted;
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
  S.preparing = prepare(d, j, lead);
}

async function jumpTo(i, opts) {
  opts = opts || {};
  if (S.busy || i < 0 || i >= S.segs.length || !S.token) return;
  S.busy = true;
  veil(true, opts.text || ('载入第 ' + (i + 1) + ' 段'));
  var d = otherDeck();
  d.rolling = false;
  var ok = await prepare(d, i, 0);
  if (!ok) { await sleep(500); ok = await prepare(d, i, 0); }
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
  await sleep(120);
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
  prepareNext();
}

function pauseAll() {
  S.playing = false;
  S.decks.forEach(function (d) { d.v.pause(); if (S.hasAudio) d.a.pause(); });
  updateToggle();
  savePos();
}
async function resumeAll() {
  if (S.idx < 0) { if (S.segs.length) await jumpTo(0); return; }
  S.playing = true;
  var cur = activeDeck();
  await safePlay(cur.v);
  if (S.hasAudio && !cur.a.muted) await safePlay(cur.a);
  updateToggle();
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
}
function doSeek(deltaSec) {
  if (S.idx < 0) return;
  var d = activeDeck();
  seekActiveTo(d.v.currentTime + deltaSec);
}

/* 主循环：声画对时 + 段末切换 */
function tick() {
  requestAnimationFrame(tick);
  if (S.hasAudio) syncAudio();
  if (!S.playing || S.busy || S.idx < 0) return;
  var cur = activeDeck();
  var seg = S.segs[S.idx];
  if (!seg) return;
  var end = seg.start + seg.dur;
  var ct = cur.v.currentTime;
  if (ct >= end - 0.012) onSegmentEnd();

  var now = performance.now();
  if (now - S.lastHud > 100) { S.lastHud = now; updateHud(ct, end); updateRibbonCursor(ct); }
  // 记忆播放：每 ~2s 落盘一次
  if (now - S.lastPosSave > 2000) { S.lastPosSave = now; savePos(); }
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
  if (!seg) return;
  var done = Math.max(0, Math.min(seg.dur, ct - seg.start));
  el.nowseg.textContent = '第 ' + (S.idx + 1) + ' / ' + S.segs.length + ' 段 · ' + fmt(seg.start + done);
}
function updateRibbonCursor(ct) {
  var cursor = el.ribbon.querySelector('.cursor');
  if (!cursor || !S.videoDuration) return;
  cursor.style.left = clamp(ct / S.videoDuration * 100, 0, 100) + '%';
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
  el.ribbon.innerHTML = '';
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
  var c = document.createElement('div');
  c.className = 'cursor';
  c.style.left = '0%';
  el.ribbon.appendChild(c);
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
  S.padFront = +el.padFront.value || 0;
  S.padBack = +el.padBack.value || 0;
  var res = parseText(el.text.value, 10);
  S.segs = res.segs; S.parsed = res;
  renderParseInfo(res);
  renderSegList();
  renderRibbon();
  S.idx = -1;
  updateUI(true);
  el.ribbonStat.textContent = res.segs.length + ' 段 · ' + fmt(res.segs.reduce(function (a, b) { return a + b.dur; }, 0));
  updateToggle();
  checkResume();
}

/* ---------------------- 记忆播放（续播） ---------------------- */
function posKey() { return S.info && S.info.bvid ? ('bilihl_pos_' + S.info.bvid) : null; }
function savePos() {
  if (!S.playing || S.idx < 0 || !S.token) return;
  var key = posKey();
  if (!key) return;
  var d = activeDeck();
  if (!d || !d.v || !isFinite(d.v.currentTime)) return;
  safeSet(key, JSON.stringify({ idx: S.idx, t: d.v.currentTime }));
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

/* ---------------------- 全屏模式 ---------------------- */
function setUiMode(mode) {
  S.uiMode = mode;
  if (mode === 'fullscreen') {
    document.body.classList.add('fullscreen');
    document.body.classList.remove('fs-hide');
    // 进入全屏时清掉可能的缩放（横屏后由 resize 重新计算）
    var w = document.querySelector('#appWrap');
    if (w) { w.style.transform = ''; w.style.webkitTransform = ''; }
    if (typeof revealFsControls === 'function') revealFsControls();
  } else {
    document.body.classList.remove('fullscreen', 'fs-hide', 'fs-lock');
    S.locked = false;
    applyViewportScale();
  }
}
function enterFullscreen() {
  if (window.BiliBridge && BiliBridge.toggleFullScreen) BiliBridge.toggleFullScreen();
  else setUiMode('fullscreen');
}
var fsTimer = 0;
function revealFsControls() {
  if (S.uiMode !== 'fullscreen') return;
  document.body.classList.remove('fs-hide');
  if (fsTimer) clearTimeout(fsTimer);
  fsTimer = setTimeout(function () { document.body.classList.add('fs-hide'); }, 3200);
}
function hideFsControls() { document.body.classList.add('fs-hide'); }

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
var gs = { x0: 0, y0: 0, t0: 0, dx: 0, dy: 0, moved: false, mode: null, lastTap: 0, locked: false };

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

function onGestureStart(e) {
  if (S.locked && e.target.id !== 'fsLock') return;
  if (e.target.closest && e.target.closest('.fs-btn')) return; // 按钮自身处理
  var t = e.touches[0];
  gs.x0 = t.clientX; gs.y0 = t.clientY; gs.t0 = performance.now();
  gs.moved = false; gs.mode = null; gs.dx = 0; gs.dy = 0;
}
function onGestureMove(e) {
  if (S.locked && e.target.id !== 'fsLock') return;
  if (e.target.closest && e.target.closest('.fs-btn')) return;
  var t = e.touches[0];
  var dx = t.clientX - gs.x0, dy = t.clientY - gs.y0;
  gs.dx = dx; gs.dy = dy;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) gs.moved = true;
  if (S.uiMode !== 'fullscreen') return; // 普通模式不做滑动手势
  if (gs.mode === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
    if (Math.abs(dx) > Math.abs(dy)) gs.mode = 'seek';
    else gs.mode = (gs.x0 < window.innerWidth / 2) ? 'bright' : 'vol';
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
  if (S.locked) { if (gs.moved) gs.moved = false; return; }
  var dt = performance.now() - gs.t0;
  if (!gs.moved) {
    handleTap();
  } else if (S.uiMode === 'fullscreen') {
    if (gs.mode === 'seek') { doSeek(dxToTime(gs.dx)); hideSeekPreview(); }
  }
  gs.moved = false; gs.mode = null;
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
  // 全屏下任意触摸都唤起控制条
  document.addEventListener('touchstart', function () { if (S.uiMode === 'fullscreen') revealFsControls(); }, true);
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
  revealFsControls();
};
el.btnDemo.onclick = function () { el.text.value = DEMO; console.log('[demo] fill', DEMO.split('\n').length, 'lines'); reparse(); };
el.btnClear.onclick = function () { el.text.value = ''; reparse(); };
el.btnFetchReplies.onclick = function () {
  if (S.info && S.info.aid) fetchRepliesAndRender(S.info.aid);
  else setStatus('err', '请先解析视频');
};
el.btnTestVideo.onclick = function () { resolveVideo(TEST_BV); };
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

document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); el.btnToggle.click(); }
  else if (e.key === 'ArrowRight') el.btnNext.click();
  else if (e.key === 'ArrowLeft') el.btnPrev.click();
  else if (e.key === 'KeyF') enterFullscreen();
});
document.addEventListener('click', function () {
  if (!S.audioBlocked) return;
  S.audioBlocked = false;
  var cur = activeDeck();
  if (cur && cur.a) { cur.a.muted = false; safePlay(cur.a); }
  setSub('');
}, true);

/* ---------------------- 启动 ---------------------- */
function loadFromNative() {
  var q;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }
  var bv = q.get('bv');
  var demo = q.get('demo') === '1';
  var title = q.get('title');
  if (title) S.sharedTitle = title;
  console.log('[init] bv=' + bv + ' demo=' + demo + ' title=' + title + ' cssW=' + window.innerWidth + ' dpr=' + window.devicePixelRatio);
  if (bv) {
    console.log('[init] calling resolveVideo(' + bv + ')');
    resolveVideo(bv).then(function (ok) {
      console.log('[init] resolve returned ok=' + ok + ' demo=' + demo);
      if (!demo) return;
      el.btnDemo.click();
      waitAndPlay(0);
    }).catch(function (e) {
      console.error('[init] resolve threw: ' + (e && (e.message || e)));
    });
  } else if (demo) {
    el.btnDemo.click();
  }
}

function waitAndPlay(tries) {
  if (S.token && S.segs.length > 0 && S.idx < 0) { el.btnToggle.click(); return; }
  if (tries > 80) { setStatus('err', '自动播放等待超时'); return; }   // ~40s
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
    w.style.transform = '';
    w.style.webkitTransform = '';
    document.body.style.minHeight = '';
    return;
  }
  var scale = cssW / natural;
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
  window.addEventListener('resize', applyViewportScale);
  requestAnimationFrame(function () { setTimeout(applyViewportScale, 60); });
  loadFromNative();
})();
