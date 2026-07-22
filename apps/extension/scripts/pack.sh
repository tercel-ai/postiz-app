#!/usr/bin/env bash
#
# Build a shareable "Load unpacked" zip of the extension for coworkers.
#
# Pick a target with a PROFILE — local | dev | prod — so the whole URL set
# (FRONTEND_URL / NEXT_PUBLIC_BACKEND_URL / AUTH_URL / LOGIN_URL) moves together
# and login agrees with the scan/metrics executor's backend. Profiles live in
# scripts/env/<profile>.env (committed, no secrets).
#
#   local     → this machine's LAN stack (192.168.110.98:*)
#   dev       → *-dev.aisee.live
#   dev-local → *-dev.aisee.live API/auth, frontend at http://localhost:3000
#   prod      → *.aisee.live (store release: prod-only host_permissions + strip debug)
#
# Pick a browser with --browser=chrome|firefox (default: chrome). Chrome is
# built from vite.config.chrome.ts → dist/; Firefox from vite.config.firefox.ts
# → dist_firefox/ (Firefox's MV3 background needs `scripts`, not
# `service_worker` — that's handled in vite.config.firefox.ts already).
#
# Usage:
#   bash scripts/pack.sh dev                       # build against the dev stack (Chrome)
#   bash scripts/pack.sh local --strip-debug        # LAN stack, drop console.debug
#   bash scripts/pack.sh prod                       # store release
#   bash scripts/pack.sh dev --browser=firefox       # Firefox build against the dev stack
#   bash scripts/pack.sh /path/to/.env              # explicit env file (back-compat)
#   bash scripts/pack.sh                             # falls back to ../../.env (warns)
#
# By default the pack build KEEPS console.debug so coworkers can watch the
# scan-ingest / metrics flows in the extension devtools. Pass --strip-debug to
# ship a clean build with those calls removed. The `prod` profile always strips.
#
# Chrome: the coworker unzips → chrome://extensions → enable Developer mode →
# "Load unpacked" → select the unzipped folder (or drag the zip straight in).
#
# Firefox: the coworker unzips → about:debugging#/runtime/this-firefox →
# "Load Temporary Add-on…" → select manifest.json inside the unzipped folder.
# This is a TEMPORARY install (cleared on Firefox restart).
#
# For permanent installation (works across Firefox restarts), use --sign:
#   bash scripts/pack.sh prod --browser=firefox --sign
# This requires FIREFOX_JWT_USER and FIREFOX_JWT_SECRET in the env file, which
# are the Mozilla AMO API key/secret. It produces a signed .xpi that can be
# installed on any Firefox via drag-and-drop or about:addons → Install Add-on.

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/extension

# Parse args in any order: a positional = profile name OR an env-file path;
# --strip-debug = toggle; --browser=chrome|firefox (or --chrome/--firefox) picks the target.
ENV_ARG=""
STRIP_DEBUG="false"
BROWSER="chrome"
SIGN="false"
for arg in "$@"; do
  case "$arg" in
    --strip-debug)    STRIP_DEBUG="true" ;;
    --no-strip-debug) STRIP_DEBUG="false" ;;
    --browser=*)      BROWSER="${arg#--browser=}" ;;
    --firefox)        BROWSER="firefox" ;;
    --chrome)         BROWSER="chrome" ;;
    --sign)           SIGN="true" ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "✗ unknown option: $arg" >&2
      exit 1 ;;
    *)                ENV_ARG="$arg" ;;
  esac
done

case "$BROWSER" in
  chrome|firefox) ;;
  *)
    echo "✗ unknown --browser: $BROWSER (expected chrome or firefox)" >&2
    exit 1 ;;
esac

VITE_CONFIG="vite.config.${BROWSER}.ts"
if [ "$BROWSER" = "firefox" ]; then
  BUILD_DIR="dist_firefox"
else
  BUILD_DIR="dist"
fi

# Resolve the env file: a known profile name maps to scripts/env/<name>.env;
# anything else is treated as a literal path; empty falls back to repo-root .env.
case "$ENV_ARG" in
  local|dev|dev-local|prod)
    ENV_FILE="scripts/env/${ENV_ARG}.env" ;;
  "")
    ENV_FILE="../../.env"
    echo "⚠ no profile given — falling back to $ENV_FILE (this machine's env, likely LOCAL)." >&2
    echo "  Prefer: pack-ext:local | pack-ext:dev | pack-ext:prod" >&2 ;;
  *)
    ENV_FILE="$ENV_ARG" ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ env file not found: $ENV_FILE" >&2
  exit 1
fi

FRONTEND="$(grep -E '^FRONTEND_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
# Backend API base — the executor (scan/metrics loops) fetches here. Must be the
# api-post* host paired with FRONTEND_URL's app* host, NOT the frontend itself.
BACKEND="$(grep -E '^NEXT_PUBLIC_BACKEND_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"

