@echo off
setlocal
set "ROOT=%~dp0"
set "ANDROID_SDK=C:\Users\volcano\AppData\Local\Android\Sdk"
set "BT=%ANDROID_SDK%\build-tools\37.0.0"
set "PLAT=%ANDROID_SDK%\platforms\android-34"
set "JBR=C:\Program Files\Android\Android Studio\jbr"
set "PY=C:\Users\volcano\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "PATH=%JBR%\bin;%BT%;%PATH%"

set "APP=%ROOT%app\src\main"
set "BUILD=%ROOT%build"
set "WWW=%APP%\assets\www"
set "SRC=%APP%\java\com\bilihl"
set "STATIC=%ROOT%..\static"

if not exist "%BUILD%" mkdir "%BUILD%"
if not exist "%BUILD%\gen" mkdir "%BUILD%\gen"
if not exist "%BUILD%\apk" mkdir "%BUILD%\apk"
if not exist "%BUILD%\classes" mkdir "%BUILD%\classes"
if not exist "%BUILD%\gen_R" mkdir "%BUILD%\gen_R"
if not exist "%WWW%" mkdir "%WWW%"

echo [1/8] 复制前端静态文件
copy /Y "%STATIC%\index.html" "%WWW%\index.html" >nul
copy /Y "%STATIC%\app.js"    "%WWW%\app.js"    >nul
copy /Y "%STATIC%\style.css" "%WWW%\style.css" >nul

echo [2/8] aapt2 compile 资源
aapt2 compile --dir "%APP%\res" -o "%BUILD%\gen\res.zip" || goto :err

echo [3/8] aapt2 link 资源 + 生成 R.java
aapt2 link -o "%BUILD%\apk\base.apk" -I "%PLAT%\android.jar" ^
  --manifest "%APP%\AndroidManifest.xml" -R "%BUILD%\gen\res.zip" ^
  --java "%BUILD%\gen_R" --no-version-vectors || goto :err

echo [4/8] javac 编译
javac -source 1.8 -target 1.8 -cp "%PLAT%\android.jar" -d "%BUILD%\classes" ^
  "%SRC%\*.java" "%BUILD%\gen_R\com\bilihl\R.java" || goto :err

echo [5/8] d8 生成 classes.dex
d8 --release --min-api 24 --output "%BUILD%\classes.dex" "%BUILD%\classes" || goto :err

echo [6/8] 注入 dex + assets
"%PY%" "%ROOT%make_apk.py" "%BUILD%\apk\base.apk" "%BUILD%\classes.dex" "%APP%\assets" "%BUILD%\apk\unsigned.apk" || goto :err

echo [7/8] zipalign 对齐
zipalign -p 4 "%BUILD%\apk\unsigned.apk" "%BUILD%\apk\aligned.apk" || goto :err

echo [8/8] apksigner 签名
if not exist "%ROOT%keystore.jks" (
  keytool -genkeypair -v -keystore "%ROOT%keystore.jks" -alias bilihl ^
    -keyalg RSA -keysize 2048 -validity 10000 ^
    -storepass bilihl123 -keypass bilihl123 ^
    -dname "CN=BiliHl, OU=Dev, O=BiliHl, L=CN, S=CN, C=CN"
)
apksigner sign --ks "%ROOT%keystore.jks" --ks-key-alias bilihl ^
  --ks-pass pass:bilihl123 --key-pass pass:bilihl123 ^
  --out "%ROOT%bili-highlight.apk" "%BUILD%\apk\aligned.apk" || goto :err

echo.
echo ========== BUILD OK ==========
echo APK: %ROOT%bili-highlight.apk
goto :eof

:err
echo.
echo ========== BUILD FAILED ==========
exit /b 1
