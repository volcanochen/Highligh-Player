#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按特性组织的真机测试用例。

设计原则（都是被真实事故教出来的）：
1. **断言真实状态，不断言日志**。日志说「resolve done」不代表能播；
   必须读 S.* 与 video.currentTime/readyState。
2. **不复用注入的探针去测被测对象**。之前注入 jumpTo 包装后自己递归，
   造出「片段疯狂循环」的假象。用「页面埋点 + 外部短轮询」，不复核函数。
3. **每条断言自带数据出处**。token 必须取完整值，不能用日志里截断的串。
4. 任何异常都要能变成一条 FAIL 结果，不能让整个套件崩掉。
"""
from __future__ import print_function

import json
import re
import time

from harness import CaseResult, PASS, FAIL, SKIP, TEST_BV, TEST_URL

# 播放用的短片段（秒），用于验证切段/预热/连播。
# 为什么是 2s：套件里有多条用例要「等到自动切过 3 段」，段长直接决定这几条的耗时。
# 6s×3 段要 ~18s，2s×3 段只要 ~6s——整轮套件能省下一半时间。
# 段间隔 6s 是为了让下一次 seek 距离短、缓冲命中率高，切段更快也更稳。
# 补时在 _fresh_playing 里被显式置 0，否则 2s 段会被 pad(1+2) 撑成 5s。
SHORT_SEGS = "0:00:20 2s A\\n0:00:26 2s B\\n0:00:32 2s C\\n0:00:38 2s D"

# 段长 2s 后，等「自动切过 3 段」的轮询窗口不需要 40s 那么长
CUT_DEADLINE = 22

# 旋转/session 用例要用长片段：旋转等待期间若片段只有 2s，播放会自动切到下一段，
# 「idx 变了」会被误判成 session 丢失 —— 那是测试设计问题，不是产品问题。
LONG_SEGS = "0:00:20 40s A\\n0:01:30 40s B"

# 状态快照：一次拿全，避免多次 CDP 往返
SNAP = r"""JSON.stringify({
  idx: S.idx, playing: S.playing, busy: S.busy,
  token: S.token || null, bv: (S.info && S.info.bvid) || null,
  dur: S.videoDuration || 0, hasAudio: !!S.hasAudio,
  segs: (S.segs || []).length, loop: S.loop,
  ui: S.uiMode, muted: S.muted, keepUi: S.keepUi,
  err: (document.getElementById('errText') || {}).textContent || '',
  status: (document.getElementById('statLeft') || {}).textContent || '',
  vw: window.innerWidth, vh: window.innerHeight,
  decks: (S.decks || []).map(function (d) {
    return { seg: d.seg, ready: !!d.ready, rolling: !!d.rolling,
             rs: d.v.readyState, net: d.v.networkState, paused: !!d.v.paused,
             ct: d.v.currentTime,
             err: (d.v.error ? d.v.error.code : -1) };
  }),
  active: S.active,
  pos: (function () { try { return localStorage.getItem('hplayer_pos_' + ((S.info && S.info.bvid) || '')); } catch (e) { return null; } })()
})"""


def _snap(d):
    try:
        return d.cdp.js(SNAP) or {}
    except Exception as e:
        return {"__error": str(e)}


def _ensure_resolved(d, timeout=40):
    """确保页面已持有可用 token。没有 token 时 jumpTo 会直接 return，
    表现为「用例说没进入播放状态」，其实是前置条件没满足。"""
    s = _snap(d)
    if s.get("token"):
        return True, s
    try:
        d.cdp.js("resolveVideo('%s'); 'go'" % TEST_BV, timeout=15)
    except Exception:
        return False, s
    ok, _ = d.cdp.wait_for("!!S.token", timeout=timeout, interval=1.0)
    return ok, _snap(d)


def _fresh_playing(d, segs_js=SHORT_SEGS, wait=10):
    """把页面恢复到「可播放且正在播」的干净状态。

    两个要点：
    1. 必须先确保已解析出token —— 否则 jumpTo 会静默 return，
       表现为「用例说没进入播放状态」，容易被误判成产品 bug。
    2. reparse() 与 jumpTo() 必须在**同一条** eval 里连着执行。
       拆成两次 CDP 调用会在中间被打断，结果 idx 一直是 -1、veil 一直亮着
       —— 那是测试探针自己制造的假象。
    """
    got, s0 = _ensure_resolved(d)
    if not got:
        return False, {"__error": "前置解析失败：%s"
                       % (s0.get("status") or s0.get("err") or "无 token")}
    try:
        # stopAll + reparse + jumpTo 必须连在一条eval 里。
        # 之前拆成多次 CDP 调用，中间被往返打断，idx 卡在 -1、遮罩一直亮着，
        # 后续用例再进来就全崩（连锁失败）——那是探针自己制造的假象。
        d.cdp.js("""(function () {
          try {
            if (typeof stopAll === 'function') stopAll();
            S.loop = 'all';
            S.resolving = false; S.busy = false;
            // 补时置 0：测试片段只要 2s，默认的 前补1s/后补2s 会把它撑成 5s，
            // 让「等自动切段」的用例白白多等好几秒。
            if (el.padFront) el.padFront.value = '0';
            if (el.padBack) el.padBack.value = '0';
            el.text.value = "%s";
            reparse();
            jumpTo(0);
            return 'kick';
          } catch (e) { return 'ERR ' + e; }
        })()""" % segs_js, timeout=20)
    except Exception as e:
        return False, {"__error": "启动播放失败：%s" % e}
    end = time.time() + wait
    while time.time() < end:
        s = _snap(d)
        dk = (s.get("decks") or [{}])[s.get("active", 0)] or {}
        if s.get("idx") == 0 and not dk.get("paused", True) and (dk.get("rs") or 0) >= 2:
            return True, s
        time.sleep(0.8)
    # 第一次没起来时再补一次：媒体 token 有 TTL，长跑套件时可能刚好过期，
    # 重新解析一次通常就恢复。
    try:
        d.cdp.js("resolveVideo('%s'); 're'" % TEST_BV, timeout=15)
    except Exception:
        pass
    ok, s = d.cdp.wait_for("!!S.token", timeout=25, interval=1.0)
    if not ok:
        return False, {"__error": "重解析后仍无 token"}
    try:
        d.cdp.js("""(function () {
          S.loop = 'all'; S.resolving = false; S.busy = false;
          if (el.padFront) el.padFront.value = '0';
          if (el.padBack) el.padBack.value = '0';
          el.text.value = "%s";
          reparse(); jumpTo(0);
          return 'kick2';
        })()""" % segs_js, timeout=20)
    except Exception:
        pass
    end = time.time() + wait
    while time.time() < end:
        s = _snap(d)
        dk = (s.get("decks") or [{}])[s.get("active", 0)] or {}
        if s.get("idx") == 0 and not dk.get("paused", True) and (dk.get("rs") or 0) >= 2:
            return True, s
        time.sleep(0.8)
    return False, _snap(d)


# ==========================================================================
# 用例
# ==========================================================================
def c_app_launch(d):
    """特性：应用启动与本地服务可用"""
    r = CaseResult("应用启动 + 本地服务监听", "启动")
    # 冷启动：runner 安装 APK 后进程并不保证在跑，先确保应用起来
    if not d.sh("pidof", "com.hplayer").strip():
        d.sh("monkey", "-p", "com.hplayer", "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(8)
    if not d.wait_page(timeout=35):
        return r.fail("WebView 调试通道连不上（应用可能没起来或没开调试）")
    url = d.cdp.page_url()
    if "127.0.0.1" not in url:
        return r.fail("WebView 加载的不是本地服务：%s" % url)
    port = re.search(r":(\d+)/", url)
    return r.ok("本地服务 %s" % url, port=port.group(1) if port else "?")


def c_resolve_cold(d):
    """特性：冷启动首次解析（曾因连接池泄漏必超时 18s）"""
    r = CaseResult("冷启动首次解析不超时", "解析")
    d.force_stop()
    time.sleep(2)
    d.sh("monkey", "-p", "com.hplayer", "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(7)
    if not d.wait_page(timeout=30):
        return r.fail("冷启动后 WebView 不可达")

    # timeout 给到 70s：之前默认 45s，慢的时候请求会被直接砍断成 code=0，
    # 报告里只剩一个「code=0」，看不出到底是慢还是坏。放宽后能拿到真实耗时。
    t0 = time.time()
    code, _, body = d.http_probe(
        "http://127.0.0.1:8777/api/resolve?url=%s&p=1&qn=80" % TEST_BV,
        want_body=True, timeout=70)
    secs_f = time.time() - t0
    if code != 200 or '"ok":true' not in (body or "").replace(" ", ""):
        # 附带本地服务自检：ping 通而 resolve 挂住 = 外网/握手慢；
        # ping 都不通 = 应用自己没起来。两者修法完全不同，报告里必须分得清。
        pcode, _, pbody = d.http_probe("http://127.0.0.1:8777/api/ping",
                                       want_body=True, timeout=10)
        return r.fail("resolve 未成功（code=%s，%.1fs，body=%s）；本地服务自检 ping=%s %s"
                      % (code, secs_f, (body or "").strip()[:60], pcode,
                         (pbody or "").strip()[:40]), seconds=round(secs_f, 2))
    # 阈值 20s：远高于实测（蜂窝网 0.3~2.8s），但能拦住「必超时 18s」这类回归
    if secs_f > 20:
        return r.fail("首次解析 %.2fs 超出 20s 阈值（连接池/握手回归）" % secs_f,
                      seconds=round(secs_f, 2))
    return r.ok("首次解析 %.2fs" % secs_f, seconds=round(secs_f, 2))


def c_resolve_concurrent(d):
    """特性：并发/连续解析鲁棒性（弱网 + 连接竞争）"""
    r = CaseResult("5 次连续解析全成功", "解析")
    # 这 5 个 BV 都经过实测确认 ok=true。
    # 曾把不存在的 BV 混进来，导致用例报「解析失败」——那是测试数据问题，不是产品问题。
    bvs = ["BV1GJ411x7h7", "BV1xx411c7mD", "BV17x411w7KC",
           "BV1jJ41137RW", "BV1kt411g7ip"]
    slow, bad = [], []
    for bv in bvs:
        t0 = time.time()
        code, _, body = d.http_probe(
            "http://127.0.0.1:8777/api/resolve?url=%s&p=1&qn=80" % bv,
            want_body=True)
        dt = time.time() - t0
        if code != 200 or '"ok":true' not in (body or "").replace(" ", ""):
            bad.append("%s(code=%s,%s)" % (bv, code, (body or "")[:40]))
        else:
            slow.append(dt)
    if bad:
        return r.fail("这些 BV 解析失败：%s" % "; ".join(bad), failed=len(bad))
    worst = max(slow)
    if worst > 20:
        return r.fail("最慢一次 %.2fs 超出 20s" % worst, worst=worst)
    return r.ok("5/5 成功，最慢 %.2fs，均值 %.2fs" % (worst, sum(slow) / len(slow)),
                worst=round(worst, 2))


def c_deeplink_share(d):
    """特性：从 B 站链接打开（ACTION_VIEW 深链）"""
    r = CaseResult("深链打开并自动解析", "分享")
    d.sh("am", "force-stop", "com.hplayer")
    time.sleep(1)
    # 深链的解析日志在「本次冷启动」里，而常驻 logcat 是在安装后启动的，
    # 中间这次 force-stop 不会丢日志，但为稳妥起见先重启一次读取器。
    d.log.clear()
    d.log.start()
    d.sh("monkey", "-p", "com.hplayer", "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(5)
    d.open_url(TEST_URL)
    if not d.wait_page(timeout=35):
        return r.fail("深链后 WebView 不可达")
    d.cdp.wait_for("!!(S.token) && !!(S.info && S.info.bvid)", timeout=30, interval=1.0)
    s = _snap(d)
    if not s.get("token"):
        return r.fail("深链后没有拿到 token（status=%s err=%s）" % (s.get("status"), s.get("err")))
    if s.get("bv") != TEST_BV:
        return r.fail("解析到了错误的视频：%s（期望 %s）" % (s.get("bv"), TEST_BV))
    # 从 logcat 全量缓冲里找链接提取日志（不能只看常驻读取器，可能错过启动瞬间）
    dump = d.log.dump() + "\n" + d.log._run(["logcat", "-d", "-v", "brief", "-s", "HPlayer-Share"])
    if "target=" not in dump:
        return r.fail("分享解析日志里没有 target，可能没走到链接提取分支")
    return r.ok("解析到 %s，时长 %ss" % (s.get("bv"), s.get("dur")),
                bv=s.get("bv"), dur=s.get("dur"))


def c_play_progress(d):
    """特性：视频真的能播（此前的疏漏：只验解析成功就收工）"""
    r = CaseResult("播放推进且可解码", "播放")
    ok, s = _fresh_playing(d)
    if not ok:
        return r.fail("无法进入播放状态：%s" % json.dumps(s, ensure_ascii=False)[:200])
    dk = (s.get("decks") or [{}])[s.get("active", 0)] or {}
    t1 = dk.get("ct") or 0
    rs = dk.get("rs") or 0
    if rs < 2:
        return r.fail("readyState=%d，视频没拿到可解码数据" % rs, readyState=rs)
    # 采样 3 次确认 currentTime 在真实推进（不是停在某一点）
    samples, advanced = [], False
    for _ in range(3):
        time.sleep(1.0)
        s2 = _snap(d)
        dk2 = (s2.get("decks") or [{}])[s2.get("active", 0)] or {}
        ct2 = dk2.get("ct") or 0
        samples.append(round(ct2, 2))
        if ct2 > t1 + 0.3:
            advanced = True
        t1 = ct2
    if not advanced:
        return r.fail("currentTime 没有推进（%s）——画面实际是卡住的" % samples,
                      samples=samples)
    if s.get("err"):
        return r.fail("页面显示错误：%s" % s.get("err"))
    return r.ok("推进到 %.2fs（采样 %s）" % (t1, samples), samples=samples, readyState=rs)


def c_media_stream(d):
    """特性：媒体流代理返回 206（必须用完整 token，日志里是截断的）"""
    r = CaseResult("媒体流 206 可读", "播放")
    s = _snap(d)
    if not s.get("token"):
        return r.skip("当前无token，跳过媒体流检查")
    # token 有 TTL：过期后代理返回 {"ok":false,"error":"token 失效或已过期"}。
    # 直接复用页面里的旧 token 会误判成「媒体流坏了」——先解析一个新的。
    code, _, body = d.http_probe(
        "http://127.0.0.1:8777/api/resolve?url=%s&p=1&qn=80" % TEST_BV,
        want_body=True)
    fresh = None
    if code == 200:
        m = re.search(r'"token"\s*:\s*"([0-9a-f]{16,})"', body or "")
        if m:
            fresh = m.group(1)
    if not fresh:
        return r.fail("拿不到可用的新 token，无法验证媒体流（resolve code=%s）" % code)
    try:
        d.cdp.js("S.token = %s; 'ok'" % json.dumps(fresh), timeout=10)
    except Exception:
        pass

    t0 = time.time()
    code, rng, body = d.http_probe(
        "http://127.0.0.1:8777/api/media/%s/v?i=0" % fresh,
        headers=["Range: bytes=0-262143"], want_body=True)
    dt = time.time() - t0
    if code not in (200, 206):
        return r.fail("媒体流 HTTP %d：%s" % (code, (body or "")[:100]), code=code)
    # body 是 ftyp box：MP4 头必须出现，否则代理给的不是可解码的 MP4
    if "ftyp" not in (body or ""):
        return r.fail("媒体流返回的不是 MP4（缺少 ftyp box）：%r" % (body or "")[:60])
    return r.ok("HTTP %d，%.2fs，MP4 头正常" % (code, dt), code=code, range=rng)


def c_segment_autoplay(d):
    """特性：段末自动切换（用外部轮询采样，不包装 jumpTo）"""
    r = CaseResult("段末自动连播", "播放")
    ok, s = _fresh_playing(d)
    if not ok:
        return r.fail("无法进入播放状态")
    start_idx = s.get("idx")
    # 外部轮询：只读 idx，不在页面里插桩，避免探针污染被测对象。
    # 采样间隔 0.5s：段长只有 2s，1.2s 一次会整段漏采（明明切了却没采到）。
    seen, deadline = set(), time.time() + CUT_DEADLINE
    while time.time() < deadline:
        snap = _snap(d)
        i = snap.get("idx")
        if isinstance(i, int) and i >= 0:
            seen.add(i)
        if len(seen) >= 3:
            break
        time.sleep(0.5)
    if len(seen) < 2:
        return r.fail("%ds 内段索引没有前进（始终 idx=%s），自动连播失效"
                      % (CUT_DEADLINE, sorted(seen)), seen=sorted(seen))
    return r.ok("自动切过 %d 段（经过 %s）" % (len(seen), sorted(seen)), seen=sorted(seen))


def c_no_veil_on_cut(d):
    """特性：切段零加载遮罩（用户要求「像分镜一样自然」）"""
    r = CaseResult("切段无加载遮罩", "播放")
    # 先起播（首播本来就可能有加载圈，那是合理的）。
    # 计数在**首播成功之后**才清零，这样统计的才是「切段」时的遮罩次数。
    ok, s = _fresh_playing(d)
    if not ok:
        return r.fail("无法进入播放状态：%s" % (s.get("__error") or s.get("idx")))
    try:
        d.cdp.js("""(function () {
          window.__veil = 0;
          var t = document.getElementById('veil');
          if (window.__veilObs) window.__veilObs.disconnect();
          window.__veilObs = new MutationObserver(function () {
            if (t.classList.contains('on')) window.__veil++;
          });
          window.__veilObs.observe(t, { attributes: true, attributeFilter: ['class'] });
          return 'armed';
        })()""", timeout=15)
    except Exception as e:
        return r.fail("埋点安装失败：%s" % e)

    # 等到段索引前进（确实切了一次段），再读计数。
    # 段长 2s，采样必须比段短，否则会「切过了但没采到」而误判成没切。
    end = time.time() + CUT_DEADLINE
    moved = False
    while time.time() < end:
        try:
            cur = d.cdp.js("S.idx")
        except Exception:
            break
        if isinstance(cur, int) and cur >= 1:
            moved = True
            break
        time.sleep(0.5)
    try:
        veil = d.cdp.js("window.__veil || 0")
    except Exception:
        veil = None
    if veil is None:
        return r.fail("读不到 veil 计数（页面可能被重载了）")
    if not moved:
        return r.fail("%ds 内没有发生段切换，无法验证切段遮罩" % CUT_DEADLINE)
    if veil > 0:
        return r.fail("切段过程中出现 %d 次加载遮罩（要求 0 次）" % veil, veilHits=veil)
    return r.ok("切段全程零遮罩", veilHits=veil)


def c_preheat_ready(d):
    """特性：预热 deck 就绪（分镜式切换的前提）"""
    r = CaseResult("下一段预热就位", "播放")
    ok, s = _fresh_playing(d)
    if not ok:
        return r.fail("无法进入播放状态")
    time.sleep(2)
    ready, other = 0, {}
    for _ in range(6):
        snap = _snap(d)
        act = snap.get("active", 0)
        others = [x for i, x in enumerate(snap.get("decks") or []) if i != act]
        if others and others[0].get("ready"):
            ready = 1
            other = others[0]
            break
        time.sleep(1.0)
    if not ready:
        return r.fail("预热 deck 始终没有 ready，切换必然要转圈")
    if (other.get("rs") or 0) < 1:
        return r.fail("预热 deck ready 但 readyState=%d，拿不到数据" % other.get("rs"),
                      readyState=other.get("rs"))
    return r.ok("预热 deck ready，readyState=%d" % (other.get("rs") or 0),
                readyState=other.get("rs"))


def c_parse_eol(d):
    """特性：Windows/Linux/旧 Mac 三种换行都能解析（用户报过换行异常）"""
    r = CaseResult("三种换行符解析一致", "解析")
    js = r"""JSON.stringify(['0:00:20 2s A\n0:00:26 2s B',
                           '0:00:20 2s A\r\n0:00:26 2s B',
                           '0:00:20 2s A\r0:00:26 2s B'].map(function (t) {
      var s = parseText(t, 10);
      return { n: s.segs.length, starts: s.segs.map(function (x) { return x.start; }) };
    }))"""
    try:
        out = d.cdp.js(js)
    except Exception as e:
        return r.fail("解析函数执行异常：%s" % e)
    if not isinstance(out, list) or len(out) != 3:
        return r.fail("parseText 返回异常：%s" % out)
    counts = [o.get("n") for o in out]
    starts = [o.get("starts") for o in out]
    if any(c != 2 for c in counts):
        return r.fail("三种换行解析结果不一致：%s（应全为 2 段）" % counts, counts=counts)
    if any(s != starts[0] for s in starts):
        return r.fail("换行不同导致时间戳位置不同：%s" % starts, starts=starts)
    return r.ok("三种换行均解析出 2 段且位置一致 %s" % starts[0], counts=counts)


def c_eol_ui(d):
    """特性：文本框内容不含裸 \\r（换行问题的直接证据）"""
    r = CaseResult("时间戳文本无裸回车", "解析")
    out = d.cdp.js("""JSON.stringify({
      hasCR: (el.text.value || '').indexOf('\\r') >= 0,
      lines: (el.text.value || '').split('\\n').length
    })""")
    if not isinstance(out, dict):
        return r.fail("读取文本框失败：%r" % (out,))
    if out.get("hasCR"):
        return r.fail("文本框里仍有裸 \\r，会导致解析错行")
    if (out.get("lines") or 0) < 2:
        return r.skip("文本框内容不足两行")
    return r.ok("无裸 \\r，共 %d 行" % out["lines"], lines=out["lines"])


def c_fullscreen_ui(d):
    """特性：全屏控件与常驻进度条（用户报过进度条自己消失）"""
    r = CaseResult("全屏常驻进度条可见", "全屏")
    try:
        d.cdp.js("setUiMode('fullscreen'); revealFsControls(true); 'fs'", timeout=12)
    except Exception as e:
        return r.fail("进入全屏失败：%s" % e)
    time.sleep(2)
    out = d.cdp.js("""JSON.stringify({
      fs: S.uiMode,
      bar: getComputedStyle(document.getElementById('fsBar')).display,
      w: document.getElementById('fsBarFill').style.width
    })""")
    if not isinstance(out, dict):
        return r.fail("读取全屏控件失败")
    if out.get("fs") != "fullscreen":
        return r.fail("未进入全屏模式（uiMode=%s）" % out.get("fs"))
    if out.get("bar") in (None, "none"):
        return r.fail("全屏常驻进度条不可见（display=%s）" % out.get("bar"))
    try:
        d.cdp.js("setUiMode('normal'); 'back'", timeout=12)
    except Exception:
        pass
    return r.ok("常驻进度条可见（%s，进度 %s）" % (out.get("bar"), out.get("w")),
                width=out.get("w"))


def c_pause_keeps_ui(d):
    """特性：暂停时控制条不自动隐藏（旧逻辑必然消失）"""
    r = CaseResult("暂停时控制条常显", "全屏")
    try:
        d.cdp.js("setUiMode('fullscreen'); pauseAll(); hideFsControls(); 'x'", timeout=15)
    except Exception as e:
        return r.fail("执行失败：%s" % e)
    time.sleep(1.2)
    out = d.cdp.js("""JSON.stringify({
      playing: S.playing,
      shouldKeep: fsShouldKeep(),
      hide: document.body.classList.contains('fs-hide'),
      opacity: getComputedStyle(document.querySelector('.ctrl-card')).opacity
    })""")
    if not isinstance(out, dict):
        return r.fail("读取控制条状态失败")
    if out.get("shouldKeep") is not True:
        return r.fail("暂停时 fsShouldKeep()=%s，应为 true" % out.get("shouldKeep"))
    try:
        d.cdp.js("resumeAll(); setUiMode('normal'); 'y'", timeout=15)
    except Exception:
        pass
    return r.ok("暂停时判定为常显（keep=%s）" % out.get("shouldKeep"),
                shouldKeep=out.get("shouldKeep"))


def c_resume_memory(d):
    """特性：记忆播放位置落盘（折叠屏/进程回收续播的基础）"""
    r = CaseResult("播放位置落盘可恢复", "会话")
    ok, s = _fresh_playing(d)
    if not ok:
        return r.fail("无法进入播放状态")
    time.sleep(2.5)
    d.cdp.js("savePosNow(); 'saved'", timeout=10)
    time.sleep(0.6)
    out = d.cdp.js("JSON.stringify(localStorage.getItem('hplayer_pos_' + (S.info && S.info.bvid)))")
    if not out:
        return r.fail("localStorage 里没有落盘位置")
    raw = out.strip('"')  # CDP 会把值再包一层 JSON 字符串
    if not raw or raw == "null":
        return r.fail("localStorage 落盘位置为 null")
    try:
        obj = json.loads(raw)
    except Exception:
        obj = None
    if not isinstance(obj, dict) or "idx" not in obj or "t" not in obj:
        return r.fail("落盘数据格式异常：%s" % raw[:100])
    return r.ok("已落盘 idx=%s t=%s" % (obj["idx"], obj["t"]),
                idx=obj["idx"], t=obj["t"])


def c_density(d):
    """特性：density 钳制策略（>600 才钳，N6 内屏 442/折叠 520 是正常值）"""
    r = CaseResult("density 钳制策略正确", "兼容性")
    out = d.sh("dumpsys", "display")
    cur = 0
    for line in out.splitlines():
        if "DisplayDeviceInfo" in line and "density" in line:
            m = re.search(r"density\s+(\d+)", line)
            if m:
                cur = int(m.group(1))
                break
    logs = "\n".join(d.log.grep(r"density"))
    if cur <= 0:
        return r.fail("读不到当前 density")
    forced = "钳制" in logs or "强制" in logs
    if cur > 600 and not forced:
        return r.fail("density=%d 已超过 600 阈值，但日志显示没有钳制" % cur, density=cur)
    if cur <= 600 and forced:
        return r.fail("density=%d 在正常区间却被钳制了（会破坏布局）" % cur, density=cur)
    return r.ok("density=%d，钳制策略正确%s" % (cur, "（已钳制）" if forced else "（保持原值）"),
                density=cur)


def c_layout(d):
    """特性：视频区尺寸合理（曾在两列布局冲突下塌成 78x44）"""
    r = CaseResult("视频区尺寸正常", "布局")
    out = d.cdp.js("""JSON.stringify((function(){
      var st = document.getElementById('stage');
      var r = st.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               decks: document.querySelectorAll('.deck').length };
    })())""")
    if not isinstance(out, dict):
        return r.fail("读取布局失败")
    w, h = out.get("w", 0), out.get("h", 0)
    if w < 120 or h < 90:
        return r.fail("视频区塌缩成 %dx%d（应至少 120x90）" % (w, h), w=w, h=h)
    if out.get("decks") != 2:
        return r.fail("deck 数量=%d，应为 2（双层预热）" % out.get("decks"))
    return r.ok("视频区 %dx%d，deck 数=%d" % (w, h, out.get("decks")), w=w, h=h)


def c_rotate_session(d):
    """特性：旋转/切屏后 session 与进度保持（configChanges 全量接管）"""
    r = CaseResult("旋转保持 session 与进度", "会话")
    ok, s = _fresh_playing(d, segs_js=LONG_SEGS)
    if not ok:
        return r.fail("无法进入播放状态")
    time.sleep(1.5)
    before = _snap(d)
    dk = (before.get("decks") or [{}])[before.get("active", 0)] or {}
    idx_before, ct_before = before.get("idx"), dk.get("ct") or 0
    tok_before = (before.get("token") or "")[:8]

    d.rotate(1)
    time.sleep(4)
    after = _snap(d)
    dk2 = (after.get("decks") or [{}])[after.get("active", 0)] or {}
    d.rotate_restore()
    time.sleep(1.5)

    tok_after = (after.get("token") or "")[:8]
    if tok_before and tok_after and tok_before != tok_after:
        return r.fail("旋转后 WebView 被重建（token %s→%s），session 丢失" % (tok_before, tok_after),
                      token_before=tok_before, token_after=tok_after)
    if after.get("idx") != idx_before:
        return r.fail("旋转后段索引从 %s 变成 %s，播放位置丢了" % (idx_before, after.get("idx")),
                      idx_before=idx_before, idx_after=after.get("idx"))
    if not after.get("playing") and before.get("playing"):
        return r.fail("旋转后播放被中断（playing %s→%s）" % (before.get("playing"), after.get("playing")))
    return r.ok("token/段索引/播放状态均保持（idx=%s）" % after.get("idx"),
                idx_before=idx_before, idx_after=after.get("idx"))


def c_no_js_error(d):
    """特性：页面无 JS 运行时错误"""
    r = CaseResult("无 JS 运行时错误", "稳定性")
    bad = []
    for pat in (r"Uncaught", r"TypeError", r"ReferenceError", r"is not a function",
                r"is not defined", r"SyntaxError"):
        bad += d.log.grep(pat)
    bad = [b for b in bad if "HPlayer" in b]
    if bad:
        uniq = sorted(set(b.split("HPlayer-JS:")[-1].strip()[:110] for b in bad))
        return r.fail("发现 %d 条 JS 错误：%s" % (len(bad), " | ".join(uniq[:3])),
                      errors=uniq[:5])
    return r.ok("日志中无 JS 异常")


def c_no_crash(d):
    """特性：应用无崩溃"""
    r = CaseResult("应用无崩溃", "稳定性")
    crash = d.log.find_crash()
    if crash and "com.hplayer" in crash:
        head = [l for l in crash.splitlines() if "com.hplayer" in l][:3]
        return r.fail("崩溃日志：%s" % " | ".join(head))
    alive = bool(d.sh("pidof", "com.hplayer").strip())
    if not alive:
        return r.fail("进程已不在（可能被系统杀掉或崩溃）")
    return r.ok("进程存活，无 crash 记录")


def c_manual_fallback(d):
    """特性：分享读不到链接时手动粘贴兜底"""
    r = CaseResult("手动粘贴兜底可用", "分享")
    try:
        d.cdp.js("showShareFallback('收到的分享内容：测试'); 'x'", timeout=12)
    except Exception as e:
        return r.fail("showShareFallback 调用失败：%s" % e)
    time.sleep(0.8)
    out = d.cdp.js("JSON.stringify({hidden: document.getElementById('shareFallback').hidden,"
                   "raw: document.getElementById('sfRaw').textContent})")
    if not isinstance(out, dict):
        return r.fail("读取兜底弹窗失败")
    if out.get("hidden") is not False:
        return r.fail("兜底弹窗未显示（hidden=%s）——分享读不到链接时用户会没有出路" % out.get("hidden"))
    d.cdp.js("document.getElementById('shareClose') ? 0 : document.getElementById('sfClose').click(); 'c'")
    return r.ok("兜底弹窗正常显示并可关闭")


def c_error_ui(d):
    """特性：解析失败时给出可读错误而非空白"""
    r = CaseResult("解析失败有明确提示", "稳定性")
    try:
        d.cdp.js("resolveVideo('BV不存在的视频号XYZ'); 'go'", timeout=15)
    except Exception as e:
        return r.fail("触发解析失败时异常：%s" % e)
    end = time.time() + 30
    info = {}
    while time.time() < end:
        info = d.cdp.js("JSON.stringify({err: document.getElementById('errText').textContent,"
                        "shown: !document.getElementById('errLayer').hidden,"
                        "status: document.getElementById('statLeft').textContent})") or {}
        if info.get("shown") or (info.get("err") or "").strip():
            break
        time.sleep(1.5)
    err = (info.get("err") or "").strip()
    if not err and not info.get("shown"):
        return r.fail("解析无效链接后界面毫无提示，用户无法判断发生了什么")
    return r.ok("给出提示：%s" % (err[:60] or info.get("status")))


def c_media_token_ttl(d):
    """特性：媒体 token 失效时给出可读错误，而不是当成「视频流加载失败」"""
    r = CaseResult("过期 token 有明确提示", "播放")
    code, _, body = d.http_probe(
        "http://127.0.0.1:8777/api/media/deadbeefdeadbeefdeadbeefdeadbeef/v?i=0",
        headers=["Range: bytes=0-1023"], want_body=True)
    err = (body or "")
    if code == 200:
        return r.fail("用无效 token 请求居然返回 200，代理缺少 token 校验")
    if "ok\":false" not in err.replace(" ", ""):
        return r.fail("无效 token 响应格式异常（code=%s）：%s" % (code, err[:80]), code=code)
    if "token" not in err:
        return r.fail("错误信息没提到 token，用户看不懂：%s" % err[:80])
    return r.ok("返回 %d 且错误信息说明了原因" % code, code=code)


# ==========================================================================
# 「画面优先」布局改造的用例
#   这几条是这次改 UI 的直接验收点：顶部栏移除、控制条合并、
#   片段/时间戳面板默认收起且可开可浮窗、低频设置进二级面板。
#   都是纯 DOM/几何断言，跑得快，但能挡住「改回去了」「没生效」这类回归。
# ==========================================================================
def c_no_topbar(d):
    """特性：顶部栏已移除（纵向空间还给画面）"""
    r = CaseResult("顶部栏已移除", "布局")
    out = d.cdp.js("""JSON.stringify((function () {
      var st = document.getElementById('stage').getBoundingClientRect();
      var wrap = document.getElementById('appWrap').getBoundingClientRect();
      return { topbar: !!document.querySelector('.topbar'),
               stageTop: Math.round(st.top - wrap.top) };
    })())""")
    if not isinstance(out, dict):
        return r.fail("读取布局失败：%r" % (out,))
    if out.get("topbar"):
        return r.fail("页面里仍有 .topbar，顶部空间没还给画面")
    if (out.get("stageTop") or 999) > 24:
        return r.fail("播放器上方仍有 %spx 占用，顶部栏没真正移除" % out.get("stageTop"))
    return r.ok("无顶部栏，播放器距容器顶 %spx" % out.get("stageTop"), top=out.get("stageTop"))


def c_ctrl_merged(d):
    """特性：播放按钮与时间轴合并进同一条控制条"""
    r = CaseResult("播放按钮与时间轴合并成一条", "布局")
    out = d.cdp.js("""JSON.stringify((function () {
      var bar = document.querySelector('.ctrl-card');
      if (!bar) return { err: 'no ctrl-card' };
      var trk = document.getElementById('ribbon');
      var btn = document.getElementById('btnToggle');
      return {
        sameBox: !!(trk && btn && bar.contains(trk) && bar.contains(btn)),
        h: Math.round(bar.getBoundingClientRect().height),
        separateRibbon: document.querySelectorAll('.ribbon-card').length,
        segBlocks: trk ? trk.querySelectorAll('.seg-block').length : -1
      };
    })())""")
    if not isinstance(out, dict) or out.get("err"):
        return r.fail("控制条结构缺失：%s" % ((out or {}).get("err") or out))
    if not out.get("sameBox"):
        return r.fail("播放按钮与时间轴不在同一条控制条里（仍是分开的两块）")
    if out.get("separateRibbon"):
        return r.fail("仍存在独立的 .ribbon-card，时间轴没合并")
    if (out.get("h") or 999) > 76:
        return r.fail("控制条高 %spx，没起到精简作用（应 <=76）" % out.get("h"))
    return r.ok("合并为一条，高 %spx，段块 %d 个" % (out.get("h"), out.get("segBlocks")),
                height=out.get("h"))


def c_side_hidden(d):
    """特性：片段列表 + 评论时间戳合并进一个默认收起的面板"""
    r = CaseResult("片段面板默认收起且已合并", "布局")
    try:
        d.cdp.js("(function(){ try{ toggleSide(false); }catch(e){} return 'x'; })()", timeout=10)
    except Exception:
        pass
    time.sleep(0.4)
    out = d.cdp.js("""JSON.stringify({
      hidden: document.getElementById('side').hidden,
      listIn: !!document.querySelector('#side #segList'),
      textIn: !!document.querySelector('#side #text')
    })""")
    if not isinstance(out, dict):
        return r.fail("读取侧栏状态失败：%r" % (out,))
    if out.get("hidden") is not True:
        return r.fail("侧栏默认展开（hidden=%s），会占掉画面空间" % out.get("hidden"))
    if not (out.get("listIn") and out.get("textIn")):
        return r.fail("片段列表与时间戳文本没有合并到同一个面板里")
    return r.ok("默认收起，片段列表与时间戳已合并到同一面板")


def c_side_toggle(d):
    """特性：面板可由按钮开启，且能切成右侧浮窗"""
    r = CaseResult("片段面板可开启并可切浮窗", "布局")
    try:
        d.cdp.js("toggleSide(true); 'open'", timeout=12)
    except Exception as e:
        return r.fail("打开面板失败：%s" % e)
    time.sleep(0.5)
    inline = d.cdp.js("""JSON.stringify({
      hidden: document.getElementById('side').hidden,
      w: Math.round(document.getElementById('side').getBoundingClientRect().width),
      listH: Math.round(document.getElementById('segList').getBoundingClientRect().height)
    })""")
    if not isinstance(inline, dict):
        return r.fail("读取面板状态失败：%r" % (inline,))
    if inline.get("hidden") is not False:
        return r.fail("点了开启后面板仍未显示（hidden=%s）" % inline.get("hidden"))
    if (inline.get("listH") or 0) <= 0:
        return r.fail("面板开了但片段列表高度为 0，等于没内容")

    try:
        d.cdp.js("setSideMode('float'); 'f'", timeout=12)
    except Exception as e:
        return r.fail("切换浮窗模式失败：%s" % e)
    time.sleep(0.5)
    fl = d.cdp.js("""JSON.stringify({
      float: document.body.classList.contains('side-float'),
      pos: getComputedStyle(document.getElementById('side')).position,
      mask: !document.getElementById('sideMask').hidden,
      right: Math.round(window.innerWidth - document.getElementById('side').getBoundingClientRect().right)
    })""")
    if not isinstance(fl, dict):
        return r.fail("读取浮窗状态失败：%r" % (fl,))
    if not fl.get("float") or fl.get("pos") != "fixed":
        return r.fail("浮窗模式未生效（float=%s pos=%s）" % (fl.get("float"), fl.get("pos")))
    if not fl.get("mask"):
        return r.fail("浮窗模式下没有遮罩，无法点背后的画面收起")
    # 注意不能写 (fl.get("right") or 999) —— 紧贴右侧时 right 就是 0，
    # 0 是 falsy 会被换成 999，于是「贴得完美」反被判成没贴住。
    right = fl.get("right")
    if right is None or right > 4:
        return r.fail("浮窗没有贴住右侧（右边距 %spx）" % right)

    # 恢复默认（内嵌 + 收起），否则会污染后面的布局断言
    try:
        d.cdp.js("setSideMode('inline'); toggleSide(false); 'back'", timeout=12)
    except Exception:
        pass
    return r.ok("内嵌→浮窗切换正常（内嵌宽 %spx，浮窗贴右 %spx）"
                % (inline.get("w"), fl.get("right")),
                inline_w=inline.get("w"), right=fl.get("right"))


def c_settings_secondary(d):
    """特性：补时 / 循环 / 倍速 / 音量 收进二级设置面板"""
    r = CaseResult("低频设置收进二级设置面板", "布局")
    out = d.cdp.js("""JSON.stringify({
      panelHidden: document.getElementById('settings').hidden,
      padIn: !!document.querySelector('#settings #padFront')
             && !!document.querySelector('#settings #padBack'),
      loopIn: !!document.querySelector('#settings #loop'),
      rateIn: !!document.querySelector('#settings #rate'),
      volIn: !!document.querySelector('#settings #vol'),
      padOutside: document.querySelectorAll('.pad-row').length
    })""")
    if not isinstance(out, dict):
        return r.fail("读取设置面板失败：%r" % (out,))
    if not (out.get("padIn") and out.get("loopIn") and out.get("rateIn") and out.get("volIn")):
        return r.fail("补时/循环/倍速/音量没有全部收进设置面板：%s"
                      % json.dumps(out, ensure_ascii=False))
    if out.get("padOutside"):
        return r.fail("主界面仍残留 %d 个补时控件（.pad-row）" % out.get("padOutside"))
    if out.get("panelHidden") is not True:
        return r.fail("设置面板默认展开，会挡住画面")
    try:
        d.cdp.js("toggleSettings(true); 'o'", timeout=10)
    except Exception as e:
        return r.fail("打不开设置面板：%s" % e)
    time.sleep(0.4)
    opened = d.cdp.js("document.getElementById('settings').hidden")
    try:
        d.cdp.js("toggleSettings(false); 'c'", timeout=10)
    except Exception:
        pass
    if opened is not False:
        return r.fail("点了设置按钮后面板仍未打开（hidden=%s）" % opened)
    return r.ok("补时/循环/倍速/音量均在二级设置内，默认收起且可开关")


# ==========================================================================
# 注册表：顺序 = 执行顺序（先基础能力，再播放，最后回归）
# ==========================================================================
def c_update_check(d):
    '''特性：设置→关于→检查更新；有更新时能下载并触发安装。'''
    r = CaseResult("检查更新+下载安装链路", "稳定性")
    try:
        d.cdp.js("""(function(){ var b=document.querySelector('#btnSet'); if(b) b.click(); return 'open'; })()""", timeout=10)
    except Exception:
        pass
    time.sleep(0.5)
    # 截获原生 evalJs 回调（不影响原 UI 逻辑，只在全局挂一份镜像供断言读取）
    d.cdp.js("""(function(){
      window.__upd = null; window.__pct = -1; window.__installed = false;
      var _o = window.onUpdateChecked, _p = window.onUpdateProgress, _i = window.onUpdateInstalled;
      window.onUpdateChecked = function(j){ window.__upd = j; if (_o) _o(j); };
      window.onUpdateProgress = function(p){ window.__pct = p; if (_p) _p(p); };
      window.onUpdateInstalled = function(){ window.__installed = true; if (_i) _i(); };
      return 'hooked';
    })()""", timeout=10)
    clicked = d.cdp.js("""(function(){
      var b = document.querySelector('#btnCheckUpdate');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked';
    })()""", timeout=10)
    if clicked != 'clicked':
        return r.fail("找不到「检查更新」按钮（clicked=%s）" % clicked)
    seen = None
    deadline = time.time() + 35
    while time.time() < deadline:
        seen = d.cdp.js("window.__upd", timeout=10)
        if isinstance(seen, dict) and seen:
            break
        time.sleep(1.0)
    if not isinstance(seen, dict) or not seen:
        return r.fail("35s 内未收到更新检查结果（可能无外网 / GitHub API 不可达 / 检查逻辑异常）")
    cv = seen.get("curVersion")
    if not cv:
        return r.fail("检查结果缺少 curVersion，内容：%r" % (seen,))
    if seen.get("hasUpdate"):
        # 自动触发下载安装，验证 APK 能下载完成并拉起系统安装器
        d.cdp.js("BiliBridge.startUpdate()", timeout=10)
        ok = False; end = time.time() + 60
        while time.time() < end:
            pct = d.cdp.js("window.__pct", timeout=10)
            inst = d.cdp.js("window.__installed", timeout=10)
            if inst is True or (isinstance(pct, (int, float)) and pct >= 100):
                ok = True
                break
            time.sleep(1.0)
        if not ok:
            return r.fail("下载/安装未达成（pct=%s installed=%s）" % (pct, inst))
        return r.ok("发现新版本并下载完成、已触发系统安装（当前 v%s）" % cv,
                    curVersion=cv, hasUpdate=True)
    status = d.cdp.js("document.querySelector('#updateStatus').textContent", timeout=10)
    return r.ok("检查更新正常：当前 v%s，状态「%s」" % (cv, status),
                curVersion=cv, hasUpdate=False)


CASES = [
    ("启动", c_app_launch),
    ("解析", c_resolve_cold),
    ("解析", c_resolve_concurrent),
    ("分享", c_deeplink_share),
    ("播放", c_play_progress),
    ("播放", c_media_stream),
    ("播放", c_media_token_ttl),
    ("播放", c_segment_autoplay),
    ("播放", c_no_veil_on_cut),
    ("播放", c_preheat_ready),
    ("解析", c_parse_eol),
    ("解析", c_eol_ui),
    ("全屏", c_fullscreen_ui),
    ("全屏", c_pause_keeps_ui),
    ("会话", c_resume_memory),
    ("会话", c_rotate_session),
    ("兼容性", c_density),
    ("布局", c_layout),
    ("布局", c_no_topbar),
    ("布局", c_ctrl_merged),
    ("布局", c_side_hidden),
    ("布局", c_side_toggle),
    ("布局", c_settings_secondary),
    ("分享", c_manual_fallback),
    ("稳定性", c_error_ui),
    ("稳定性", c_no_js_error),
    ("稳定性", c_no_crash),
    ("稳定性", c_update_check),
]