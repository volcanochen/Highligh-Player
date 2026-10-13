/* =============================================================
   B 站集锦 · 前端（B 站视频网站风格）
   兼容目标：Chrome 74 WebView（不用 ??. ?? replaceAll :is() gap aspect-ratio clamp）
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
  loop: $('#loop'), rate: $('#rate'), vol: $('#vol'),
  statLeft: $('#statLeft'), statRight: $('#statRight'),
  nowseg: $('#nowseg'),
};

var S = {
  token: null, info: null, hasAudio: false, videoDuration: 0,
  segs: [], idx: -1, pendingIdx: -1, active: 0, playing: false, busy: false,
  loop: 'all', rate: 1, vol: 1, lead: 0.35,
  padFront: 1, padBack: 2,
  qn: 80, page: 1, lastSwitchAt: 0, lastSync: 0, lastHud: 0, audioBlocked: false,
  resolving: false,
  decks: [], parsed: null,
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
  S.resolving = true;
  setNet('busy', '解析视频…');
  setStatus('busy', '解析中');
  setSub('');
  el.metaCard.hidden = true;
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
    // 自动拉评论
    fetchRepliesAndRender(j.aid);
    reparse();
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
  el.vtitle.textContent = j.title || '—';
  el.vowner.textContent = j.owner || '—';
  el.vdur.textContent = '时长 ' + fmt(j.duration);
  el.vqn.textContent = (j.qualityName || '') + ' ' + (j.video.width || '?') + '×' + (j.video.height || '?');
  el.vsrc.textContent = j.pages && j.pages.length > 1 ? ('P' + j.page + '/' + j.pages.length) : '单 P';
  el.metaCard.hidden = false;
  el.ribbonT1.textContent = fmt(j.duration);
}

/* ---------------------- 自动从评论拉时间戳 ---------------------- */
async function fetchRepliesAndRender(aid) {
  if (!aid) return;
  el.replyStat.textContent = '拉取评论中…';
  el.autoStatus.hidden = false;
  el.autoStatus.textContent = '正在拉取评论…';
  el.btnFetchReplies.disabled = true;
  try {
    var j = await (await fetch('/api/replies?aid=' + aid + '&pages=3&ps=30')).json();
    el.btnFetchReplies.disabled = false;
    if (!j.ok) {
      el.replyStat.textContent = '评论拉取失败';
      el.autoStatus.textContent = '评论拉取失败：' + (j.error || '');
      return;
    }
    var matched = j.matched || [];
    el.replyStat.textContent = '已扫 ' + (j.count || 0) + ' 条评论 · 匹配 ' + matched.length + ' 个时间戳';
    el.autoStatus.textContent = matched.length
        ? ('自动从评论扫到 ' + matched.length + ' 个时间戳（已填入下方文本框，可手动调整）')
        : '该视频评论区没扫到时间戳，可点「示例」或手动输入';
    el.autoStatus.hidden = false;
    if (matched.length) {
      // 评论是按热度排序返回的，先按时间戳排序（顺带保证片段按时间顺序连播），
      // 再用相邻间隔推断每段时长（封顶 30s，保底 3s），末段用 10s
      var items = [];
      for (var i = 0; i < matched.length; i++) {
        var m = matched[i];
        var s0 = toSec(m.time || '');
        var s1 = m.end ? toSec(m.end) : null;
        if (s0 == null) continue;
        items.push({ m: m, s0: s0, s1: s1 });
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
      reparse();
    }
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
      var k = S.active;
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
    d.a.muted = (i !== k) || !S.hasAudio;
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
  prepareNext();
}

function pauseAll() {
  S.playing = false;
  S.decks.forEach(function (d) { d.v.pause(); if (S.hasAudio) d.a.pause(); });
  updateToggle();
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
}

/* ---------------------- 事件 ---------------------- */
// 示例文本：时间戳控制在测试视频（BV1GJ411x7h7，3:33）长度内，否则会被"超出片尾"过滤掉
var DEMO = '0:00:12 10s 前奏起\n0:00:38 12s 主歌进\n0:01:15 10s 副歌\n0:01:52 12s 间奏\n0:02:20 10s 二段主歌\n0:02:55 15s 尾段副歌\n0:03:20 8s 收尾';
var TEST_BV = 'BV1GJ411x7h7';   // bilibili 官方"测试视频"短片

el.btnPrev.onclick = function () { if (S.idx > 0) jumpTo(S.idx - 1); else if (S.segs.length) jumpTo(S.segs.length - 1); };
el.btnNext.onclick = function () { var j = nextIndex(S.idx); if (j >= 0) jumpTo(j); };
el.btnToggle.onclick = function () {
  if (S.idx < 0 && S.segs.length) { jumpTo(0); return; }
  if (S.playing) pauseAll(); else resumeAll();
};
el.btnFull.onclick = function () {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.stage.requestFullscreen) el.stage.requestFullscreen();
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
el.loop.onchange = function () { S.loop = el.loop.value; };
el.rate.onchange = function () {
  S.rate = +el.rate.value;
  S.decks.forEach(function (d) { d.v.playbackRate = S.rate; d.a.playbackRate = S.rate; });
};
el.vol.oninput = function () {
  S.vol = +el.vol.value;
  S.decks.forEach(function (d, i) { d.a.volume = S.vol; d.a.muted = (i !== S.active) || !S.hasAudio; });
};
el.padFront.onchange = function () { S.padFront = +el.padFront.value || 0; reparse(); };
el.padBack.onchange = function () { S.padBack = +el.padBack.value || 0; reparse(); };
el.text.addEventListener('input', reparse);

document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); el.btnToggle.click(); }
  else if (e.key === 'ArrowRight') el.btnNext.click();
  else if (e.key === 'ArrowLeft') el.btnPrev.click();
});
document.addEventListener('click', function () {
  if (!S.audioBlocked) return;
  S.audioBlocked = false;
  var cur = activeDeck();
  if (cur && cur.a) { cur.a.muted = false; safePlay(cur.a); }
  setSub('');
}, true);

