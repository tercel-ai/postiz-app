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

### 2. Browser-assisted reply (Engage → X)

```
Engage reply panel                Extension content script           X.com tab
(reply-panel.tsx)                 (browser-assisted-reply.ts)
─────────────────                 ────────────────────────           ─────────
window.postMessage(               window 'message' listener
  source: 'postiz',        ──▶    validates task, saves it to
  action:                         chrome.storage, asks the
  'postiz:extension-task',        background worker to open tab  ──▶  new tab
  task: { platform:'x',                                               opens the
    type:'reply', ... })                                              tweet URL
                                  runner re-reads the pending
                                  task on the X tab, opens the   ──▶  reply box
                                  reply composer and fills the        pre-filled
                                  draft text
```

- The web app trigger lives in
  `apps/frontend/src/components/engage/signal-feed/reply-panel.tsx`
  (`openWithExtension`). It posts the message only for X reply opportunities.
- `installBrowserAssistedReplyBridge()` listens for that message, persists the
  task under `postiz:pending-browser-assisted-task`, and tells the background
  service worker (`src/pages/background/index.ts`) to open the tweet.
- `installXBrowserAssistedReplyRunner()` runs on `x.com` tabs, waits for the
  reply composer (`[data-testid="tweetTextarea_0"]`), fills the draft via
  `insertText`, then clears the stored task. **It does not auto-submit** — you
  review and click *Reply* yourself.

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
| `storage` | Persist the pending browser-assisted reply task. |
| `tabs` | Open the target tweet in a new tab. |
| `activeTab` | Inspect the active tab URL in the popup. |
| `host_permissions` | Provider hosts (`x.com`, `linkedin.com`) + your `FRONTEND_URL`. |

---

## Usage (end user)

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
    │   ├── content/          # injected UI + browser-assisted reply bridge
    │   ├── popup/            # toolbar popup (login/provider status)
    │   ├── options/          # options page
    │   └── panel/            # devtools-style panel
    ├── providers/            # per-site selectors (x, linkedin)
    └── utils/                # storage, cookie, request helpers
```

## Tests

`src/pages/content/__tests__/browser-assisted-reply.spec.ts` covers the task
validation, URL normalization, composer lookup and fill logic. Run the
repo test suite to execute it.
