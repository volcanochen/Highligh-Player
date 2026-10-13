package com.bilihl;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * B 站取流核心：view -> nav(wbi) -> playurl，与桌面 server.py 逻辑一致，纯标准库实现。
 * 不依赖任何第三方包（org.json 为 Android 内置）。
 */
public final class BiliApi {
    private static final String TAG = "BiliHl";

    static final String UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

    static final long RANGE_CAP = 3L * 1024 * 1024; // 单次回传上限，避免为一个 seek 拖下整个文件

    static final int[] MIXIN_TAB = {
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
            33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
            61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
            36, 20, 34, 44, 52
    };

    static final Map<Integer, String> QUALITY_NAME = new HashMap<>();
    static {
        QUALITY_NAME.put(120, "4K 超清");
        QUALITY_NAME.put(116, "1080P60");
        QUALITY_NAME.put(112, "1080P 高码率");
        QUALITY_NAME.put(80, "1080P 高清");
        QUALITY_NAME.put(74, "720P60");
        QUALITY_NAME.put(64, "720P 高清");
        QUALITY_NAME.put(32, "480P 清晰");
        QUALITY_NAME.put(16, "360P 流畅");
        QUALITY_NAME.put(6, "240P 极速");
        QUALITY_NAME.put(125, "HDR 真彩");
        QUALITY_NAME.put(126, "杜比视界");
        QUALITY_NAME.put(127, "8K 超高清");
    }

    /** 拉取评论，最多 max 页（每页 ps 条），返回所有 message 字段构成的数组 */
    static JSONArray fetchReplies(String aid, int maxPages, int ps) {
        JSONArray out = new JSONArray();
        if (aid == null || aid.isEmpty()) return out;
        try {
            for (int pn = 1; pn <= maxPages; pn++) {
                String url = "https://api.bilibili.com/x/v2/reply?type=1&oid=" + aid
                        + "&pn=" + pn + "&ps=" + ps + "&sort=2&web_location=1315875";
                String body = httpGetString(url, apiHeaders(lastCookie.isEmpty() ? null : lastCookie));
                JSONObject o = new JSONObject(body);
                if (o.optInt("code") != 0) break;
                JSONObject data = o.optJSONObject("data");
                if (data == null) break;
                JSONArray replies = data.optJSONArray("replies");
                if (replies == null || replies.length() == 0) break;
                for (int i = 0; i < replies.length(); i++) {
                    JSONObject r = replies.optJSONObject(i);
                    if (r == null) continue;
                    JSONObject c = r.optJSONObject("content");
                    if (c == null) continue;
                    String msg = c.optString("message", "");
                    JSONObject member = r.optJSONObject("member");
                    String uname = member == null ? "" : member.optString("uname", "");
                    JSONObject entry = new JSONObject();
                    entry.put("rpid", r.optLong("rpid"));
                    entry.put("user", uname);
                    entry.put("time", r.optLong("ctime"));
                    entry.put("text", msg);
                    out.put(entry);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "fetchReplies: " + e.getMessage());
        }
        return out;
    }

    /** 视频评论里常见的"时间戳 + 动作" 标记，每条评论只匹配一次 */
    static JSONArray extractTimestamps(JSONArray replies) throws JSONException {
        JSONArray out = new JSONArray();
        if (replies == null) return out;
        java.util.regex.Pattern[] PATS = new java.util.regex.Pattern[] {
                java.util.regex.Pattern.compile("(\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)\\s*[~-]\\s*(\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)"),
                java.util.regex.Pattern.compile("(\\d{1,2}:\\d{1,2}:\\d{1,2})"),
                java.util.regex.Pattern.compile("(?<![\\d:])([0-5]?\\d:[0-5]\\d)(?!\\d)"),
        };
        for (int i = 0; i < replies.length(); i++) {
            JSONObject r = replies.optJSONObject(i);
            if (r == null) continue;
            String text = r.optString("text", "");
            for (java.util.regex.Pattern p : PATS) {
                java.util.regex.Matcher m = p.matcher(text);
                if (m.find()) {
                    JSONObject hit = new JSONObject();
                    hit.put("time", m.group(1));
                    hit.put("end", m.groupCount() > 1 && m.group(2) != null ? m.group(2) : "");
                    hit.put("user", r.optString("user"));
                    hit.put("rpid", r.optLong("rpid"));
                    hit.put("text", text);
                    out.put(hit);
                    break;
                }
            }
        }
        return out;
    }

    /** token -> 媒体地址表（单用户应用，进程内即可） */
    static final Map<String, MediaEntry> MEDIA = new ConcurrentHashMap<>();
    static String lastCookie = "";

    static final Object wbiLock = new Object();
    static String[] wbiKey = null;
    static long wbiTs = 0;
    static String buvidCookie = "";
    static long buvidTs = 0;

    static class MediaEntry {
        List<String> v = new ArrayList<>();
        List<String> a = new ArrayList<>();
        long ts = System.currentTimeMillis();
    }

    /** 媒体拉流结果 */
    static class MediaResult {
        int status = 200;
        String contentType = "";
        String contentRange = "";
        long contentLength = -1;
        String acceptRanges = "";
        String etag = "";
        InputStream stream = null;
    }

    // ---------------------------------------------------------------- 工具
    static Map<String, String> apiHeaders(String cookie) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("User-Agent", UA);
        h.put("Referer", "https://www.bilibili.com/");
        h.put("Origin", "https://www.bilibili.com");
        h.put("Accept", "application/json, text/plain, */*");
        h.put("Accept-Language", "zh-CN,zh;q=0.9");
        if (cookie != null && !cookie.isEmpty()) h.put("Cookie", cookie);
        return h;
    }

