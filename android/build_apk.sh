#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
ANDROID_SDK="C:/Users/volcano/AppData/Local/Android/Sdk"
BT="$ANDROID_SDK/build-tools/37.0.0"
PLAT="$ANDROID_SDK/platforms/android-34"
JBR="C:/Program Files/Android/Android Studio/jbr"
AAPT2="$BT/aapt2.exe"
ZIPALIGN="$BT/zipalign.exe"
D8="$BT/lib/d8.jar"
APKSIGNER="$BT/lib/apksigner.jar"
JAVAC="$JBR/bin/javac.exe"
JAVA="$JBR/bin/java.exe"
KEYTOOL="$JBR/bin/keytool.exe"
PY="C:/Users/volcano/.workbuddy/binaries/python/versions/3.13.12/python.exe"

APP="$ROOT/app/src/main"
BUILD="$ROOT/build"
WWW="$APP/assets/www"
SRC="$APP/java/com/hplayer"
STATIC="$ROOT/../static"

mkdir -p "$BUILD/gen" "$BUILD/apk" "$BUILD/classes" "$BUILD/gen_R" "$BUILD/dex" "$WWW"
rm -rf "$BUILD/dex"
mkdir -p "$BUILD/dex"
rm -f "$BUILD/apk/base.apk" "$BUILD/apk/unsigned.apk" "$BUILD/apk/aligned.apk" "$ROOT/bili-highlight.apk" "$ROOT/H-Player.apk"

echo "[1/8] 复制前端静态文件"
cp -f "$STATIC/index.html" "$WWW/index.html"
cp -f "$STATIC/app.js"    "$WWW/app.js"
cp -f "$STATIC/style.css" "$WWW/style.css"

echo "[2/8] aapt2 compile 资源"
"$AAPT2" compile --dir "$APP/res" -o "$BUILD/gen/res.zip"

echo "[3/8] aapt2 link 资源 + 生成 R.java"
"$AAPT2" link -o "$BUILD/apk/base.apk" -I "$PLAT/android.jar" \
  --manifest "$APP/AndroidManifest.xml" "$BUILD/gen/res.zip" \
  --java "$BUILD/gen_R" --no-version-vectors

echo "[4/8] javac 编译"
"$JAVAC" -encoding UTF-8 -source 1.8 -target 1.8 -cp "$PLAT/android.jar" -d "$BUILD/classes" \
  "$SRC"/*.java "$BUILD/gen_R/com/hplayer/R.java"

echo "[5/8] d8 生成 classes.dex"
"$JBR/bin/jar.exe" cf "$BUILD/classes.jar" -C "$BUILD/classes" .
"$JAVA" -cp "$BT/lib/*" com.android.tools.r8.D8 --release --min-api 24 --output "$BUILD/dex" "$BUILD/classes.jar"

echo "[6/8] 注入 dex + assets"
"$PY" "$ROOT/make_apk.py" "$BUILD/apk/base.apk" "$BUILD/dex" "$APP/assets" "$BUILD/apk/unsigned.apk"

echo "[7/8] zipalign 对齐"
"$ZIPALIGN" -p 4 "$BUILD/apk/unsigned.apk" "$BUILD/apk/aligned.apk"

echo "[8/8] apksigner 签名"
if [ ! -f "$ROOT/keystore.jks" ]; then
  "$KEYTOOL" -genkeypair -v -keystore "$ROOT/keystore.jks" -alias bilihl \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass bilihl123 -keypass bilihl123 \
    -dname "CN=BiliHl, OU=Dev, O=BiliHl, L=CN, S=CN, C=CN"
fi
"$JAVA" -cp "$BT/lib/*" com.android.apksigner.ApkSignerTool sign --ks "$ROOT/keystore.jks" --ks-key-alias bilihl \
  --ks-pass pass:bilihl123 --key-pass pass:bilihl123 \
  --out "$ROOT/H-Player.apk" "$BUILD/apk/aligned.apk"

echo
echo "========== BUILD OK =========="
echo "APK: $ROOT/H-Player.apk"
