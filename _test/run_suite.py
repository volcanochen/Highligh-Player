#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机自动化测试入口：跑完整套件 → 出 Markdown 报告 → 全绿才允许 push。

用法：
  python _test/run_suite.py                 # 全部设备 + 全部用例，出报告
  python _test/run_suite.py --device N6     # 只跑匹配关键字的设备
  python _test/run_suite.py --feature 解析  # 只跑某个特性
  python _test/run_suite.py --no-install    # 不重装 APK（复用已装的）
  python _test/run_suite.py --report-only   # 只重新生成报告（读上次 JSON）

退出码：
  0 = 全部 PASS（可push）
  1 = 有 FAIL（禁止 push）
  2 = 设备不可用 / 环境问题（同样禁止 push —— 不能因为「没测成」就放行）
"""
from __future__ import print_function

import argparse
import datetime
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import harness  # noqa: E402
import cases as case_mod  # noqa: E402

REPORT_DIR = os.path.join(harness.ROOT, "docs", "test-reports")
RESULT_JSON = os.path.join(HERE, "last_result.json")
BASE_PORT = 9922

# 已知设备的展示名（自动探测容易因为型号串不同而漏掉，所以显式标注）
FRIENDLY = {
    "PLP110": "N6 (OPPO 折叠屏)",
    "SM_N9500": "Note8 (三星)",
}


def stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def friendly(dev):
    label = FRIENDLY.get(dev.model, dev.model)
    bits = [label]
    if dev.android:
        bits.append("Android %s" % dev.android)
    if dev.api:
        bits.append("API %d" % dev.api)
    if dev.webview:
        bits.append(dev.webview)
    if dev.density:
        bits.append("%ddpi" % dev.density)
    if dev.size:
        bits.append(dev.size)
    return " · ".join(bits)


def run_device(dev, only_feature=None, install=True):
    print("\n" + "=" * 78)
    print("设备：%s" % friendly(dev))
    print("序列号：%s   CDP 端口：%d" % (dev.serial, dev.port))
    print("=" * 78)

    results = []
    try:
        dev.wake()
        if install:
            ok, out = dev.install()
            print("[安装] %s" % ("成功" if ok else "失败: " + out[:120]))
            if not ok:
                for feat, fn in case_mod.CASES:
                    if only_feature and feat != only_feature:
                        continue
                    cr = case_mod.CaseResult(fn.__name__, feat)
                    cr.fail("APK 安装失败：%s" % out[:100])
                    results.append(cr)
                return results
        else:
            print("[安装] 跳过（复用已安装版本）")

        dev.log.clear()
        dev.log.start()

        for feat, fn in case_mod.CASES:
            if only_feature and feat != only_feature:
                continue
            # 设备掉线（USB 调试断开）是环境故障，不能伪装成产品用例失败，
            # 否则报告会误导人去查代码。统一标成 BLOCKED 并说明原因。
            if not dev.check_online():
                cr = case_mod.CaseResult(fn.__name__, feat)
                cr.fail("设备掉线（adb 状态非 device），本用例未执行")
                results.append(cr)
                print("  ! %-4s %-28s  设备掉线，跳过" % (feat, fn.__name__[:28]))
                continue
            c = case_mod.CaseResult(fn.__name__, feat)
            t0 = time.time()
            try:
                got = fn(dev)
                if isinstance(got, case_mod.CaseResult):
                    # 用例自己构造的结果里带正式名称（比函数名可读）
                    c = got
                else:
                    c.ok("通过")
            except harness.CdpError as e:
                c = case_mod.CaseResult(fn.__name__, feat).fail("CDP 通信失败：%s" % e)
            except Exception as e:
                c = case_mod.CaseResult(fn.__name__, feat).fail(
                    "用例自身异常 %s: %s" % (type(e).__name__, e))
            c.seconds = time.time() - t0
            if c.status == harness.FAIL:
                c.logs = "\n".join(
                    [l for l in dev.log.grep(r"\[resolve\]|prepare-fail|\[cut\]|error|Error|FAIL")
                     ][-25:])
            results.append(c)
            mark = {harness.PASS: "✓", harness.FAIL: "✗", harness.SKIP: "-"}[c.status]
            print("  %s %-4s %-28s %5.1fs  %s" % (
                mark, feat, c.name[:28], c.seconds, c.detail[:60]))
    finally:
        dev.cleanup()
    return results


def summarize(results):
    p = sum(1 for r in results if r.status == harness.PASS)
    f = sum(1 for r in results if r.status == harness.FAIL)
    s = sum(1 for r in results if r.status == harness.SKIP)
    return p, f, s


def render_markdown(run_meta, device_results):
    """device_results: [(dev_label, [CaseResult,...])]"""
    ts = run_meta["started"]
    lines = []
    A = lines.append
    A("# 真机自动化测试报告")
    A("")
    A("- **生成时间**：%s" % ts)
    A("- **代码版本**：`%s`" % run_meta.get("commit", "unknown"))
    A("- **APK**：%s（%.1f KB）" % (os.path.basename(run_meta.get("apk", "")),
                                     run_meta.get("apk_kb", 0)))
    A("- **套件版本**：%s" % run_meta.get("suite", "1.0"))
    A("")

    total_pass = total_fail = total_skip = 0
    for label, results in device_results:
        p, f, s = summarize(results)
        total_pass += p
        total_fail += f
        total_skip += s

    verdict = "✅ 全部通过，可推送 GitHub" if total_fail == 0 else \
              "❌ 存在失败项，禁止推送（需修复后重跑）"
    A("## 结论")
    A("")
    A("**%s**" % verdict)
    A("")
    A("| 设备 | 用例 | 通过 | 失败 | 跳过 |")
    A("|---|---|---|---|---|")
    for label, results in device_results:
        p, f, s = summarize(results)
        A("| %s | %d | %d | %d | %d |" % (label, len(results), p, f, s))
    A("| **合计** | **%d** | **%d** | **%d** | **%d** |" % (
        sum(len(r) for _, r in device_results), total_pass, total_fail, total_skip))
    A("")

    A("## 设备矩阵")
    A("")
    A("覆盖两个差异极大的机型：Android 9 的旧 WebView 与 Android 16 的新 WebView，")
    A("外加折叠屏的屏幕形态切换——这三者是本项目最容易出问题的地方。")
    A("")
    for label, results in device_results:
        A("- **%s**" % label)
    A("")

    A("## 用例明细")
    A("")
    for label, results in device_results:
        A("### %s" % label)
        A("")
        A("| | 特性 | 用例 | 耗时 | 结果 | 说明 |")
        A("|---|---|---|---|---|---|")
        for r in results:
            mark = {harness.PASS: "✅", harness.FAIL: "❌", harness.SKIP: "⏭️"}[r.status]
            detail = (r.detail or "").replace("|", "\\|")[:120]
            A("| %s | %s | %s | %.1fs | %s | %s |" % (
                mark, r.feature, r.name, r.seconds, r.status, detail))
        A("")
        fails = [r for r in results if r.status == harness.FAIL]
        if fails:
            A("#### 失败详情")
            A("")
            for r in fails:
                A("**%s · %s**" % (r.feature, r.name))
                A("")
                A("- 原因：%s" % r.detail)
                if r.metrics:
                    A("- 指标：`%s`" % json.dumps(r.metrics, ensure_ascii=False)[:300])
                if r.logs:
                    A("- 相关日志：")
                    A("")
                    A("```")
                    A(r.logs[-1200:])
                    A("```")
                A("")
    A("")

    A("## 如何复现")
    A("")
    A("```bash")
    A("# 构建 + 全量真机测试（通过才允许 push）")
    A("bash scripts/verify.sh")
    A("")
    A("# 只跑某台设备 / 某个特性")
    A("python _test/run_suite.py --device N6 --feature 播放")
    A("```")
    A("")
    return "\n".join(lines)


def git_commit():
    rc, out = harness.sh(["git", "-C", harness.ROOT, "rev-parse", "--short", "HEAD"], timeout=30)
    return out.strip() if rc == 0 else "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default=None, help="只跑匹配该关键字的设备")
    ap.add_argument("--feature", default=None, help="只跑该特性")
    ap.add_argument("--no-install", action="store_true")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()

    if args.report_only:
        with open(RESULT_JSON, encoding="utf-8") as f:
            prev = json.load(f)
        return finish(prev)

    devs = harness.make_devices(base_port=BASE_PORT, only=args.device)
    # 掉线的设备先尝试重连一次（USB 调试断开时 adb 不会自动恢复）。
    if args.device and not devs:
        print("首次未发现设备，尝试刷新 adb 连接…")
        harness.sh([harness.adb_path(), "kill-server"], timeout=60)
        time.sleep(2)
        harness.sh([harness.adb_path(), "start-server"], timeout=90)
        time.sleep(4)
        devs = harness.make_devices(base_port=BASE_PORT, only=args.device)
    if not devs:
        print("!! 没有找到任何可用设备 —— 视为不通过（禁止 push）")
        sys.exit(2)

    print("发现 %d 台设备：%s" % (len(devs), ", ".join(d.model or d.serial for d in devs)))

    apk_kb = 0
    if os.path.exists(harness.APK):
        apk_kb = os.path.getsize(harness.APK) / 1024.0

    device_results = []
    started = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for dev in devs:
        results = run_device(dev, only_feature=args.feature, install=not args.no_install)
        device_results.append((friendly(dev), results))

    meta = {
        "started": started,
        "finished": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "commit": git_commit(),
        "apk": harness.APK,
        "apk_kb": round(apk_kb, 1),
        "suite": "1.0",
        "devices": [{"label": lbl,
                     "results": [{"name": r.name, "feature": r.feature, "status": r.status,
                                  "detail": r.detail, "seconds": round(r.seconds, 1),
                                  "metrics": r.metrics} for r in res]}
                    for lbl, res in device_results],
    }
    with open(RESULT_JSON, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    finish(meta)
    fails = sum(1 for _, res in device_results for r in res if r.status == harness.FAIL)
    sys.exit(1 if fails else 0)


def finish(meta):
    # 先把 JSON 里的结果还原成完整对象（含 status/耗时/指标），再渲染
    rebuilt = []
    for d in meta["devices"]:
        rs = []
        for r in d["results"]:
            c = harness.CaseResult(r["name"], r["feature"])
            c.status = r["status"]
            c.detail = r.get("detail", "")
            c.seconds = r.get("seconds", 0)
            c.metrics = r.get("metrics", {})
            rs.append(c)
        rebuilt.append((d["label"], rs))

    md = render_markdown(meta, rebuilt)

    if not os.path.isdir(REPORT_DIR):
        os.makedirs(REPORT_DIR)
    fname = "report-%s.md" % meta["started"].replace(":", "").replace(" ", "-")[:15]
    path = os.path.join(REPORT_DIR, fname)
    with open(path, "w", encoding="utf-8") as f:
        f.write(md)
    latest = os.path.join(REPORT_DIR, "latest.md")
    with open(latest, "w", encoding="utf-8") as f:
        f.write(md)

    tp = sum(1 for _, rs in rebuilt for r in rs if r.status == harness.PASS)
    tf = sum(1 for _, rs in rebuilt for r in rs if r.status == harness.FAIL)
    ts_ = sum(1 for _, rs in rebuilt for r in rs if r.status == harness.SKIP)
    print("\n" + "=" * 78)
    print("总计：通过 %d / 失败 %d / 跳过 %d" % (tp, tf, ts_))
    print("报告：%s" % path)
    print("=" * 78)
    if tf:
        print("结论：存在失败项 —— 禁止 push GitHub")
    else:
        print("结论：全部通过 —— 允许 push GitHub")


if __name__ == "__main__":
    main()