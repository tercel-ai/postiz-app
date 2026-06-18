#!/usr/bin/env bash
#
# Build a shareable "Load unpacked" zip of the extension for coworkers.
#
# It builds with the env from the repo-root .env (FRONTEND_URL /
# NEXT_PUBLIC_BACKEND_URL), so the build points at whatever backend that .env
# configures (e.g. the LAN dev server at 192.168.110.98). Coworkers must be able
# to reach that backend, and log in to that same FRONTEND_URL origin.
#
# Usage:
#   bash scripts/pack.sh                       # uses ../../.env, keeps console.debug
#   bash scripts/pack.sh /path/to/.env         # uses a different env file
#   bash scripts/pack.sh --strip-debug         # drop console.debug from the build
#   bash scripts/pack.sh /path/.env --strip-debug
#
# By default the pack build KEEPS console.debug so coworkers can watch the
# scan-ingest / metrics flows in the extension devtools. Pass --strip-debug to
# ship a clean build with those calls removed (same stripping as build:prod).
#
# The coworker then: unzips → chrome://extensions → enable Developer mode →
# "Load unpacked" → select the unzipped folder.

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/extension

# Parse args in any order: a positional path = env file, --strip-debug = toggle.
ENV_FILE=""
STRIP_DEBUG="false"
for arg in "$@"; do
  case "$arg" in
    --strip-debug)    STRIP_DEBUG="true" ;;
    --no-strip-debug) STRIP_DEBUG="false" ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "✗ unknown option: $arg" >&2
      exit 1 ;;
    *)                ENV_FILE="$arg" ;;
  esac
done
ENV_FILE="${ENV_FILE:-../../.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ env file not found: $ENV_FILE" >&2
  exit 1
fi

FRONTEND="$(grep -E '^FRONTEND_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
# Backend API base — the executor (scan/metrics loops) fetches here. Must be the
# api-post* host paired with FRONTEND_URL's app* host, NOT the frontend itself.
BACKEND="$(grep -E '^NEXT_PUBLIC_BACKEND_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"

echo "▶ building extension with env: $ENV_FILE"
echo "  FRONTEND_URL            = ${FRONTEND:-(unset)}"
echo "  NEXT_PUBLIC_BACKEND_URL = ${BACKEND:-(unset)}"
echo "  strip console.debug = $STRIP_DEBUG"
if [ -z "$BACKEND" ]; then
  echo "  ⚠ NEXT_PUBLIC_BACKEND_URL is unset — scan/metrics loops will fail to fetch" >&2
fi

rm -rf dist
if [ "$STRIP_DEBUG" = "true" ]; then
  STRIP_DEBUG=1 npx dotenv -e "$ENV_FILE" -- vite build --config vite.config.chrome.ts
else
  npx dotenv -e "$ENV_FILE" -- vite build --config vite.config.chrome.ts
fi

VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="aisee-extension-v${VERSION}-${STAMP}.zip"

# Zip the CONTENTS of dist/ so manifest.json sits at the archive root. Chrome's
# built-in ZipFileInstaller (chrome://extensions drag-drop, Developer mode on)
# unzips to a temp dir and expects manifest.json at the top level — a wrapping
# folder makes it fail with "Could not unzip extension for install".
rm -f "$OUT"
( cd dist && zip -rqX "../$OUT" . )

echo ""
echo "✅ $(pwd)/$OUT"
echo ""
echo "⚠️  只发这个 zip(里面是构建好的 dist,manifest.json 在根目录)。别用"
echo "    'npm pack' 的 tgz — 那是源码包,解压成 package/、manifest 没 version,装不了。"
echo ""
echo "发给同事,让他【免解压】直接装:"
echo "  1) 打开 chrome://extensions,右上角开启「开发者模式」(必须先开)"
echo "  2) 把 $OUT 直接拖到该页面 → Chrome 自动解包安装"
echo "  3) 用 ${FRONTEND:-该前端地址} 登录后即可使用(需能访问对应后端)"
echo ""
echo "  (兜底:若某版本 Chrome 不支持拖 zip,则解压后用「加载已解压的扩展程序」选文件夹)"
