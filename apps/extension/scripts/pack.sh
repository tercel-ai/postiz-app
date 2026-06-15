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
#   bash scripts/pack.sh                 # uses ../../.env
#   bash scripts/pack.sh /path/to/.env   # uses a different env file
#
# The coworker then: unzips → chrome://extensions → enable Developer mode →
# "Load unpacked" → select the unzipped folder.

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/extension

ENV_FILE="${1:-../../.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ env file not found: $ENV_FILE" >&2
  exit 1
fi

FRONTEND="$(grep -E '^FRONTEND_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"

echo "▶ building extension with env: $ENV_FILE"
echo "  FRONTEND_URL = ${FRONTEND:-(unset)}"

rm -rf dist
npx dotenv -e "$ENV_FILE" -- vite build --config vite.config.chrome.ts

VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date +%Y%m%d-%H%M)"
FOLDER="aisee-extension-v${VERSION}"
OUT="${FOLDER}-${STAMP}.zip"

# Zip a named copy of dist/ so the unzipped folder is clearly labelled (Load
# unpacked needs a folder, not the zip itself).
rm -rf "$FOLDER" "$OUT"
cp -r dist "$FOLDER"
zip -rq "$OUT" "$FOLDER"
rm -rf "$FOLDER"

echo ""
echo "✅ $(pwd)/$OUT"
echo ""
echo "⚠️  只发这个 zip(里面是构建好的 dist)。别用 'npm pack' 的 tgz —"
echo "    那是源码包,解压成 package/ 文件夹、manifest 没 version,装不了。"
echo ""
echo "发给同事,让他:"
echo "  1) 解压 $OUT(得到文件夹 $FOLDER)"
echo "  2) 打开 chrome://extensions,右上角开启「开发者模式」"
echo "  3) 点「加载已解压的扩展程序」,选 $FOLDER 文件夹"
echo "  4) 用 ${FRONTEND:-该前端地址} 登录后即可使用(需能访问对应后端)"
