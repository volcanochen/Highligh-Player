@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY=C:\Users\volcano\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"
echo 正在启动 B 站集锦播放器...
"%PY%" server.py
pause
