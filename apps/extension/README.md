# Postiz Browser Extension

A Chrome / Firefox (Manifest V3) extension that bridges the Postiz web app with
social networks you browse. It does two things:

1. **In-page composer** — injects a Postiz button overlay on supported sites
   (X / Twitter, LinkedIn) so you can open the Postiz scheduling modal directly
   from the post you are reading.
2. **Browser-assisted reply** — receives a reply task from the Postiz **Engage**
   module, opens the target tweet in a new tab, and pre-fills your drafted reply
   into X's native composer. This sidesteps the X API reply-tier block (see the
   Engage docs) by replying through your own logged-in browser session.

Built with Vite, React, TypeScript, Tailwind CSS and `@crxjs/vite-plugin`.

---

## How it works

### 1. In-page composer

`src/pages/content/main.content.tsx` runs on every page. It looks up a matching
provider in `src/providers/provider.list.ts` by hostname:

| Provider | Host | File |
| --- | --- | --- |
| X / Twitter | `x.com` | `src/providers/list/x.provider.ts` |
| LinkedIn | `linkedin.com` | `src/providers/list/linkedin.provider.ts` |

Each provider declares a CSS `element` selector for the spots where a Postiz
overlay should appear. A `MutationObserver` keeps the overlays in sync as the
SPA re-renders. Clicking an overlay opens an iframe pointed at
`${FRONTEND_URL}/modal/{style}/{platform}` — the Postiz modal — using your
Postiz `auth` cookie for authentication
(`src/pages/content/elements/action.component.tsx`).

### 2. In-browser Engage reply (closed loop)

The Engage reply panel hands a draft to the extension, which posts it through the
user's own browser session (bypassing the blocked X API tier / missing Reddit
key), captures the resulting permalink + author, and backfills them onto the
Engage record — no new backend table.

```
Engage reply panel                 Extension                          Platform
(reply-panel.tsx)                  (bridge → background)
─────────────────                  ─────────────────────              ────────
1. POST manual-reply (no URL)
   → sentReplyId
2. window.postMessage(             installEngageReplyBridge()  ──▶
   source: EXTENSION_MESSAGE.source,  forwards to background `postReply`
   action: …engageReply,
   {platform,url,text,             background posts in-browser   ──▶  Reddit / X
    sentReplyId,backendBase})        captures permalink + author
                                     PATCH /engage/sent/:id/reply-url
   ◀── postMessage result ────────   (permalink, backfilled, author)
```

- Protocol strings live ONCE in `libraries/helpers/src/extension/brand.ts`
  (`EXTENSION_MESSAGE`), imported by both the web app and the extension so the
  handshake can never drift — change `EXTENSION_BRAND` to rebrand.
