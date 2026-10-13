# B站集锦播放器 (Highligh-Player)

把 B 站视频里的「集锦时间戳」（评论区常见的 `0:04:02 17s 动作名` 之类）变成一段**连续播放的高光集锦**。
从 B 站分享一个视频过来，自动扫评论里的时间戳，拼成一条时间轴，无缝连播。

## 功能

1. **接收 B 站分享**：注册了 `ACTION_SEND`（分享到本应用）和 `ACTION_VIEW` 深度链接，
   分享/点开 B 站视频链接直接进播放器，无需手动输入或粘贴。
2. **短链支持**：自动展开 `b23.tv` 短链（跟随 302，失败时解析返回体里的真实链接），也支持完整 URL、`BV 号`、`av 号`；
   解析不出真实视频时明确提示「短链解析失败」，不会误把短链本身当成视频加载。
3. **评论自动抓集锦**：解析视频后自动拉取评论区（多页），用正则匹配时间戳，
   按时间排序并推断每段时长（相邻间隔，封顶 30s，保底 3s），自动填入文本框，可手动调整。
4. **视频网站风格界面**：以播放器为主体，控制（上一段/播放/下一段、循环、倍速、音量）放在下方/侧边；
   窄屏单列、宽屏两列，兼容**接近方形的大折叠屏**。
5. **无缝连播**：双 `<video>` 预载 + 段末切换，视频与音频分离代理，播放中切换片段画面不移位。
6. **全屏横屏**：全屏时自动切横屏 + 沉浸式（隐藏状态栏/导航栏）；时间轴与控件半透明，3 秒无操作自动隐藏，
   点按任意处唤回；可「锁定」防误触。左上 `✕` 退出全屏，右上 `🔒` 锁定控件。
7. **手势**：单击播放/暂停（屏幕中央闪现图标）；双击进入全屏（已在全屏时，双击左/右半屏 → 快退/快进 10s）；
   左右滑动快进快退（带时间预览）；左半屏上下滑调**亮度**，右半屏上下滑调**音量**。
8. **静音 & 记忆播放**：一键静音；自动记住每个视频上次看到第几段及进度，再次打开同一视频时提供「继续播放 / 从头」。

## 目录结构

```
.
├── static/                 # 前端（B 站视频网站风格）：index.html / app.js / style.css
├── server.py               # 桌面开发服务器（本地 HTTP + /api/resolve /api/replies /api/media 代理）
├── start.cmd               # Windows 一键起桌面版
├── android/                # Android 应用（内置同源本地服务，WebView 加载前端）
│   ├── app/src/main/java/com/bilihl/
│   │   ├── MainActivity.java   # 分享/深链解析、WebView、密度与视口处理
│   │   ├── ProxyServer.java    # 本机 HTTP 服务（静态托管 + API 代理）
│   │   └── BiliApi.java        # view → wbi 签名 → playurl 取流，评论抓取
│   ├── build_apk.sh / build_apk.bat   # 免 Gradle 离线构建
│   └── make_apk.py             # 合并 dex + assets
└── _test/                  # 单元测试
```

## 构建 Android APK（免 Gradle，纯 SDK 工具链）

需要：JDK 17（Android Studio 自带 jbr 亦可）、Android SDK `build-tools`、`platforms/android-34`。

```bash
bash android/build_apk.sh      # Git Bash / Linux / macOS
# 或 Windows: android\build_apk.bat
```

流程：`aapt2 compile/link → javac → d8 → 合并 dex+assets → zipalign → apksigner`。
首次构建会在 `android/keystore.jks` 自动生成一个自签名 keystore（**该文件已被 .gitignore 排除，请勿提交**）。

产物：`android/bili-highlight.apk`。

## 运行桌面版（调试前端）

```bash
python server.py
# 浏览器打开 http://127.0.0.1:8777/
```

## 兼容性说明（重要）

- **目标**：Android 9+ 的老机器（系统 WebView 内核可能只有 Chrome 74）。
  前端刻意不用 `inset` 简写、flex `gap`、`?.`/`??`、`:is()`、`clamp()`、`aspect-ratio` 等新特性。
- **强制 IPv4**：老安卓在部分网络下会优先走 IPv6，而运营商 IPv6 不通，导致连 B 站 API 时
  长时间挂起（连 20s 连接超时都不触发）。`MainActivity` 中 `java.net.preferIPv4Stack=true` 规避。
- **屏幕兼容模式**：`AndroidManifest.xml` 必须声明 `targetSdkVersion`，否则系统按 targetSdk=1 处理，
  把 App 塞进 320dp 小窗口拉伸，导致 UI 放大数倍、WebView CSS 视口异常、点击错位。

## 测试

```bash
# extractTarget() 分享文本解析单测（BV/av/短链/完整 URL）
# 编译方式见 android/build_apk.sh 的 javac 步骤，测试类在 _test/BiliIntentTest.java
```

## 更新日志

- **本次更新**
  - 修复 `b23.tv` 短链解析：短链前缀 `b23tv:` 是 6 个字符，原实现误截 5 个导致残留 `:`，
    拼出 `https://:https://…` 非法 URL（日志 `invalid port: https:`），**所有短链分享都会失败**；现已修正，
    并在解析结果仍是短链/错误页时明确提示「短链解析失败」，避免误加载。
  - 分享文本采集增强：同时读取 `EXTRA_TEXT`、`EXTRA_SUBJECT`、`ClipData` 与 `ACTION_VIEW` 的 `data`，
    兼容 `SEND` / `SEND_MULTIPLE` / `VIEW`；URL 正则保留 `?query` 参数（B 站分享常带 `?share_source=copy_web`）。
  - 新增**全屏横屏 + 半透明自动隐藏时间轴**。
  - 新增**手势操作**（单击/双击/滑动调进度、亮度、音量）。
  - 新增**静音**与**记忆播放**（继续播放/从头）。
- **解析速度优化（15s+ → ~0.35s）**
  - **根因：网络 IPv6 黑洞**。测试机到 `api.bilibili.com` 的 IPv6 路由不通（`curl -6` 20s 超时，`curl -4` 0.2s 正常），
    而 Android 9 的 `HttpURLConnection` 无 Happy-Eyeballs，会先试 IPv6 挂满超时。已自建 `SSLSocketFactory`
    强制走 IPv4（SNI/证书校验仍用原域名），`httpGetString` 与媒体取流都生效。
  - view / buvid / wbi 三个互不依赖请求改为**并行**；评论与时间戳抓取**内联进解析响应**（与 playurl 并行），前端少一次往返。
  - 新增**5 分钟解析结果缓存**：重开同一视频近乎秒开。
  - view 请求失败自动重试一次（弱网鲁棒性）。
- **修复：评论恒为空导致片段恒为空**
  - B 站评论接口 `/x/v2/reply` 现要求 `ps<=20`，原代码传 `ps=30` 返回 `-400 ps out of bounds` 导致评论拉取直接失败；
    已改为 20 并加保护。
  - 修复线程池嵌套死锁（评论分页拆到独立线程池）。

## 免责声明

仅供个人学习研究使用。视频内容版权归哔哩哔哩及原作者所有，请勿用于任何商业用途。