/* ---------------------- 启动 ---------------------- */
// 由 native share intent 写入的 BV / URL（?bv=xxx）；?demo=1 时自动填示例文本并开播
function loadFromNative() {
  var q;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }
  var bv = q.get('bv');
  var demo = q.get('demo') === '1';
  console.log('[init] bv=' + bv + ' demo=' + demo + ' cssW=' + window.innerWidth + ' dpr=' + window.devicePixelRatio);
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

// 轮询等 token + 片段就绪后自动开播（resolve 是异步的，不能假定 1.5s 就好）
function waitAndPlay(tries) {
  if (S.token && S.segs.length > 0 && S.idx < 0) { el.btnToggle.click(); return; }
  if (tries > 80) { setStatus('err', '自动播放等待超时'); return; }   // ~40s
  setTimeout(function () { waitAndPlay(tries + 1); }, 500);
}

// 系统"显示大小"放大会把 WebView 实际 density 推高，innerWidth 被压到 ~125 CSS px，
// 而页面按 ~420 CSS px 设计。用 wrap 容器整体 scale 补偿（topbar/statusbar 在 wrap 外，不受影响）。
// 注意：脚本执行时 WebView 可能还没布局（innerWidth=0），这时必须跳过，否则 scale(0) 会把页面缩没。
function applyViewportScale() {
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
  // 全局错误兜底：静默失败时至少能在 logcat 看到
  window.addEventListener('error', function (e) {
    console.error('[window error] ' + (e.message || e) + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    console.error('[unhandled rejection] ' + (e.reason && (e.reason.message || e.reason)) || e.reason);
  });
  buildDecks();
  reparse();
  updateToggle();
  requestAnimationFrame(tick);
  fetch('/api/ping').then(function (r) {
    // resolve 进行中不要被 ping 回调覆盖状态
    if (S.resolving) return;
    if (r.ok) { setNet('ok', '本地服务就绪'); setStatus('ok', '就绪'); }
    else { setNet('err', '本地服务异常'); setStatus('err', '本地服务异常'); }
  }).catch(function () {
    if (S.resolving) return;
    setNet('err', '本地服务未响应'); setStatus('err', '本地服务未响应');
  });
  applyViewportScale();
  window.addEventListener('resize', applyViewportScale);
  // 脚本执行时可能尚未布局（innerWidth=0），补一次延迟测量
  requestAnimationFrame(function () { setTimeout(applyViewportScale, 60); });
  loadFromNative();
})();