- Reddit posts via background `fetch(credentials:'include')`; X opens a tab and
  uses `chrome.scripting.executeScript` (X's strict CSP blocks content scripts),
  auto-submits, and reads the new tweet from the captured `CreateTweet` response.
- The background reads the auth token (localStorage `access_token`, else the
  `auth` cookie) and PATCHes the reply URL itself, so the loop completes even if
  the Engage tab loses focus.

---

## Prerequisites

- Node.js + the workspace installed from the repo root (`npm install`).
- A `FRONTEND_URL` environment variable pointing at your Postiz frontend, e.g.
  `https://app.yourdomain.com` (or `http://localhost:4200` in development). It is
  read from the root `.env` and used to:
  - build the iframe / API base URL, and
  - generate `host_permissions` and the content-script match for your frontend
    origin (`vite.config.base.ts`).

> The dev script loads env from `../../.env`. Set `FRONTEND_URL` there before
> building, otherwise the frontend match and modal URL will be empty.

---

## Build

Run these from `apps/extension/`:

```bash
# Production build (Chrome) + zipped artifact -> dist/ and extension.zip
npm run build

# Chrome only (no zip)
npm run build:chrome

# Firefox build
npm run build:firefox
```

The output goes to `apps/extension/dist/`.

### Packaging for distribution (shareable zip)

`pack-ext` builds the extension and creates a zip that a colleague can drag-drop
straight into `chrome://extensions` (no manual unzip needed).

**Pick a profile** so the whole URL set (frontend + backend + auth + login) moves
together — login then agrees with the scan/metrics executor's backend. Profiles
live in `scripts/env/<profile>.env` (committed, no secrets):

```bash
pnpm pack-ext:local   # this machine's LAN stack (192.168.110.98:*)
pnpm pack-ext:dev     # *-dev.aisee.live
pnpm pack-ext:prod    # *.aisee.live (store release: prod-only hosts + strip debug)
```

| Profile | `FRONTEND_URL` | `NEXT_PUBLIC_BACKEND_URL` | `AUTH_URL` |
| --- | --- | --- | --- |
| `local` | `http://192.168.110.98:3001` | `http://192.168.110.98:3000` | `http://192.168.110.98:9001` |
| `dev` | `https://app-dev.aisee.live` | `https://api-post-dev.aisee.live` | `https://api-auth-dev.aisee.live` |
| `prod` | `https://app.aisee.live` | `https://api-post.aisee.live` | `https://api-auth.aisee.live` |

> ⚠️ The backend host is the executor's fetch base — it must be the `api-post*`
> host paired with the frontend, **not** the `app*` frontend itself.

Back-compat: `bash scripts/pack.sh /path/to/.env` still accepts an explicit env
file, and bare `pnpm pack-ext` (no profile) falls back to the repo-root `.env`
(this machine's env — it warns, since that is usually the LOCAL stack).

The `LOGIN_URL` in each profile is passed to Vite at build time
(`import.meta.env.LOGIN_URL`); if omitted it falls back to `FRONTEND_URL + '/sign-in'`.

**X scanning is OFF by default.** The X scan + metrics path uses the user's
personal x.com session (anti-automation risk — it has temp-limited real
accounts). The executor refuses all X work unless built with `ENGAGE_X_ENABLED=true`
(`flags.ts`). Reddit is unaffected. To opt in: `ENGAGE_X_ENABLED=true pnpm pack-ext:dev`
(and also allow X server-side via `ENGAGE_SUPPORTED_PLATFORMS`).

The output zip is named `aisee-extension-v{VERSION}-{TIMESTAMP}.zip` and sits
in `apps/extension/`.

By default the pack build **keeps `console.debug(...)`** so testers can watch the
scan-ingest / metrics flows in the extension devtools. Pass `--strip-debug` to
remove those calls (same stripping the store release gets):

```bash
bash scripts/pack.sh --strip-debug            # drop console.debug
bash scripts/pack.sh /path/.env --strip-debug # flags/path in any order
bash scripts/pack.sh --help                   # show usage
```

### Stripping `console.debug` from a build

`console.debug(...)` calls are removed from the bundle when `STRIP_DEBUG` is set
(presence = on — any value works) or `EXTENSION_ENV=production`. `console.log` /
`warn` / `error` are always kept. This is wired via `esbuild.pure` in
`vite.config.base.ts`, so it only takes effect on minified (non-dev) builds.

| Build | `console.debug` |
| --- | --- |
| `npm run build` / `build:chrome` / `dev:*` | kept |
| `pack-ext` (default) | kept |
| `pack-ext --strip-debug` | stripped |
| `STRIP_DEBUG=1 vite build …` | stripped |
| `npm run build:prod` (store release) | stripped |

### Development (hot reload)

```bash
# Watch + rebuild on change, Chrome (auto-reloads the loaded extension)
npm run dev:chrome

# Firefox
npm run dev:firefox
```

`dev:*` uses `nodemon` to rebuild and `hot-reload-extension-vite` to refresh the
extension in the browser. Dev builds use the icons/manifest from
`manifest.dev.json`.

---

## Load the extension in your browser

### Chrome / Edge / Brave

1. Build (`npm run build:chrome` or `npm run dev:chrome`).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select `apps/extension/dist/`.
5. Pin the **Postiz** icon if you want quick access to the popup.

### Firefox

1. Build (`npm run build:firefox`).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick any file inside
   `apps/extension/dist/` (e.g. the manifest).

After loading, the extension reloads automatically while `dev:*` is running.

---

## Permissions

Declared in `manifest.json` / `vite.config.base.ts`:

| Permission | Why |
| --- | --- |
| `cookies` | Read the Postiz `auth` cookie from `FRONTEND_URL` to authenticate the modal / API calls. |
| `storage` | Persist local reply history + the cached Reddit session. |
| `tabs` | Open the target tweet in a new tab. |
| `activeTab` | Inspect the active tab URL in the popup. |
| `host_permissions` | Provider hosts (`x.com`, `linkedin.com`) + your `FRONTEND_URL`. |

---

## Usage (end user)

### Sign in

Click the extension icon to open the popup. If you are not signed in, a
**Sign in** button is shown — click it to open the Aisee web app sign-in page
in a new tab. After you sign in there, the extension picks up the session
automatically (no need to enter credentials in the popup).

> Signing out of the web app also signs out the extension, and vice-versa.

### Open the Postiz scheduler from X / LinkedIn

1. Make sure you are logged in to your Postiz frontend in the same browser.
2. Browse X or LinkedIn — a clickable Postiz overlay appears on the
   compose / post areas.
3. Click it to open the Postiz modal inline and schedule a post.

### Assisted reply from Engage

1. In Postiz, open **Engage → Signal feed** and pick an X reply opportunity.
2. Generate or write your draft in the reply panel.
3. Click **Open with extension**. A new X tab opens with the tweet, the reply
   box opens, and your draft is filled in automatically.
4. Review the text, then click **Reply** on X to send. Nothing is posted
   without your click.

> If X doesn't open or the box isn't filled (X frequently changes its DOM), use
> **Open on X** / **Copy** in the reply panel and paste manually.

---

## Project layout

```
apps/extension/
├── manifest.json            # base MV3 manifest
├── manifest.dev.json        # dev overrides (icons)
├── vite.config.base.ts      # shared config, manifest assembly, env wiring
├── vite.config.chrome.ts    # Chrome build + hot reload
├── vite.config.firefox.ts   # Firefox build
└── src/
    ├── pages/
    │   ├── background/       # service worker: http, storage, cookies, openTab
    │   ├── content/          # injected UI + Engage reply bridge
    │   ├── popup/            # toolbar popup (login/provider status)
    │   ├── options/          # options page
    │   └── panel/            # devtools-style panel
    ├── providers/            # per-site selectors (x, linkedin)
    └── utils/                # storage, cookie, request helpers
```

## Tests

`src/utils/__tests__/reddit.poster.spec.ts` covers Reddit URL → thing-id parsing
and author/permalink extraction from the comment response. Run with
`npx vitest run` inside `apps/extension`.
