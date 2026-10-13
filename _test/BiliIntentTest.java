import com.bilihl.MainActivity;

public class BiliIntentTest {
    static int pass = 0, fail = 0;

    static void eq(String input, String expect) {
        String got = MainActivity.extractTarget(input);
        boolean ok = (expect == null) ? got == null : expect.equals(got);
        System.out.println((ok ? "PASS" : "FAIL") + "  extractTarget(" + input + ") = " + got
                + (ok ? "" : "  (expect " + expect + ")"));
        if (ok) pass++; else fail++;
    }

    public static void main(String[] a) {
        // B站分享面板常见形态
        eq("https://b23.tv/abc1234", "b23tv:https://b23.tv/abc1234");
        eq("\u3010\u5b98\u65b9 MV\u3011Never Gonna Give You Up https://b23.tv/AbCdEf \u5206\u4eab\u81ea B\u7ad9", "b23tv:https://b23.tv/AbCdEf");
        eq("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.999.0.0", "BV1GJ411x7h7");
        eq("https://www.bilibili.com/video/BV1GJ411x7h7?p=2", "BV1GJ411x7h7");
        eq("BV1GJ411x7h7", "BV1GJ411x7h7");
        eq("av170001", "av170001");
        eq("https://m.bilibili.com/video/BV1GJ411x7h7", "BV1GJ411x7h7");
        eq("\u4eca\u5929\u5929\u6c14\u4e0d\u9519", null);
        eq("", null);
        // 短链解析后的回跳 URL（BV 号固定 BV+10 位）
        eq("https://www.bilibili.com/video/BV1GJ411x7h7/?share_source=copy_web", "BV1GJ411x7h7");
        eq("https://www.bilibili.com/video/BV1GJ411x7h7/?share_source=copy_web&share_medium=android", "BV1GJ411x7h7");
        System.out.println("----");
        System.out.println("PASS " + pass + " / " + (pass + fail));
        if (fail > 0) System.exit(1);
    }
}
