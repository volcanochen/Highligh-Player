#!/usr/bin/env bash
# ============================================================================
#  一键验收门禁：构建 → 双机真机测试 → 全绿才允许 push GitHub
#
#  为什么要有这个脚本：
#    之前两次「本地看过没问题就push」，都漏了真机上的真实故障——
#    一次是 Note8 根本没播出来（只验了「解析成功」），
#    一次是 N6 网络超时（凭想当然，没实测）。
#    人眼验证不可靠：折叠屏截不了屏、锁屏点不准、播放推进与否肉眼看不出。
#    所以把「每个特性都在两台真机上跑过」变成硬门禁，不绿就不给 push。
#
#  用法：
#    bash scripts/verify.sh              # 完整：构建 + 全量测试 + 出报告
#    bash scripts/verify.sh --push       # 测试通过后自动 commit & push
#    bash scripts/verify.sh --fast       # 跳过构建，用现有 APK
# ============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="C:/Users/volcano/.workbuddy/binaries/python/versions/3.13.12/python.exe"
[ -x "/c/Users/volcano/.workbuddy/binaries/python/versions/3.13.12/python.exe" ] || \
  PY="python3"

DO_PUSH=0
DO_BUILD=1
for a in "$@"; do
  case "$a" in
    --push) DO_PUSH=1 ;;
    --fast) DO_BUILD=0 ;;
  esac
done

hr() { printf '%s\n' "------------------------------------------------------------------------"; }

hr
echo "  H-Player · 验收门禁"
hr

# ---------------------------------------------------------------- 1. 构建
if [ "$DO_BUILD" = "1" ]; then
  echo "[1/3] 构建 APK"
  bash android/build_apk.sh || { echo "构建失败，门禁终止"; exit 1; }
else
  echo "[1/3] 跳过构建（--fast）"
fi

# ------------------------------------------------- 2. JVM 单元测试（纯逻辑）
echo
echo "[2/3] JVM 单元测试（链接/标题解析）"
SDK="C:/Users/volcano/AppData/Local/Android/Sdk"
JBR="C:/Program Files/Android/Android Studio/jbr"
UNIT_OK=1
if [ -f "_test/com/hplayer/BiliIntentTest.java" ]; then
  ( cd "$ROOT" \
    && MSYS2_ARG_CONV_EXCL="*" "$JBR/bin/javac.exe" -encoding UTF-8 -nowarn \
         -cp "$SDK/platforms/android-34/android.jar;android/build/classes" \
         -d _test/out _test/com/hplayer/BiliIntentTest.java \
    && "$JBR/bin/java.exe" \
         -cp "$SDK/platforms/android-34/android.jar;android/build/classes;_test/out" \
         com.hplayer.BiliIntentTest )
  if [ $? -ne 0 ]; then
    echo "!! 单元测试未通过"
    UNIT_OK=0
  fi
else
  echo "（未找到单元测试文件，跳过）"
fi

# ------------------------------------------------------ 3. 双机真机测试
echo
echo "[3/3] 真机自动化测试"
"$PY" _test/run_suite.py
SUITE_RC=$?

hr
if [ "$UNIT_OK" != "1" ] || [ "$SUITE_RC" != "0" ]; then
  echo "  验收未通过 —— 禁止 push GitHub"
  echo "  报告见docs/test-reports/latest.md"
  hr
  exit 1
fi

echo "  验收通过 —— 代码与测试报告可以推送"
hr

# ------------------------------------------------------------- 4. 可选推送
if [ "$DO_PUSH" = "1" ]; then
  echo
  echo "提交并推送测试报告…"
  git add -A docs/test-reports _test scripts android static || true
  if git diff --cached --quiet; then
    echo "  （无改动，跳过提交）"
  else
    git commit -q -m "test: 双机真机验收报告（$(date '+%Y-%m-%d %H:%M')）" || true
  fi
  git push origin HEAD || { echo "推送失败"; exit 1; }
  echo "  已推送"
fi

echo
echo "报告：docs/test-reports/latest.md"