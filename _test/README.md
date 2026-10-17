# 真机自动化测试套件

本目录是**真机自动化测试**。它的存在理由很直接：
项目里出过两次「本地看着没问题就 push，结果真机上挂了」的事故——
一次 Note8 根本没播出来（只验了「解析成功」就收工），一次 N6 网络超时（凭想当然，没实测）。

所以这里把「每个特性都在两台真机上跑过」变成可执行的代码：
**用例 → 报告 → 全绿才允许 push**。

## 一键验收

```bash
# 构建 + JVM 单元测试 + 双机真机测试 + 出报告（不绿则退出码非 0）
bash scripts/verify.sh

# 测试通过后顺带提交并推送报告
bash scripts/verify.sh --push

# 跳过构建，用现有 APK
bash scripts/verify.sh --fast
```

## 单独跑

```bash
python _test/run_suite.py                    # 全部设备 + 全部用例
python _test/run_suite.py --device N6        # 只跑 N6（折叠屏 / Android 16）
python _test/run_suite.py --device Note8     # 只跑 Note8（Android 9 / WebView 74）
python _test/run_suite.py --feature 播放      # 只跑某个特性
python _test/run_suite.py --no-install       # 不重装 APK
python _test/run_suite.py --report-only      # 用上次结果重新渲染报告

python _test/cdp_eval.py -c "S.idx"          # 临时在真机页面里执行 JS
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `harness.py` | 设备发现/能力探测、APK 安装、CDP 直连WebView、logcat 抓取、HTTP 探测 |
| `cases.py` | 分特性测试用例（新增特性就往 `CASES` 注册表里加一条） |
| `run_suite.py` | 调度、结果模型、Markdown 报告生成、退出码 |
| `cdp_eval.py` | 命令行版 CDP 求值（调试单个表达式时用） |
| `com/hplayer/BiliIntentTest.java` | JVM 单元测试：链接/标题解析 |
| `last_result.json` | 最近一次结果（供 `--report-only` 复用） |

## 环境要求

- 两台设备同时通过 adb 连接（USB 或 `adb connect`）
- 设备的 WebView 调试端口可用（应用已开启 `setWebContentsDebuggingEnabled`）
- Python 3（仅用标准库，无第三方依赖）

## 覆盖的用例

| 特性 | 用例 | 抓的是什么问题 |
|---|---|---|
| 启动 | 应用启动 + 本地服务监听 | WebView 没起来、调试通道不通 |
| 解析 | 冷启动首次解析不超时 | 连接池泄漏（曾必超时 18s） |
| 解析 | 5 次连续解析全成功 | 弱网/连接竞争下的鲁棒性 |
| 解析 | 三种换行符解析一致 | Windows/Linux/CR 换行兼容 |
| 解析 | 时间戳文本无裸回车 | 换行残留导致解析错行 |
| 分享 | 深链打开并自动解析 | `ACTION_VIEW` 链路、链接提取 |
| 分享 | 手动粘贴兜底可用 | 读不到链接时用户有出路 |
| 播放 | 播放推进且可解码 | **只验解析成功、实际没播出来** |
| 播放 | 媒体流 206 可读 | 代理截断 / 不是可解码 MP4 |
| 播放 | 过期 token 有明确提示 | token TTL 到期后的错误可读性 |
| 播放 | 段末自动连播 | 切段失效 |
| 播放 | 切段无加载遮罩 | 分镜式切换是否真的不闪圈 |
| 播放 | 下一段预热就位 | 预热是否生效 |
| 全屏 | 全屏常驻进度条可见 | 进度条自己消失 |
| 全屏 | 暂停时控制条常显 | 暂停时误触发自动隐藏 |
| 会话 | 播放位置落盘可恢复 | 续播基础 |
| 会话 | 旋转保持 session 与进度 | 折叠屏切屏丢 session |
| 兼容性 | density 钳制策略正确 | 误伤正常 density |
| 布局 | 视频区尺寸正常 | 视频区塌缩 |
| 稳定性 | 解析失败有明确提示 | 失败时界面空白 |
| 稳定性 | 无 JS 运行时错误 | 静默异常 |
| 稳定性 | 应用无崩溃 | crash |

## 加新用例

```python
def c_my_feature(d):
    """特性：我要测的东西"""
    r = CaseResult("人话名称", "特性分类")
    s = _snap(d)                     # 一次拿全状态，避免多次 CDP 往返
    if s.get("token") is None:
        return r.fail("没有 token")
    return r.ok("通过", key="value")  # metrics 会进报告