    static String httpGetString(String url, Map<String, String> headers) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("GET");
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        if (headers != null) for (Map.Entry<String, String> e : headers.entrySet())
            c.setRequestProperty(e.getKey(), e.getValue());
        int code = c.getResponseCode();
        InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
        StringBuilder sb = new StringBuilder();
        if (in != null) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    static String md5hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] b = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    static String mixinKey(String orig) {
        StringBuilder sb = new StringBuilder();
        for (int i : MIXIN_TAB) sb.append(orig.charAt(i));
        return sb.substring(0, 32);
    }

    static String[] wbiKeys() throws Exception {
        synchronized (wbiLock) {
            if (wbiKey != null && System.currentTimeMillis() - wbiTs < 3600_000) return wbiKey;
            String nav = httpGetString("https://api.bilibili.com/x/web-interface/nav", apiHeaders(null));
            JSONObject j = new JSONObject(nav);
            JSONObject img = j.getJSONObject("data").getJSONObject("wbi_img");
            String ik = img.getString("img_url").replaceAll(".*/", "").replaceAll("\\..*", "");
            String sk = img.getString("sub_url").replaceAll(".*/", "").replaceAll("\\..*", "");
            if (ik.isEmpty() || sk.isEmpty()) throw new RuntimeException("获取 wbi 密钥失败");
            wbiKey = new String[]{ik, sk};
            wbiTs = System.currentTimeMillis();
            return wbiKey;
        }
    }

    static String wbiSign(Map<String, String> params) throws Exception {
        String[] k = wbiKeys();
        String mk = mixinKey(k[0] + k[1]);
        Map<String, String> p = new LinkedHashMap<>(params);
        p.put("wts", String.valueOf(System.currentTimeMillis() / 1000));

        List<Map.Entry<String, String>> list = new ArrayList<>(p.entrySet());
        list.sort(Comparator.comparing(Map.Entry::getKey));

        StringBuilder q = new StringBuilder();
        for (Map.Entry<String, String> e : list) {
            String v = e.getValue().replaceAll("[!'()*]", "");
            try { v = java.net.URLEncoder.encode(v, "UTF-8"); } catch (Exception ignore) {}
            q.append(e.getKey()).append("=").append(v).append("&");
        }
        if (q.length() > 0) q.setLength(q.length() - 1);

        p.put("w_rid", md5hex(q.toString() + mk));

        StringBuilder f = new StringBuilder();
        for (Map.Entry<String, String> e : p.entrySet()) {
            String v = e.getValue().replaceAll("[!'()*]", "");
            try { v = java.net.URLEncoder.encode(v, "UTF-8"); } catch (Exception ignore) {}
            f.append(e.getKey()).append("=").append(v).append("&");
        }
        if (f.length() > 0) f.setLength(f.length() - 1);
        return f.toString();
    }

    static String buvidCookie() {
        synchronized (wbiLock) {
            if (!buvidCookie.isEmpty() && System.currentTimeMillis() - buvidTs < 3600_000) return buvidCookie;
            try {
                String d = httpGetString("https://api.bilibili.com/x/frontend/finger/spi", apiHeaders(null));
                JSONObject o = new JSONObject(d).getJSONObject("data");
                buvidCookie = "buvid3=" + o.optString("b_3", "") + "; buvid4=" + o.optString("b_4", "");
            } catch (Exception e) { buvidCookie = ""; }
            buvidTs = System.currentTimeMillis();
            return buvidCookie;
        }
    }

    /** 从链接/裸 ID 解析出 [bvid, pageStr] */
    static String[] parseTarget(String raw) {
        raw = (raw == null) ? "" : raw.trim();
        int page = 1;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("[?&]p=(\\d+)").matcher(raw);
        if (m.find()) page = Math.max(1, Integer.parseInt(m.group(1)));
        m = java.util.regex.Pattern.compile("(BV[0-9A-Za-z]{10})").matcher(raw);
        if (m.find()) return new String[]{m.group(1), String.valueOf(page)};
        m = java.util.regex.Pattern.compile("av(\\d+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(raw);
        if (m.find()) return new String[]{"av" + m.group(1), String.valueOf(page)};
        throw new RuntimeException("没识别出 BV 号，请粘贴完整视频链接或 BV 号");
    }

    static JSONObject pickStream(JSONArray streams, int wantQn) throws JSONException {
        if (streams == null || streams.length() == 0) return null;
        List<JSONObject> cands = new ArrayList<>();
        for (int i = 0; i < streams.length(); i++) {
            JSONObject s = streams.getJSONObject(i);
            if (s.optInt("id") <= wantQn) cands.add(s);
        }
        if (cands.isEmpty()) for (int i = 0; i < streams.length(); i++) cands.add(streams.getJSONObject(i));
        List<JSONObject> avc = new ArrayList<>();
        for (JSONObject s : cands) if (s.optString("codecs", "").startsWith("avc1")) avc.add(s);
        if (!avc.isEmpty()) cands = avc;
        int best = 0;
        for (JSONObject s : cands) best = Math.max(best, s.optInt("id"));
        List<JSONObject> same = new ArrayList<>();
        for (JSONObject s : cands) if (s.optInt("id") == best) same.add(s);
        if (!avc.isEmpty()) for (JSONObject s : same)
            if (s.optString("codecs", "").startsWith("avc1")) return s;
        JSONObject r = same.get(0);
        for (JSONObject s : same) if (s.optInt("bandwidth", 0) > r.optInt("bandwidth", 0)) r = s;
        return r;
    }

    static JSONObject pickAudio(JSONArray audios) throws JSONException {
        if (audios == null || audios.length() == 0) return null;
        List<JSONObject> ok = new ArrayList<>();
        for (int i = 0; i < audios.length(); i++) {
            JSONObject a = audios.getJSONObject(i);
            if (a.optInt("id") != 30250 && a.optInt("id") != 30251) ok.add(a);
        }
        if (ok.isEmpty()) for (int i = 0; i < audios.length(); i++) ok.add(audios.getJSONObject(i));
        JSONObject r = ok.get(0);
        for (JSONObject a : ok) if (a.optInt("bandwidth", 0) > r.optInt("bandwidth", 0)) r = a;
        return r;
    }

    static List<String> urlsOf(JSONObject s) {
        List<String> out = new ArrayList<>();
        if (s == null) return out;
        if (!s.isNull("baseUrl")) out.add(s.optString("baseUrl"));
        if (!s.isNull("base_url")) { String u = s.optString("base_url"); if (!out.contains(u)) out.add(u); }
        JSONArray bu = s.optJSONArray("backupUrl");
        if (bu != null) for (int i = 0; i < bu.length(); i++) {
            String u = bu.optString(i);
            if (!out.contains(u)) out.add(u);
        }
        return out;
    }

    static String boundedRange(String rng) {
        if (rng == null) return "bytes=0-" + (RANGE_CAP - 1);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes=(\\d+)-(\\d*)").matcher(rng.trim());
        if (!m.find()) return "bytes=0-" + (RANGE_CAP - 1);
        long start = Long.parseLong(m.group(1));
        long end = m.group(2).isEmpty() ? start + RANGE_CAP - 1 : Long.parseLong(m.group(2));
        end = Math.min(end, start + RANGE_CAP - 1);
        return "bytes=" + start + "-" + end;
    }

    // ---------------------------------------------------------------- 解析视频
    static JSONObject resolve(String raw, int page, int qn, String cookieUser) throws Exception {
        String[] t = parseTarget(raw);
        String bvid = t[0];
        int bvidPage = Integer.parseInt(t[1]);
        if (page <= 1) page = bvidPage;

        String viewUrl = bvid.toLowerCase().startsWith("av")
                ? "https://api.bilibili.com/x/web-interface/view?aid=" + bvid.substring(2)
                : "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid;
        JSONObject view = new JSONObject(httpGetString(viewUrl, apiHeaders(null)));
        if (view.optInt("code") != 0)
            throw new RuntimeException("取视频信息失败：" + view.optString("message"));
        JSONObject v = view.getJSONObject("data");

        JSONArray pages = v.optJSONArray("pages");
        if (page < 1) page = 1;
        if (pages != null && pages.length() > 0) page = Math.min(page, pages.length());
        long cid;
        String part = "";
        if (pages != null && pages.length() > 0) {
            JSONObject pg = pages.getJSONObject(page - 1);
            cid = pg.getLong("cid");
            part = pg.optString("part");
        } else cid = v.getLong("cid");

        String buvid = buvidCookie();
        String cookie = (buvid + " " + (cookieUser == null ? "" : cookieUser.trim())).trim();
        lastCookie = cookie;

        Map<String, String> q = new LinkedHashMap<>();
        q.put("bvid", v.getString("bvid"));
        q.put("cid", String.valueOf(cid));
        q.put("qn", String.valueOf(qn));
        q.put("fnver", "0");
        q.put("fnval", "4048");
        q.put("fourk", "1");
        String signed = wbiSign(q);

        JSONObject pu = new JSONObject(httpGetString(
                "https://api.bilibili.com/x/player/wbi/playurl?" + signed, apiHeaders(cookie)));
        if (pu.optInt("code") != 0)
            throw new RuntimeException("取播放地址失败：" + pu.optString("message"));
        JSONObject data = pu.getJSONObject("data");
        JSONObject dash = data.optJSONObject("dash");
        if (dash == null) throw new RuntimeException("该视频未返回 DASH 流（可能是番剧/直播/付费内容）");

        JSONObject vs = pickStream(dash.optJSONArray("video"), qn);
        JSONObject as = pickAudio(dash.optJSONArray("audio"));
        if (vs == null) throw new RuntimeException("没有可用的视频流");

        String token = UUID.randomUUID().toString().replace("-", "");
        MediaEntry me = new MediaEntry();
        me.v = urlsOf(vs);
        me.a = (as != null) ? urlsOf(as) : new ArrayList<>();
        MEDIA.put(token, me);
        long now = System.currentTimeMillis();
        for (Iterator<Map.Entry<String, MediaEntry>> it = MEDIA.entrySet().iterator(); it.hasNext(); ) {
            if (now - it.next().getValue().ts > 7200_000) it.remove();
        }

        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("token", token);
        out.put("bvid", v.optString("bvid"));
        out.put("aid", v.optLong("aid"));
        out.put("cid", cid);
        out.put("title", v.optString("title"));
        out.put("owner", v.optJSONObject("owner") == null ? "" : v.optJSONObject("owner").optString("name", ""));
        out.put("pic", v.optString("pic"));
        out.put("duration", dash.optDouble("duration", v.optDouble("duration", 0)));
        out.put("page", page);
        JSONArray pa = new JSONArray();
        if (pages != null) for (int i = 0; i < pages.length(); i++) {
            JSONObject p = pages.getJSONObject(i);
            JSONObject o = new JSONObject();
            o.put("index", p.optInt("page"));
            o.put("cid", p.optLong("cid"));
            o.put("part", p.optString("part"));
            pa.put(o);
        }
        out.put("pages", pa);
        out.put("quality", vs.optInt("id"));
        out.put("qualityName", QUALITY_NAME.getOrDefault(vs.optInt("id"), String.valueOf(vs.optInt("id"))));
        JSONArray ql = new JSONArray();
        JSONArray aq = data.optJSONArray("accept_quality");
        if (aq != null) for (int i = 0; i < aq.length(); i++) {
            int qq = aq.optInt(i);
            JSONObject o = new JSONObject();
            o.put("qn", qq);
            o.put("name", QUALITY_NAME.getOrDefault(qq, String.valueOf(qq)));
            ql.put(o);
        }
        out.put("qualityList", ql);
        JSONObject vid = new JSONObject();
        vid.put("id", vs.optInt("id"));
        vid.put("codecs", vs.optString("codecs"));
        vid.put("width", vs.optInt("width"));
        vid.put("height", vs.optInt("height"));
        vid.put("bandwidth", vs.optInt("bandwidth"));
        out.put("video", vid);
        JSONObject aud = new JSONObject();
        aud.put("id", as != null ? as.optInt("id") : 0);
        aud.put("bandwidth", as != null ? as.optInt("bandwidth") : 0);
        out.put("audio", aud);
        out.put("loggedIn", cookieUser != null && cookieUser.matches(".*SESSDATA=[^;]+.*"));
        return out;
    }

    // ---------------------------------------------------------------- 媒体代理
    static MediaResult openMedia(String token, String kind, int idx, String range) {
        MediaResult res = new MediaResult();
        MediaEntry me = MEDIA.get(token);
        if (me == null) { res.status = 404; return res; }
        List<String> urls = "v".equals(kind) ? me.v : me.a;
        if (urls == null || urls.isEmpty()) { res.status = 404; return res; }
        List<String> rotated = new ArrayList<>(urls.subList(Math.min(idx, urls.size() - 1), urls.size()));
        rotated.addAll(urls.subList(0, Math.min(idx, urls.size() - 1)));
        if (idx >= urls.size()) rotated = new ArrayList<>(urls);

        String upRange = boundedRange(range);
        for (String url : rotated) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("GET");
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Referer", "https://www.bilibili.com/");
                c.setRequestProperty("Origin", "https://www.bilibili.com");
                c.setRequestProperty("Accept", "*/*");
                c.setRequestProperty("Accept-Encoding", "identity");
                if (lastCookie != null && !lastCookie.isEmpty()) c.setRequestProperty("Cookie", lastCookie);
                c.setRequestProperty("Range", upRange);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                int st = c.getResponseCode();
                if (st == 200 || st == 206) {
                    res.status = st;
                    res.stream = c.getInputStream();
                    res.contentType = c.getContentType();
                    res.contentRange = c.getHeaderField("Content-Range");
                    res.contentLength = c.getContentLength();
                    res.acceptRanges = c.getHeaderField("Accept-Ranges");
                    res.etag = c.getHeaderField("ETag");
                    return res;
                }
                c.disconnect();
            } catch (Exception ex) {
                Log.w(TAG, "media upstream failed: " + ex.getMessage());
            }
        }
        res.status = 502;
        return res;
    }
}
