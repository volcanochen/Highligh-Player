# 单元测试

## 解析逻辑（BiliIntentTest）

覆盖 `MainActivity.extractTarget` / `stripHtml` / `jsQuote`：
分享文案提取、b23.tv 短链、bilibili 深链、HTML 实体化链接、JS 字符串转义。

测试类必须放在 `com/bilihl/` 包下（需访问包级私有方法）。

运行（从仓库根目录）：
```bash
export MSYS2_ARG_CONV_EXCL="*"
SDK="C:/Users/volcano/AppData/Local/Android/Sdk"
JBR="C:/Program Files/Android/Android Studio/jbr"
"$JBR/bin/javac.exe" -encoding UTF-8 -nowarn \
  -cp "$SDK/platforms/android-34/android.jar;android/build/classes" \
  -d _test/out _test/com/bilihl/BiliIntentTest.java
"$JBR/bin/java.exe" \
  -cp "$SDK/platforms/android-34/android.jar;android/build/classes;_test/out" \
  com.bilihl.BiliIntentTest
```
前置：先跑 `bash android/build_apk.sh` 生成 `android/build/classes`。
