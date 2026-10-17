#!/usr/bin/env python3
"""发布 H-Player 到 GitHub Releases。

- 从 git credential 动态获取 GitHub token（不在命令行 / 脚本里出现明文）
- 创建 release（tag/name/body 取自 docs/release-notes/<tag>.md）
- 上传 android/H-Player.apk 作为资产
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

REPO = "volcanochen/H-Player"
APK = "android/H-Player.apk"
TAG = "v1.0.0"
NAME = "H-Player v1.0.0"
NOTES = "docs/release-notes/v1.0.0.md"
API = "https://api.github.com"


def get_token():
    """复用 git 凭据助手拿 GitHub PAT，避免明文落盘。"""
    try:
        p = subprocess.run(
            ["git", "credential", "fill"],
            input=b"protocol=https\nhost=github.com\n",
            capture_output=True, timeout=30,
        )
        for line in p.stdout.decode("utf-8", "ignore").splitlines():
            if line.startswith("password="):
                return line[len("password="):].strip()
    except Exception as e:
        print("get_token failed:", e, file=sys.stderr)
    return os.environ.get("GH_TOKEN", "")


def call(method, url, data=None, extra=None, binary=False):
    token = get_token()
    if not token:
        sys.exit("ERROR: 拿不到 GitHub token（请确认 git credential 已配置 PAT）")
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "User-Agent": "H-Player-Release",
    }
    if extra:
        headers.update(extra)
    body = None
    if data is not None:
        if binary:
            body = data
            headers["Content-Type"] = "application/vnd.android.package-archive"
        else:
            body = data.encode("utf-8")
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read().decode("utf-8", "ignore")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.reason, file=sys.stderr)
        print(e.read().decode("utf-8", "ignore")[:800], file=sys.stderr)
        sys.exit(1)


def main():
    notes = open(NOTES, encoding="utf-8").read()
    payload = json.dumps({
        "tag_name": TAG,
        "name": NAME,
        "body": notes,
        "draft": False,
        "prerelease": False,
    })
    print("创建 release", TAG, "...")
    rel = call("POST", f"{API}/repos/{REPO}/releases", payload)
    rid = rel.get("id")
    upload_url = rel.get("upload_url", "").split("{")[0]
    html_url = rel.get("html_url")
    print("  release id:", rid)
    print("  upload_url:", upload_url)

    if not os.path.exists(APK):
        sys.exit("ERROR: 找不到 APK：" + APK)
    with open(APK, "rb") as f:
        blob = f.read()
    print("上传资产", APK, f"({len(blob)} bytes) ...")
    asset = call(
        "POST",
        upload_url + "?name=" + os.path.basename(APK),
        data=blob,
        binary=True,
    )
    print("  资产:", asset.get("name"), asset.get("size"), "bytes")

    print("DONE:", html_url)


if __name__ == "__main__":
    main()
