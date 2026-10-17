package com.hplayer;

public class BiliIntentTest {
    static int pass = 0, fail = 0;

    static void eq(String input, String expect) {
        String got = MainActivity.extractTarget(input);
        boolean ok = (expect == null) ? got == null : expect.equals(got);
        System.out.println((ok ? "PASS" : "FAIL") + "  extractTarget(" + input + ") = " + got
                + (ok ? "" : "  (expect " + expect + ")"));
        if (ok) pass++; else fail++;
    }

    static void eqJs(String input, String expect) {
        String got = MainActivity.jsQuote(input);
        boolean ok = expect.equals(got);
        System.out.println((ok ? "PASS" : "FAIL") + "  jsQuote(" + input + ") = " + got
                + (ok ? "" : "  (expect " + expect + ")"));
        if (ok) pass++; else fail++;
    }

    static void eqHtml(String input, boolean wantLink) {
        String got = MainActivity.stripHtml(input);
        boolean hasLink = got != null && MainActivity.extractTarget(got) != null;
        boolean ok = hasLink == wantLink;
        System.out.println((ok ? "PASS" : "FAIL") + "  stripHtml link=" + hasLink
                + " want=" + wantLink + "  [" + got + "]");
        if (ok) pass++; else fail++;
    }

    public static void main(String[] a) {
        // B 站分享面板常见形态
        eq("https://b23.tv/abc1234", "b23tv:https://b23.tv/abc1234");
        eq("【官方 MV】Never Gonna Give You Up https://b23.tv/AbCdEf 分享自 B站", "b23tv:https://b23.tv/AbCdEf");
        eq("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.999.0.0", "BV1GJ411x7h7");
        eq("https://www.bilibili.com/video/BV1GJ411x7h7?p=2", "BV1GJ411x7h7");
        eq("BV1GJ411x7h7", "BV1GJ411x7h7");
        eq("av170001", "av170001");
        eq("https://m.bilibili.com/video/BV1GJ411x7h7", "BV1GJ411x7h7");
        eq("今天天气不错", null);
        eq("", null);

        // 短链解析后的回跳 URL（BV 号固定 BV+10 位）
        eq("https://www.bilibili.com/video/BV1GJ411x7h7/?share_source=copy_web", "BV1GJ411x7h7");
        eq("https://www.bilibili.com/video/BV1GJ411x7h7/?share_source=copy_web&share_medium=android", "BV1GJ411x7h7");

        // 外屏分享实测形态：HTML 实体化的链接（href 里 & 变成 &amp; / &#38;）
        eq("<a href=\"https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&amp;vd_source=abc\">v</a>", "BV1GJ411x7h7");
        eq("<a href=\"https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&#38;vd_source=abc\">v</a>", "BV1GJ411x7h7");

        // 裸串 / 整段即 URL
        eq("b23.tv/AbCdEf", "b23tv:https://b23.tv/AbCdEf");
        // bilibili.com 链接统一归一为裸 BV 号（BiliApi.parseTarget 也认裸 ID，且能保留 p= 分 P）
        eq("https://www.bilibili.com/video/BV1GJ411x7h7", "BV1GJ411x7h7");

        // stripHtml：href 必须被保留（外屏分享最常见的失败原因）
        eqHtml("<a href=\"https://www.bilibili.com/video/BV1GJ411x7h7\">click</a>", true);
        eqHtml("<p>only title</p>", false);

        // jsQuote 转义
        eqJs("abc", "'abc'");
        eqJs("it's", "'it\\'s'");
        eqJs("a\nb", "'a\\nb'");
        eqJs("a\\b", "'a\\\\b'");
        eqJs(null, "''");

        System.out.println("----");
        System.out.println("PASS " + pass + " / " + (pass + fail));
        if (fail > 0) System.exit(1);
    }
}
