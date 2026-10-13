package com.bilihl;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本机 HTTP 服务：托管前端静态文件 + 提供 /api/resolve 与 /api/media 代理。
 * 与桌面 server.py 一一对应，WebView 直接加载 http://127.0.0.1:PORT/ 即可（同源，前端代码零改动）。
 */
public class ProxyServer extends Thread {
    private static final String TAG = "BiliHl";
    private final Context ctx;
    private ServerSocket ss;
    private int port = -1;
    public String baseUrl = null;

    public ProxyServer(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    @Override
    public void run() {
        for (int p = 8777; p <= 8782; p++) {
            try {
                ss = new ServerSocket(p, 50, InetAddress.getByName("127.0.0.1"));
                port = p;
                break;
            } catch (IOException ignore) { /* 端口被占用，试下一个 */ }
        }
        if (ss == null) { Log.e(TAG, "无法在 8777~8782 绑定本地端口"); return; }
        baseUrl = "http://127.0.0.1:" + port + "/";
        Log.i(TAG, "本地服务已启动：" + baseUrl);
        ExecutorService pool = Executors.newCachedThreadPool();
        while (!isInterrupted()) {
            try {
                Socket s = ss.accept();
                pool.execute(() -> handle(s));
            } catch (IOException e) {
                break;
            }
        }
    }

    public void shutdown() {
        try { ss.close(); } catch (Exception ignore) {}
        interrupt();
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(35000);
            BufferedReader br = new BufferedReader(new InputStreamReader(s.getInputStream(), "ISO-8859-1"));
            String reqLine = br.readLine();
            if (reqLine == null) { s.close(); return; }
            String[] parts = reqLine.split(" ");
            if (parts.length < 2) { s.close(); return; }
            String method = parts[0];
            String full = parts[1];
            int q = full.indexOf('?');
            String path = (q < 0) ? full : full.substring(0, q);
            String query = (q < 0) ? "" : full.substring(q + 1);
            Map<String, String> headers = new LinkedHashMap<>();
            String h;
            while ((h = br.readLine()) != null && !h.isEmpty()) {
                int c = h.indexOf(':');
                if (c > 0) headers.put(h.substring(0, c).trim(), h.substring(c + 1).trim());
            }
            OutputStream os = s.getOutputStream();
            if ("GET".equals(method) || "HEAD".equals(method)) {
                route(path, query, headers, os, "HEAD".equals(method));
            }
            os.flush();
        } catch (Exception e) {
            Log.w(TAG, "handle: " + e.getMessage());
        } finally {
            try { s.close(); } catch (Exception ignore) {}
        }
    }

    private static Map<String, String> parseQuery(String qs) {
        Map<String, String> m = new LinkedHashMap<>();
        if (qs == null || qs.isEmpty()) return m;
        for (String pair : qs.split("&")) {
            int eq = pair.indexOf('=');
            try {
                if (eq < 0) m.put(URLDecoder.decode(pair, "UTF-8"), "");
                else m.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"),
                           URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
            } catch (Exception ignore) {}
        }
        return m;
    }