CASES = [ ..., ("特性分类", c_my_feature) ]
```

`CaseResult.ok(detail, **metrics)` / `.fail(detail, **metrics)` / `.skip(detail)`。

## 写断言的几条硬规矩

这些都是踩过坑总结出来的：

1. **断言真实状态，不要断言日志。**
   日志出现 `resolve done` 不代表能播。必须读 `S.*` 与 `video.currentTime` / `readyState`。

2. **不要包装被测函数来做埋点。**
   曾经包装 `jumpTo` 后自己递归，造出「片段疯狂循环」的假象，白查了半小时。
   用 `MutationObserver` 观察 DOM，或从外部轮询状态。

3. **一条 eval 里做完注入 + 触发。**
   `reparse()` 和 `jumpTo()` 分成两次 CDP 调用会在中间被打断，
   表现为 `idx` 卡在 -1、遮罩一直亮着——全是假象。

4. **必须先确保 token 就绪。**
   没有 token 时 `jumpTo` 直接静默 return，看起来像「产品坏了」。

5. **断言要用完整数据。**
   日志里的 token 是截断的 8 位，拿它去请求必然 404，看着像媒体流坏了。
   媒体 token 还有 TTL，长跑套件时会过期，用例要自己重新解析。

6. **设备掉线是环境问题，不是产品问题。**
   `check_online()` 会挡住并标记，别让一堆「adb device offline」混进产品缺陷里。

7. **测试数据要先验证有效。**
   曾经把不存在的 BV 号写进用例，失败后误以为是产品 bug。用例里的 BV 都实测过 `ok=true`。

## 排查真机的两个必备通道

折叠屏/锁屏机型无法截图、点击坐标也算不准，所以：

```bash
# 1) 转发 WebView 调试端口
adb -s <serial> forward tcp:9922 localabstract:webview_devtools_remote_<pid>

# 2) 在页面里执行 JS 并取回结果
python _test/cdp_eval.py -c "JSON.stringify({idx:S.idx, t:activeDeck().v.currentTime})"
```

CDP socket 约 15 秒超时，所以长时间观察要「埋点 + 短命令轮询」，不要用长 Promise。

日志过滤：

```bash
adb -s <serial> logcat -s HPlayer:V HPlayer-JS:V HPlayer-Diag:V HPlayer-Share:V
```

- `HPlayer-JS` 是 console 转发（`WebChromeClient.onConsoleMessage`），页面里的报错都在这
- `HPlayer-Diag` 是前端主动上报的诊断信息（布局尺寸、播放状态等）

## Android 环境备忘（本项目实测）

- Android 自带 `curl` **不支持 `-w`**，用 `-D -` 读响应头拿状态码。
- Android `curl` 的行尾两台设备不一致（Android 16 是 `\r\r\n`，Android 9 是 `\n\n`），
  解析前先统一行尾，且**不要靠数空行**来切头体，按 body 特征（`{"ok"` / `ftyp`）定位更稳。
- `adb shell getprop <key>` 输出的是**值本身**，不是 `key: value`。
- Windows 下 adb 所有输出带 CRLF，不剥 `\r` 会让所有正则静默失效。
- ColorOS 会拦掉 shell 发起的 `ACTION_SEND`（弹 ResolverActivity 或 `result code=3`），
  测分享要用 `monkey` 启动后再发 `ACTION_VIEW` 深链。
- `build_apk.bat` 在本机因行尾是 LF 导致 cmd 解析错乱，用 `bash android/build_apk.sh`。
- Note8 走 USB，长时间跑套件可能掉线成 `offline`，需重插；`run_suite.py` 会识别并标记。