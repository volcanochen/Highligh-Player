package com.bilihl;

import com.bilihl.R;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.util.DisplayMetrics;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final int NATURAL_DPI = 411;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        // 直接修改全局 Resources / Configuration / DisplayMetrics，覆盖系统的"显示大小"放大。
        // 用 createConfigurationContext 包一层的话 WebView 拿不到，得原地改。
        try {
            Resources res = base.getResources();
            Configuration cfg = res.getConfiguration();
            if (cfg.densityDpi != NATURAL_DPI) {
                cfg.densityDpi = NATURAL_DPI;
                DisplayMetrics dm = res.getDisplayMetrics();
                dm.densityDpi = NATURAL_DPI;
                dm.density = NATURAL_DPI / 160f;
                dm.scaledDensity = dm.density;
                // updateConfiguration 在 API 25 起被标记 deprecated，但仍生效
                res.updateConfiguration(cfg, dm);
            }
        } catch (Exception e) { Log.w("BiliHl", "attachBaseContext density fix: " + e); }
    }

    private WebView wv;
    private Button btnBack, btnTest, btnFull;
    private LinearLayout topbar;
    private ProxyServer server;
    private String baseUrl;
    private String pendingBv = null;
    private boolean full = false;
    private String sharedTitle = null;

    private static final Pattern BV = Pattern.compile("(BV[0-9A-Za-z]{10})");
    private static final Pattern AVID = Pattern.compile("av(\\d+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern B23 = Pattern.compile("(https?://b23\\.tv/[^\"\\s'》\\)]+)");
    private static final Pattern B23BARE = Pattern.compile("\\bb23\\.tv/([^\"\\s'》\\)]+)");
    private static final Pattern BILI = Pattern.compile("(https?://[\\w.-]*bilibili\\.com/video/[^\"\\s'》\\)]+)");
    private static final Pattern BILISCHEME = Pattern.compile("bilibili://video/(BV[0-9A-Za-z]{10}|av\\d+)");

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // 老安卓（Android 9）在部分网络下会优先走 IPv6，而运营商 IPv6 通常不通，
        // 于是连 B 站 API 时 SYN 发到 IPv6 地址后石沉大海，连 20s 连接超时都不触发。
        // 强制只走 IPv4，避免解析/取流卡死。
        try { System.setProperty("java.net.preferIPv4Stack", "true"); } catch (Exception ignore) {}
        setContentView(R.layout.activity_main);

        wv = findViewById(R.id.wv);
        btnBack = findViewById(R.id.btnBack);
        btnTest = findViewById(R.id.btnTest);
        btnFull = findViewById(R.id.btnFull);
        topbar = findViewById(R.id.topbar);

        wv.getSettings().setJavaScriptEnabled(true);
        wv.getSettings().setDomStorageEnabled(true);
        wv.getSettings().setTextZoom(100);
        wv.getSettings().setMediaPlaybackRequiresUserGesture(false);
        wv.getSettings().setAllowFileAccess(false);
        wv.getSettings().setCacheMode(android.webkit.WebSettings.LOAD_DEFAULT);
        wv.getSettings().setUseWideViewPort(true);
        wv.getSettings().setLoadWithOverviewMode(false);
        wv.getSettings().setSupportZoom(false);
        wv.getSettings().setBuiltInZoomControls(false);
        wv.getSettings().setDisplayZoomControls(false);
        wv.getSettings().setDefaultFontSize(14);
        wv.getSettings().setMinimumFontSize(12);
        wv.getSettings().setLayoutAlgorithm(android.webkit.WebSettings.LayoutAlgorithm.NORMAL);
        // （系统"显示大小"放大会把 WebView 的 density 推到 ~1300，CSS viewport 缩到 ~125 px，
        //   这个事前端用 #appWrap transform: scale() 自己处理，不在 native 层做。）
        wv.getSettings().setUserAgentString(
                "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;
            }
        });
        // 把前端 console.log/error 转到 logcat， tag=BiliHl-JS，方便真机排查
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                Log.i("BiliHl-JS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        // JS 桥：前端（手势/全屏按钮）可调用原生能力（横屏、亮度、Toast）
        wv.addJavascriptInterface(new BiliBridge(), "BiliBridge");

        server = new ProxyServer(this);
        server.start();
        int tries = 0;
        while (server.baseUrl == null && tries++ < 60) {
            try { Thread.sleep(50); } catch (InterruptedException ignore) {}
        }
        baseUrl = server.baseUrl;

        btnBack.setOnClickListener(v -> finish());
        btnTest.setOnClickListener(v -> loadPlayerWith("BV1GJ411x7h7", "demo=1"));
        btnFull.setOnClickListener(v -> toggleFull());

        handleIntent(getIntent());
        loadPlayer();
        Log.i("BiliHl", "onCreate done: baseUrl=" + baseUrl + " pendingBv=" + pendingBv);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handleIntent(i);
        loadPlayer();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (server != null) server.shutdown();
    }

    private void loadPlayer() {
        if (baseUrl == null) return;
        String u = baseUrl;
        if (pendingBv != null && !pendingBv.isEmpty()) {
            // 用 URL 参数传给前端，前端的 loadFromNative() 会读 ?bv=...
            u = baseUrl + "?bv=" + URLEncoder.encode(pendingBv);
            if (sharedTitle != null && !sharedTitle.isEmpty())
                u += "&title=" + URLEncoder.encode(sharedTitle);
        }
        wv.loadUrl(u);
    }

    /** 带 BV + querystring 加载（如 ?demo=1 让前端自动填示例并播放） */
    private void loadPlayerWith(String bv, String qs) {
        if (baseUrl == null) return;
        String u = baseUrl + "?bv=" + URLEncoder.encode(bv);
        if (qs != null && !qs.isEmpty()) u += "&" + qs;
        wv.loadUrl(u);
    }

    private void toggleFull() {
        if (!full) {
            full = true;
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN);
            if (topbar != null) topbar.setVisibility(View.GONE);
            try { setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE); } catch (Exception ignore) {}
            evalJs("setUiMode('fullscreen')");
        } else {
            full = false;
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            if (topbar != null) topbar.setVisibility(View.VISIBLE);
            try { setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED); } catch (Exception ignore) {}
            evalJs("setUiMode('normal')");
        }
    }

    private void evalJs(String js) {
        if (wv == null) return;
        try { wv.evaluateJavascript(js, null); }
        catch (Exception e) { try { wv.loadUrl("javascript:" + js); } catch (Exception ignore) {} }
    }

    // ---------------------------------------------------------------- 分享 / 深度链接
    private void handleIntent(Intent it) {
        if (it == null) return;
        String a = it.getAction();
        Log.i("BiliHl-Share", "action=" + a + " type=" + it.getType()
                + " data=" + (it.getData() == null ? null : it.getData().toString()));

        List<String> texts = new ArrayList<>();
        String subject = null;

        if (Intent.ACTION_SEND.equals(a)) {
            if ("text/plain".equals(it.getType())) {
                CharSequence t = it.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (t != null) texts.add(t.toString());
                CharSequence s = it.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
                if (s != null) { subject = s.toString(); texts.add(s.toString()); }
                ClipData cd = it.getClipData();
                if (cd != null) for (int i = 0; i < cd.getItemCount(); i++) {
                    CharSequence ci = cd.getItemAt(i).getText();
                    if (ci != null) texts.add(ci.toString());
                }
            } else {
                // 有些分享会带缩略图 + 文本，type 不是 text/plain，但 ClipData 里仍有文本
                ClipData cd = it.getClipData();
                if (cd != null) for (int i = 0; i < cd.getItemCount(); i++) {
                    CharSequence ci = cd.getItemAt(i).getText();
                    if (ci != null) texts.add(ci.toString());
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(a)) {
            ClipData cd = it.getClipData();
            if (cd != null) for (int i = 0; i < cd.getItemCount(); i++) {
                ClipData.Item ci = cd.getItemAt(i);
                if (ci.getText() != null) texts.add(ci.getText().toString());
            }
        } else if (Intent.ACTION_VIEW.equals(a) && it.getData() != null) {
            texts.add(it.getData().toString());
        }

        String merged = "";
        for (String s : texts) merged += (merged.isEmpty() ? "" : "\n") + s;
        Log.i("BiliHl-Share", "texts=" + texts.size() + " merged=" + merged.replace("\n", " | "));

        if (subject != null && !subject.isEmpty()) sharedTitle = subject;
        String target = null, title = null;
        for (String s : texts) {
            target = extractTarget(s);
            if (target != null) { title = extractTitle(s, target); if (sharedTitle == null) sharedTitle = title; break; }
        }
        if (target == null && !merged.isEmpty()) {
            target = extractTarget(merged);
            if (sharedTitle == null) sharedTitle = extractTitle(merged, merged);
        }

        if (target == null) {
            Log.i("BiliHl-Share", "no bilibili target found in payload");
            return;
        }
        Log.i("BiliHl-Share", "target=" + target + " title=" + sharedTitle);

        if (target.startsWith("b23tv:")) {
            // "b23tv:" 前缀为 6 个字符，必须截掉 6 个，否则会残留 ':' 导致 URL 非法
            final String shortUrl = target.substring(6);
            final String fTitle = sharedTitle;
            new Thread(new Runnable() {
                public void run() {
                    final String real = resolveB23(shortUrl);
                    final String t2 = (real != null) ? extractTarget(real) : null;
                    // 只接受“非 b23.tv 短链”的解析结果：若返回仍是原短链或错误页（extractTarget 又匹配成 b23tv:），
                    // 说明短链未解析出真实视频，应当提示失败，而不是把 b23.tv 链接当目标再次 loadPlayer 造成死循环。
                    final boolean ok = (t2 != null) && !t2.startsWith("b23tv:");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            if (ok) { pendingBv = t2; sharedTitle = fTitle; loadPlayer(); }
                            else Toast.makeText(MainActivity.this, "短链解析失败", Toast.LENGTH_SHORT).show();
                        }
                    });
                }
            }).start();
        } else {
            pendingBv = target;
            loadPlayer();
        }
    }

    /** 从分享文案里抽取标题：优先 EXTRA_SUBJECT，否则取链接前的文字 */
    private static String extractTitle(String s, String target) {
        if (s == null) return null;
        if (target != null && s.contains(target)) {
            String before = s.substring(0, s.indexOf(target)).trim();
            before = before.replaceAll("^[\\s【\\[\\(·\\-–—]+", "").replaceAll("[\\s】\\]\\)·\\-–—]+$", "").trim();
            if (before.length() >= 1 && before.length() <= 50) return before;
        }
        return null;
    }

    /** 解析 b23.tv 短链：跟随 302 跳转；返回 200 页面时读 body 找真实链接；失败兜底读当前 loc */
    private static String resolveB23(String url) {
        if (url == null) return null;
        if (!url.startsWith("http")) url = "https://" + url;
        String loc = null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            c.setRequestMethod("GET");
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile");
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*");
            c.connect();
            int code = c.getResponseCode();
            loc = c.getURL().toString();
            Log.i("BiliHl-Share", "b23 code=" + code + " loc=" + loc);
            if (loc != null && loc.indexOf("b23.tv") >= 0) {
                // 没跳走（返回 200 页面），读 body 找真实链接
                java.io.InputStream is = c.getInputStream();
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = is.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
                is.close();
                String body = sb.toString();
                Matcher m = Pattern.compile("(?i)(https?://[\\w.-]*bilibili\\.com/video/[^\"'\\s<>)]+)").matcher(body);
                if (m.find()) loc = m.group(1);
                else {
                    Matcher m2 = Pattern.compile("(?i)(https?://b23\\.tv/[^\"'\\s<>)]+)").matcher(body);
                    if (m2.find()) loc = resolveB23(m2.group(1));
                }
            }
            c.disconnect();
            return loc;
        } catch (Exception e) {
            Log.w("BiliHl-Share", "resolveB23 err: " + e.getMessage());
            if (c != null) try { c.disconnect(); } catch (Exception ignore) {}
            return loc;
        }
    }

    /** 从一段文本里抠出 BV/AV 号或完整 URL（兼容裸 b23.tv、bilibili:// 深度链接、带 ?query 的 www 链接） */
    public static String extractTarget(String s) {
        if (s == null) return null;
        Matcher m = B23.matcher(s);
        if (m.find()) return "b23tv:" + m.group(1);
        m = B23BARE.matcher(s);
        if (m.find()) return "b23tv:https://" + m.group(0);
        m = BILISCHEME.matcher(s);
        if (m.find()) return m.group(1);
        m = BILI.matcher(s);
        if (m.find()) return m.group(1);
        m = BV.matcher(s);
        if (m.find()) return m.group(1);
        m = AVID.matcher(s);
        if (m.find()) return "av" + m.group(1);
        if (s.trim().startsWith("http")) return s.trim();
        return null;
    }

    // ---------------------------------------------------------------- JS 桥
    public class BiliBridge {
        @JavascriptInterface
        public void toggleFullScreen() {
            runOnUiThread(new Runnable() { public void run() { toggleFull(); } });
        }
        @JavascriptInterface
        public boolean isFullScreen() { return full; }
        @JavascriptInterface
        public void setBrightness(float b) {
            final float v = Math.max(0f, Math.min(1f, b));
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        android.view.WindowManager.LayoutParams lp = getWindow().getAttributes();
                        lp.screenBrightness = v;
                        getWindow().setAttributes(lp);
                    } catch (Exception ignore) {}
                }
            });
        }
        @JavascriptInterface
        public float getBrightness() {
            try {
                float b = getWindow().getAttributes().screenBrightness;
                return (b < 0) ? 1f : b;
            } catch (Exception e) { return 1f; }
        }
        @JavascriptInterface
        public void toast(String msg) {
            Toast.makeText(MainActivity.this, msg == null ? "" : msg, Toast.LENGTH_SHORT).show();
        }
        @JavascriptInterface
        public String getSharedTitle() { return sharedTitle == null ? "" : sharedTitle; }
    }
}