echo "▶ building extension with env: $ENV_FILE"
echo "  browser                  = $BROWSER"
echo "  FRONTEND_URL            = ${FRONTEND:-(unset)}"
echo "  NEXT_PUBLIC_BACKEND_URL = ${BACKEND:-(unset)}"
echo "  strip console.debug = $STRIP_DEBUG"
if [ -z "$BACKEND" ]; then
  echo "  ⚠ NEXT_PUBLIC_BACKEND_URL is unset — scan/metrics loops will fail to fetch" >&2
fi

rm -rf "$BUILD_DIR"
if [ "$STRIP_DEBUG" = "true" ]; then
  STRIP_DEBUG=1 npx dotenv -e "$ENV_FILE" -- vite build --config "$VITE_CONFIG"
else
  npx dotenv -e "$ENV_FILE" -- vite build --config "$VITE_CONFIG"
fi

VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="aisee-extension-v${VERSION}-${BROWSER}-${STAMP}.zip"
# Chrome's built-in ZipFileInstaller (chrome://extensions drag-drop, Developer
# mode on) unzips to a temp dir and expects manifest.json at the top level — a
# wrapping folder makes it fail with "Could not unzip extension for install".
rm -f "$OUT"
( cd "$BUILD_DIR" && zip -rqX "../$OUT" . )

echo ""
echo "✅ $(pwd)/$OUT"
echo ""

if [ "$BROWSER" = "firefox" ] && [ "$SIGN" = "true" ]; then
  FIREFOX_JWT_USER_VAL="$(grep -E '^FIREFOX_JWT_USER=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  FIREFOX_JWT_SECRET_VAL="$(grep -E '^FIREFOX_JWT_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"

  if [ -z "$FIREFOX_JWT_USER_VAL" ] || [ -z "$FIREFOX_JWT_SECRET_VAL" ]; then
    echo "✗ --sign requires FIREFOX_JWT_USER and FIREFOX_JWT_SECRET in $ENV_FILE" >&2
    exit 1
  fi

  echo "▶ signing Firefox extension with AMO (channel: unlisted)..."
  WEB_EXT_API_KEY="$FIREFOX_JWT_USER_VAL" WEB_EXT_API_SECRET="$FIREFOX_JWT_SECRET_VAL" npx web-ext sign --source-dir "$BUILD_DIR" --channel unlisted

  XPI_FILE="$(ls -t web-ext-artifacts/*.xpi 2>/dev/null | head -1)"
  if [ -n "$XPI_FILE" ]; then
    NAME="$(node -p "require('./package.json').name")"
    RENAMED_XPI="${NAME}-${VERSION}-firefox.xpi"
    mv "$XPI_FILE" "$RENAMED_XPI"
    echo ""
    echo "✅ Signed XPI: $(pwd)/$RENAMED_XPI"
    echo ""
    echo "📦 This .xpi can be permanently installed on any Firefox (no restart required)."
    echo "   Users can: drag it to Firefox, or use about:addons → Install Add-on From File..."
  else
    echo "⚠️  Signing completed but no .xpi file found in web-ext-artifacts/" >&2
  fi
fi

if [ "$BROWSER" = "firefox" ]; then
  echo "⚠️  只发这个 zip(里面是构建好的 $BUILD_DIR,manifest.json 在根目录)。别用"
  echo "    'npm pack' 的 tgz — 那是源码包,解压成 package/、manifest 没 version,装不了。"
  echo ""
  echo "发给同事,让他这样装(Firefox 不支持直接拖 zip,必须先解压):"
  echo "  1) 解压 $OUT"
  echo "  2) 打开 about:debugging#/runtime/this-firefox"
  echo "  3) 点击「Load Temporary Add-on…」,选择解压出的文件夹里的 manifest.json"
  echo "  4) 用 ${FRONTEND:-该前端地址} 登录后即可使用(需能访问对应后端)"
  echo ""
  echo "  注意:这是【临时安装】,Firefox 重启后会自动卸载。要永久安装,需要用"
  echo "  --sign 参数走 Mozilla AMO 签名流程生成 .xpi 文件。"
else
  echo "⚠️  只发这个 zip(里面是构建好的 $BUILD_DIR,manifest.json 在根目录)。别用"
  echo "    'npm pack' 的 tgz — 那是源码包,解压成 package/、manifest 没 version,装不了。"
  echo ""
  echo "发给同事,让他【免解压】直接装:"
  echo "  1) 打开 chrome://extensions,右上角开启「开发者模式」(必须先开)"
  echo "  2) 把 $OUT 直接拖到该页面 → Chrome 自动解包安装"
  echo "  3) 用 ${FRONTEND:-该前端地址} 登录后即可使用(需能访问对应后端)"
  echo ""
  echo "  (兜底:若某版本 Chrome 不支持拖 zip,则解压后用「加载已解压的扩展程序」选文件夹)"
fi
