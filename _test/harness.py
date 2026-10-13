#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机自动化测试底座。

为什么需要这套东西：
  之前两次「本地验过就 push」的教训——
    1) 只验了「解析成功」没验「播放推进」，Note8 上其实根本没播出来；
    2) 折叠屏/锁屏机型无法截图、点击坐标也算不准，肉眼验证不可靠。
  所以把「每个特性都要在两台真机上跑过」变成可执行的代码：
    设备发现 → 装 APK → CDP 直连 WebView 求值 → 断言 → 出报告 → 全绿才允许 push。

能力说明：
  * CDP 直连是唯一可靠的断言通道（能读到 S.* 内部状态、真正推进的 currentTime）。
  * logcat 用常驻子进程 + 后台线程读，不能用 shell 后台 `&`（会被中断，日志丢）。
  * CDP socket 约 15s 超时，所以长观察一律「埋点/轮询」，不用长 Promise。
"""
from __future__ import print_function

import base64
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PKG = "com.bilihl"
ACT = "com.bilihl/.MainActivity"
APK = os.path.join(ROOT, "android", "bili-highlight.apk")

DEFAULT_ADB = "C:/Users/volcano/AppData/Local/Android/Sdk/platform-tools/adb.exe"

# 测试用的 B 站视频：BV1GJ411x7h7 是稳定的测试视频，评论区带时间戳
TEST_BV = "BV1GJ411x7h7"
TEST_URL = "https://www.bilibili.com/video/" + TEST_BV + "/"


def adb_path():
    return os.environ.get("BILIHL_ADB") or os.environ.get("ADB") or DEFAULT_ADB


def sh(cmd, timeout=120):
    """跑一条本地命令，返回 (rc, stdout+stderr)。"""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         universal_newlines=True, errors="replace")
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
        return 124, out or ""
    return p.returncode, out or ""


# --------------------------------------------------------------------------
# CDP：极简 WebSocket 客户端（只做 text frame，零第三方依赖）
# --------------------------------------------------------------------------
class WS(object):
    def __init__(self, url, timeout=20):
        if not url.startswith("ws://"):
            raise CdpError("bad ws url: %s" % url)
        hostport, path = url[5:].split("/", 1)
        path = "/" + path
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key))
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            d = self.s.recv(4096)
            if not d:
                raise CdpError("handshake failed")
            buf += d
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, text):
        data = text.encode("utf-8")
        mask = os.urandom(4)
        n = len(data)
        hdr = bytearray([0x81])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += n.to_bytes(2, "big")
        else:
            hdr.append(0x80 | 127)
            hdr += n.to_bytes(8, "big")
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.s.sendall(bytes(hdr) + masked)

    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d:
                raise CdpError("connection closed")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            ln = b1 & 0x7F
            if ln == 126:
                ln = int.from_bytes(self._read(2), "big")
            elif ln == 127:
                ln = int.from_bytes(self._read(8), "big")
            mask = self._read(4) if masked else None
            payload = self._read(ln)
            if mask:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0x8:
                raise CdpError("closed by peer")

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


class CdpError(Exception):
    pass


class Cdp(object):
    """对某个 localhost:port 上的 WebView 调试通道求值 JS。"""

    def __init__(self, port):
        self.port = port

    def _pages(self):
        with urllib.request.urlopen("http://127.0.0.1:%d/json" % self.port, timeout=8) as r:
            return json.load(r)

    def available(self):
        try:
            for p in self._pages():
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    return True
        except Exception:
            return False
        return False

    def page_url(self):
        try:
            for p in self._pages():
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    return p.get("url", "")
        except Exception:
            return ""
        return ""

    def eval(self, js, timeout=25):
        """在页面里求值。返回 Python 值（对象/数组会被解析成 dict/list）。

        JS 抛异常 → 抛 CdpError；这比返回 "JS_ERROR: ..." 更容易被用例断言捕获。
        """
        pages = [p for p in self._pages()
                 if p.get("type") == "page" and p.get("webSocketDebuggerUrl")]
        if not pages:
            raise CdpError("no debuggable page")
        ws = WS(pages[0]["webSocketDebuggerUrl"], timeout=timeout)
        try:
            ws.send(json.dumps({
                "id": 1, "method": "Runtime.evaluate",
                "params": {"expression": js, "returnByValue": True,
                           "awaitPromise": True, "userGesture": True},
            }))
            msg = json.loads(ws.recv())
            if "error" in msg:
                raise CdpError("protocol error: %s" % json.dumps(msg["error"], ensure_ascii=False))
            r = msg.get("result", {})
            if r.get("exceptionDetails"):
                d = r["exceptionDetails"]
                ex = (d.get("exception") or {}).get("description") or d.get("text")
                raise CdpError("js error: %s" % ex)
            val = (r.get("result") or {}).get("value")
            return val
        finally:
            ws.close()

    def js(self, expr, timeout=25):
        """求值一个返回 JSON 字符串的表达式，解码成 Python 对象。

        用例里统一写成 JSON.stringify({...})，这样断言不用处理 undefined/NaN。
        """
        raw = self.eval(expr, timeout=timeout)
        if raw is None:
            return None
        if isinstance(raw, (dict, list)):
            return raw
        try:
            return json.loads(raw)
        except Exception:
            return raw

    def wait_for(self, expr, timeout=30, interval=1.0):
        """反复求值直到 expr 为真值。expr 需返回布尔。

        长观察一律用它（而不是长 Promise）：CDP socket 15s 左右就会超时，
        长 Promise 会把整个用例拖成 TIMEOUT，拿不到任何诊断信息。
        """
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = self.js(expr)
            except CdpError as e:
                last = {"error": str(e)}
            if last is True:
                return True, last
            time.sleep(interval)
        return False, last


# --------------------------------------------------------------------------
# logcat：常驻子进程 + 后台读取线程（shell 后台 & 会被中断，日志会丢）
# --------------------------------------------------------------------------
class Logcat(object):
    def __init__(self, adb, serial, tags):
        self.adb = adb
        self.serial = serial
        self.tags = tags
        self.lines = deque(maxlen=6000)
        self.proc = None
        self._stop = False
        self._thread = None

    def clear(self):
        self.lines.clear()
        self._run(["logcat", "-c"])

    def _args(self, extra):
        a = [self.adb, "-s", self.serial]
        a += extra
        return a

    def _run(self, extra, timeout=60):
        try:
            p = subprocess.Popen(self._args(extra), stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, universal_newlines=True,
                                 errors="replace")
            out, _ = p.communicate(timeout=timeout)
            return out
        except Exception as e:
            return "ERR %s" % e

    def start(self):
        self.stop()
        self.proc = subprocess.Popen(
            self._args(["logcat", "-v", "threadtime", "-s"] + self.tags),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            universal_newlines=True, errors="replace")

        def reader():
            try:
                for line in self.proc.stdout:
                    if self._stop:
                        break
                    self.lines.append(line.rstrip("\r\n"))
            except Exception:
                pass

        self._thread = threading.Thread(target=reader, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop = True
        if self.proc:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None
        self._thread = None

    def text(self):
        return "\n".join(list(self.lines))

    def dump(self):
        """一次性导出当前缓冲（进程没起时退回 logcat -d）。"""
        t = self.text()
        if not t.strip():
            t = self._run(["logcat", "-d", "-v", "threadtime"] + [])
        return t

    def grep(self, pattern):
        rx = re.compile(pattern)
        return [l for l in self.lines if rx.search(l)]

    def find_crash(self):
        out = self._run(["logcat", "-d", "-v", "brief", "-b", "crash"], timeout=30)
        return out if ("com.bilihl" in out) else ""


# --------------------------------------------------------------------------
# Device
# --------------------------------------------------------------------------
def device_ready(serial):
    """设备是否处于可用的 device 状态。

    真实场景里设备会掉线（USB 调试断开、休眠、adb 服务重启后未自动重连），
    这时任何 adb 命令都会返回 "device offline"。测试必须把它当环境故障上报，
    而不是伪装成产品用例失败。
    """
    rc, out = sh([adb_path(), "devices"], timeout=45)
    for line in out.replace("\r", "").splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[0] == serial:
            return parts[1] == "device"
    return False


class Device(object):
    def __init__(self, serial, port, model=""):
        self.serial = serial
        self.port = port
        self.adb = adb_path()
        self.model = model
        self.android = ""
        self.api = 0
        self.webview = ""
        self.density = 0
        self.size = ""
        self.abi = ""
        self.cdp = Cdp(port)
        self.log = Logcat(self.adb, serial, [
            "BiliHl:V", "BiliHl-Share:V", "BiliHl-JS:V", "BiliHl-Diag:V",
            "BiliHl-Screen:V", "BiliApi:V", "chromium:V", "AndroidRuntime:E",
        ])
        self._forwarded = False
        self.offline = False

    def check_online(self):
        """掉线时置 offline=True，让用例统一判FAIL 而不是报一堆看不懂的错。"""
        if not device_ready(self.serial):
            self.offline = True
        return not self.offline

    # ---- 基础 ----
    def sh(self, *args, **kw):
        """adb shell。注意 Windows 下 adb.exe 的输出行尾是 CRLF，统一剥掉 \\r，
        否则所有正则匹配（getprop / density / wm size）都会静默失效。"""
        timeout = kw.pop("timeout", 60)
        cmd = [self.adb, "-s", self.serial, "shell"] + [str(a) for a in args]
        rc, out = sh(cmd, timeout=timeout)
        return out.replace("\r", "")

    def sh_ok(self, *args, **kw):
        cmd = [self.adb, "-s", self.serial, "shell"] + [str(a) for a in args]
        rc, out = sh(cmd, timeout=kw.pop("timeout", 60))
        return rc == 0, out.replace("\r", "")

    def host(self, *args, **kw):
        timeout = kw.pop("timeout", 120)
        cmd = [self.adb, "-s", self.serial] + [str(a) for a in args]
        return sh(cmd, timeout=timeout)

    # ---- 探测 ----
    def prop(self, key):
        """读单个 system property。

        注意：`adb shell getprop <key>` 直接输出值本身（不带 key 前缀），
        不是 "key: value" 形式。
        """
        return self.sh("getprop", key).strip()

    def probe(self):
        self.android = self.prop("ro.build.version.release")
        try:
            self.api = int(self.prop("ro.build.version.sdk") or 0)
        except ValueError:
            self.api = 0
        self.model = self.prop("ro.product.model") or self.model
        self.abi = self.prop("ro.product.cpu.abi")
        self.webview = ""
        for line in self.sh("dumpsys", "webviewupdate").splitlines():
            m = re.search(r"Current WebView package.*?\((\S+),\s*([0-9][0-9.]*)\)", line)
            if m:
                self.webview = "WebView %s (%s)" % (m.group(2), m.group(1))
        # density：DisplayDeviceInfo 行里有 "density 411, 411 x 411 dpi" 或 "density 560, 515 x 518 dpi"
        self.density = 0
        for line in self.sh("dumpsys", "display").splitlines():
            if "DisplayDeviceInfo" in line and "density" in line:
                m = re.search(r"density\s+(\d+)", line)
                if m:
                    self.density = int(m.group(1))
                    break
        self.size = " / ".join(
            x.split(":")[-1].strip() for x in self.sh("wm", "size").splitlines()
            if x.strip() and ":" in x)
        return self

    @property
    def name(self):
        return "%s / Android %s" % (self.model, self.android or "?")

    # ---- 应用生命周期 ----
    def install(self, apk=None):
        rc, out = self.host("install", "-r", "-t", apk or APK, timeout=300)
        ok = "Success" in out
        return ok, out.strip()

    def force_stop(self):
        self.sh("am", "force-stop", PKG)

    def wake(self):
        self.sh("input", "keyevent", "KEYCODE_WAKEUP")
        self.sh("wm", "dismiss-keyguard")
        self.sh("svc", "power", "stayon", "true")

    def launch(self, url=None, wait=9):
        """启动应用。

        注意：ColorOS 会拦掉 shell 发起的 ACTION_SEND（弹 ResolverActivity 或
        result code=3），所以一律 monkey 启动 + ACTION_VIEW 深链。
        """
        self.sh("am", "force-stop", PKG)
        self.sh("monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(wait)
        if url:
            self.open_url(url)
            time.sleep(6)
        return self

    def open_url(self, url):
        self.sh("am", "start", "-a", "android.intent.action.VIEW", "-d", url, "-n", ACT)

    def reload_page(self):
        """前端页面重载（原生不动），用于「干净的运行时状态」。"""
        self.cdp.eval("location.reload()", timeout=10)
        time.sleep(5)

    # ---- CDP 转发 ----
    # ---- HTTP 探测 ----
    def http_probe(self, url, headers=None, timeout=45, want_body=False):
        """探测本地服务接口，返回 (http_code, elapsed_str, body_head)。

        为什么不用 curl 的 `-w`：
          Android 自带的 toybox curl **不支持 -w**（会报 "option -w: error
          encountered when reading a file"）。Git Bash 里能跑通是因为路径被
          转换成了别的 curl，两边行为不一致。
        改用 `-D -`（响应头打到 stdout），HTTP 状态码就是第一行 `HTTP/1.1 206`，
        `Content-Range` 还能顺带验证分片是否正确。全版本 toybox 都支持。
        """
        args = ["curl", "-s", "-m", str(timeout), "-D", "-"]
        for h in (headers or []):
            args += ["-H", h]
        args.append(url)
        raw = self.sh(*args, timeout=timeout + 15)
        # Android curl 的行尾两台设备不一致（实测）：
        #   N6 (Android 16)：\r\r\n；Note8(Android 9)：\n\n —— 统一成 \n。
        txt = raw.replace("\r\n", "\n").replace("\r", "")
        m = re.search(r"^HTTP/\d\.\d\s+(\d{3})", txt, re.M)
        if not m:
            return 0, "0", (txt[:400] if want_body else "")
        code = int(m.group(1))
        rng = re.search(r"Content-Range:\s*bytes\s+(\d+)-(\d+)/(\d+)", txt, re.I)
        # 头体分隔不靠猜空行数量（各版本吐出的空行数不一样），
        # 而是按 body 的真实特征定位：
        #   JSON 接口 -> '{"ok"'；媒体流 -> MP4 的 ftyp box。
        body = ""
        for marker in ('{"ok"', '{"ok":', "ftyp"):
            idx = txt.find(marker)
            if idx >= 0:
                body = txt[idx:]
                break
        if not body:
            # 兜底：跳过头部所有连续空行
            lines = txt.split("\n")
            i = 0
            while i < len(lines) and lines[i].strip() != "":
                i += 1
            while i < len(lines) and lines[i].strip() == "":
                i += 1
            body = "\n".join(lines[i:])
        if want_body:
            return code, "0", body[:400]
        return code, "0", ("%s" % ("-".join(rng.groups()) if rng else "?"))

    def pid(self):
        p = self.sh("pidof", PKG).strip()
        return p.split()[0] if p else ""

    def forward(self):
        """把 WebView 调试 socket 转发到 localhost:self.port。"""
        pid = self.pid()
        if not pid:
            raise CdpError("app not running (no pid)")
        self.host("forward", "--remove", "tcp:%d" % self.port)
        rc, out = self.host("forward", "tcp:%d" % self.port,
                            "localabstract:webview_devtools_remote_%s" % pid)
        self._forwarded = (rc == 0)
        return self._forwarded

    def wait_page(self, timeout=25):
        """等到 WebView 调试通道可用。

        注意：进程 pid 在 force-stop / 重启后会变，devtools socket 名带 pid，
        所以每次都要重新 forward（旧的 forward 会指向已死的进程）。
        """
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.forward() and self.cdp.available():
                    return True
            except CdpError:
                pass
            except Exception:
                pass
            time.sleep(1.0)
        return False

    # ---- 屏幕 ----
    def rotate(self, mode):
        """0=竖屏 1=横屏 2=反向竖屏"""
        self.sh("settings", "put", "system", "accelerometer_rotation", "0")
        self.sh("settings", "put", "system", "user_rotation", str(mode))

    def rotate_restore(self):
        self.sh("settings", "put", "system", "accelerometer_rotation", "1")

    def teardown(self):
        """测试收尾：把设备恢复到「干净、没有测试残留界面」的状态。

        之前跑完套件，手机就停在播放器/全屏/兜底弹窗上，两个后果：
          1) 手动拿起手机看到的是测试残留界面，不像一个刚装好的应用；
          2) 下一轮冷启动用例拿到的其实是「后台还活着的应用」，测不到真正的冷启动。
        所以这里必须：页面自复位 → 回桌面 → 强杀进程 → 恢复旋转 → 清日志与端口转发。
        """
        # 1) 让页面自己先复位（退出全屏 / 停播放 / 关掉浮层），
        #    避免 force-stop 时还在解码、也避免把「全屏」「弹窗」状态带进下一轮
        try:
            self.cdp.js(
                "(function(){try{"
                " if(typeof setUiMode==='function') setUiMode('normal');"
                " if(typeof stopAll==='function') stopAll();"
                " var a=document.getElementById('shareFallback'); if(a) a.hidden=true;"
                " var b=document.getElementById('settings'); if(b) b.hidden=true;"
                " var c=document.getElementById('errLayer'); if(c) c.hidden=true;"
                " if(typeof toggleSide==='function') toggleSide(false);"
                " return 'ok';}catch(e){return 'ERR '+e;}})()",
                timeout=8)
        except Exception:
            pass   # 页面已经关掉/设备掉线时无所谓，下面还有 force-stop 兜底

        # 2) 回桌面：清掉残留界面，也让下一轮是真冷启动
        try:
            self.sh("input", "keyevent", "KEYCODE_HOME", timeout=15)
        except Exception:
            pass
        time.sleep(0.4)

        # 3) 彻底停掉应用进程
        try:
            self.force_stop()
        except Exception:
            pass

        # 4) 恢复屏幕旋转（用例里为验证旋转保持而改过 user_rotation）
        try:
            self.rotate_restore()
        except Exception:
            pass

        # 5) 清日志与端口转发
        try:
            self.log.stop()
        except Exception:
            pass
        try:
            self.log.clear()
        except Exception:
            pass
        try:
            self.host("forward", "--remove", "tcp:%d" % self.port)
        except Exception:
            pass

    def cleanup(self):
        self.log.stop()
        try:
            self.host("forward", "--remove", "tcp:%d" % self.port)
        except Exception:
            pass


# --------------------------------------------------------------------------
# 结果模型
# --------------------------------------------------------------------------
PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"


class CaseResult(object):
    def __init__(self, name, feature):
        self.name = name
        self.feature = feature
        self.status = PASS
        self.detail = ""
        self.metrics = {}
        self.seconds = 0.0
        self.logs = ""
        self.error = ""

    def ok(self, detail="", **metrics):
        self.status = PASS
        self.detail = detail
        self.metrics = metrics
        return self

    def fail(self, detail="", **metrics):
        self.status = FAIL
        self.detail = detail
        self.metrics = metrics
        return self

    def skip(self, detail=""):
        self.status = SKIP
        self.detail = detail
        return self

    def __repr__(self):
        return "<%s %s/%s>" % (self.status, self.feature, self.name)


# --------------------------------------------------------------------------
# 设备发现
# --------------------------------------------------------------------------
def list_devices(only=None):
    """返回 [(serial, model)]。only 是模型关键字过滤（大小写不敏感）。

    注意：`adb devices -l` 的行尾是 CRLF（Windows adb.exe），不去掉 \\r
    会让状态判断恒为 False —— 表现为「一台设备都发现不了」。
    """
    rc, out = sh([adb_path(), "devices", "-l"], timeout=60)
    found = []
    for raw in out.replace("\r", "").splitlines()[1:]:
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        serial = parts[0]
        state = parts[1] if len(parts) > 1 else ""
        if state != "device":
            continue
        model = ""
        for p in parts[2:]:
            if p.startswith("model:"):
                model = p.split(":", 1)[1]
        if only and only.lower() not in (model + " " + serial).lower():
            continue
        found.append((serial, model))
    return found


def make_devices(base_port=9922, only=None):
    """探测并构造 Device 列表。

    only 过滤时同时匹配：序列号、model、以及 run_suite.FRIENDLY 里的友好名，
    这样 --device N6 / --device Note8 这类人类可读的关键字也能命中。
    """
    from run_suite import FRIENDLY
    devs = []
    pairs = list_devices()
    for i, (serial, model) in enumerate(pairs):
        if only:
            names = " ".join([serial, model, FRIENDLY.get(model, "")]).lower()
            if only.lower() not in names:
                continue
        d = Device(serial, base_port + i, model)
        try:
            d.probe()
        except Exception as e:
            print("  ! probe failed for %s: %s" % (serial, e))
        devs.append(d)
    return devs