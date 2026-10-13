package com.bilihl;

import com.bilihl.R;

import android.app.Activity;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.util.DisplayMetrics;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
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

    private static final Pattern BV = Pattern.compile("(BV[0-9A-Za-z]{10})");
    private static final Pattern AVID = Pattern.compile("av(\\d+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern B23 = Pattern.compile("(https?://b23\\.tv/\\S+)");
    private static final Pattern BILI = Pattern.compile("(https?://[\\w.]*bilibili\\.com/video/\\S+)");

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
            u = baseUrl + "?bv=" + java.net.URLEncoder.encode(pendingBv);
        }
        wv.loadUrl(u);
    }

    /** 带 BV + querystring 加载（如 ?demo=1 让前端自动填示例并播放） */
    private void loadPlayerWith(String bv, String qs) {
        if (baseUrl == null) return;
        String u = baseUrl + "?bv=" + java.net.URLEncoder.encode(bv);
        if (qs != null && !qs.isEmpty()) u += "&" + qs;
        wv.loadUrl(u);
    }

    private void toggleFull() {
        View decor = getWindow().getDecorView();
        if (!full) {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN);
            topbar.setVisibility(View.GONE);
            full = true;
        } else {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            topbar.setVisibility(View.VISIBLE);
            full = false;
        }
    }

    // ---------------------------------------------------------------- 分享 / 深度链接
    private void handleIntent(Intent it) {
        if (it == null) return;
        String a = it.getAction();
        String txt = null;
        if (Intent.ACTION_SEND.equals(a) && "text/plain".equals(it.getType())) {
            txt = it.getStringExtra(Intent.EXTRA_TEXT);
        } else if (Intent.ACTION_VIEW.equals(a) && it.getData() != null) {
            txt = it.getData().toString();
        }
        if (txt == null) return;
        final String target = extractTarget(txt);
        if (target == null) {
            Toast.makeText(this, "没有识别到 B 站视频", Toast.LENGTH_SHORT).show();
            return;
        }
        if (target.startsWith("b23tv:")) {
            final String shortUrl = target.substring(5);
            new Thread(new Runnable() {
                public void run() {
                    final String real = resolveB23(shortUrl);
                    final String t2 = (real != null) ? extractTarget(real) : null;
                    runOnUiThread(new Runnable() {
                        public void run() {
                            if (t2 != null) { pendingBv = t2; loadPlayer(); }
                            else Toast.makeText(MainActivity.this, "短链解析失败", Toast.LENGTH_SHORT).show();
                        }
                    });
                }
            }).start();
        } else {
            pendingBv = target;
        }
    }

    /** 解析 b23.tv 短链：优先跟随 302 跳转，失败时解析返回体里的 bilibili 链接 */
    private static String resolveB23(String url) {
        String loc = null;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestMethod("GET");
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile");
            c.connect();
            loc = c.getURL().toString();
            // 如果没跳走（返回 200 页面），读 body 找真实链接
            if (loc != null && loc.indexOf("b23.tv") >= 0) {
                java.io.InputStream is = c.getInputStream();
                byte[] buf = new byte[64 * 1024];
                int n = is.read(buf);
                is.close();
                if (n > 0) {
                    String body = new String(buf, 0, n, "UTF-8");
                    java.util.regex.Matcher m = java.util.regex.Pattern
                            .compile("(https?://[\\w.]*bilibili\\.com/video/\\S+?)[\"'\\s<]").matcher(body);
                    if (m.find()) loc = m.group(1);
                }
            }
            c.disconnect();
            return loc;
        } catch (Exception e) {
            return loc;   // 跳转后的 URL 仍可用
        }
    }

    /** 从一段文本里抠出 BV/AV 号或完整 URL（兼容 b23.tv 短链） */
    public static String extractTarget(String s) {
        if (s == null) return null;
        if (s.indexOf("b23.tv") >= 0) {
            Matcher m = B23.matcher(s);
            if (m.find()) return "b23tv:" + m.group(1);
        }
        Matcher m = BV.matcher(s);
        if (m.find()) return m.group(1);
        m = AVID.matcher(s);
        if (m.find()) return "av" + m.group(1);
        m = BILI.matcher(s);
        if (m.find()) return m.group(1);
        if (s.trim().startsWith("http")) return s.trim();
        return null;
    }
}