    private void route(String path, String query, Map<String, String> headers, OutputStream os, boolean head)
            throws IOException {
        if ("/api/ping".equals(path)) {
            sendJson(os, 200, "{\"ok\":true,\"t\":" + System.currentTimeMillis() + "}");
        } else if ("/api/resolve".equals(path)) {
            Map<String, String> q = parseQuery(query);
            String raw = q.getOrDefault("url", "");
            int page = parseInt(q.get("p"), 1);
            int qn = parseInt(q.get("qn"), 80);
            String cookie = q.getOrDefault("cookie", "");
            try {
                if (raw.trim().isEmpty()) throw new RuntimeException("请填写视频链接或 BV 号");
                JSONObject j = BiliApi.resolve(raw, page, qn, cookie);
                sendJson(os, 200, j.toString());
            } catch (Exception e) {
                sendJson(os, 200, "{\"ok\":false,\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
            }
        } else if ("/api/replies".equals(path)) {
            Map<String, String> q = parseQuery(query);
            String aid = q.getOrDefault("aid", "");
            int maxPages = parseInt(q.get("pages"), 5);
            int ps = parseInt(q.get("ps"), 20);
            try {
                if (aid.isEmpty()) throw new RuntimeException("缺少 aid");
                JSONArray replies = BiliApi.fetchReplies(aid, maxPages, ps);
                JSONArray hits = BiliApi.extractTimestamps(replies);
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("count", replies.length());
                out.put("matched", hits);
                out.put("replies", replies);
                sendJson(os, 200, out.toString());
            } catch (Exception e) {
                sendJson(os, 200, "{\"ok\":false,\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
            }
        } else if (path.startsWith("/api/media/")) {
            String[] seg = path.split("/");
            if (seg.length < 4) { sendJson(os, 400, "{\"ok\":false,\"error\":\"bad media path\"}"); return; }
            String token = seg[3];
            String kind = seg.length > 4 ? seg[4] : "v";
            Map<String, String> q = parseQuery(query);
            int idx = parseInt(q.get("i"), 0);
            String range = headers.get("Range");
            handleMedia(os, token, kind, idx, range);
        } else {
            serveStatic(os, path, head);
        }
    }

    private void handleMedia(OutputStream os, String token, String kind, int idx, String range)
            throws IOException {
        BiliApi.MediaResult r = BiliApi.openMedia(token, kind, idx, range);
        if (r.stream == null) {
            int code = (r.status == 502) ? 502 : 404;
            sendJson(os, code, "{\"ok\":false,\"error\":" +
                    (r.status == 404 ? "\"token 已失效，请重新解析视频\"" : "\"流地址不可用\"") + "}");
            return;
        }
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(r.status).append(r.status == 206 ? " Partial Content" : " OK").append("\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        String ctype = r.contentType;
        if (ctype == null || (!ctype.startsWith("video/") && !ctype.startsWith("audio/")))
            ctype = "v".equals(kind) ? "video/mp4" : "audio/mp4";
        head.append("Content-Type: ").append(ctype).append("\r\n");
        if (r.contentRange != null) head.append("Content-Range: ").append(r.contentRange).append("\r\n");
        if (r.contentLength >= 0) head.append("Content-Length: ").append(r.contentLength).append("\r\n");
        if (r.acceptRanges != null) head.append("Accept-Ranges: ").append(r.acceptRanges).append("\r\n");
        else head.append("Accept-Ranges: bytes\r\n");
        if (r.etag != null) head.append("ETag: ").append(r.etag).append("\r\n");
        head.append("Cache-Control: public, max-age=86400\r\n");
        head.append("Connection: close\r\n\r\n");
        os.write(head.toString().getBytes("UTF-8"));
        os.flush();
        byte[] buf = new byte[65536];
        int n;
        try {
            while ((n = r.stream.read(buf)) > 0) os.write(buf, 0, n);
        } catch (IOException e) {
            Log.w(TAG, "media write aborted (client seek/stop): " + e.getMessage());
        } finally {
            try { r.stream.close(); } catch (Exception ignore) {}
        }
    }

    private void serveStatic(OutputStream os, String path, boolean head) throws IOException {
        String asset = path.equals("/") ? "/index.html" : path;
        if (asset.contains("..")) { send404(os); return; }
        String name = "www" + asset;
        InputStream in;
        try {
            in = ctx.getAssets().open(name);
        } catch (IOException e) {
            send404(os); return;
        }
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) baos.write(buf, 0, n);
        in.close();
        byte[] body = baos.toByteArray();
        String ctype = "text/html; charset=utf-8";
        if (name.endsWith(".js")) ctype = "text/javascript; charset=utf-8";
        else if (name.endsWith(".css")) ctype = "text/css; charset=utf-8";
        else if (name.endsWith(".json")) ctype = "application/json; charset=utf-8";
        else if (name.endsWith(".svg")) ctype = "image/svg+xml";
        else if (name.endsWith(".png")) ctype = "image/png";
        else if (name.endsWith(".ico")) ctype = "image/x-icon";

        StringBuilder hdr = new StringBuilder();
        hdr.append("HTTP/1.1 200 OK\r\n");
        hdr.append("Content-Type: ").append(ctype).append("\r\n");
        hdr.append("Content-Length: ").append(body.length).append("\r\n");
        hdr.append("Cache-Control: no-cache\r\n");
        hdr.append("Connection: close\r\n\r\n");
        os.write(hdr.toString().getBytes("UTF-8"));
        if (!head) os.write(body);
        os.flush();
    }

    private void sendJson(OutputStream os, int code, String json) throws IOException {
        byte[] body = json.getBytes("UTF-8");
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(code).append(" OK\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Content-Type: application/json; charset=utf-8\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Connection: close\r\n\r\n");
        os.write(head.toString().getBytes("UTF-8"));
        os.write(body);
        os.flush();
    }

    private void send404(OutputStream os) throws IOException {
        sendJson(os, 404, "{\"ok\":false,\"error\":\"not found\"}");
    }

    private static int parseInt(String s, int def) {
        try { return s == null ? def : Integer.parseInt(s.trim()); } catch (Exception e) { return def; }
    }

    private static String jsonEscape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }
}
