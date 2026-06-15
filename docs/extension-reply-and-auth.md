# Browser Extension — Engage Reply + Auth (Notes & Caveats)

The Aisee browser extension posts Engage replies in the user's own browser
session (Option A: bypasses the blocked X API tier / missing Reddit key) and
backfills the resulting URL. It also supports standalone login (aisee_auth) and
single sign-on with the web frontends.

Code spans **three repos**:
- `postiz-app/apps/extension` — the extension itself.
- `postiz-app/apps/frontend` — original Postiz frontend (dev playground; postiz auth).
- `aisee-app` + `aisee-agent` — customer-facing frontends (aisee_auth).

---

## 1. Three frontends, two auth systems

| Frontend | Where | Port/Domain | Auth |
| --- | --- | --- | --- |
| Original Postiz | `postiz-app/apps/frontend` | `192.168.110.98:4200` | postiz's own (`/auth/login` + `auth` cookie) — dev playground, **not** customer-facing |
| aisee-app (main) | `../aisee-app` | `app(-dev).aisee.live/` | **aisee_auth** (localStorage `access_token` + httpOnly `refresh_token` cookie) |
| aisee-agent | `../aisee-agent` | local `:3001` (off the postiz backend's `:3000`); prod **`app(-dev).aisee.live/post`** | **aisee_auth** (same as aisee-app) |

⚠️ **Prod topology:** `app(-dev).aisee.live/` is **aisee-app** (the main app, owns
login); **aisee-agent is mounted by nginx under `/post`** (Next.js
`basePath: !isLocal ? NEXT_PUBLIC_BASE_PATH : ''`). So aisee-app and aisee-agent
share **one origin** in prod, split by path — which means they also **share
localStorage**. Consequence: in prod, aisee-agent (`/post`) **inherits aisee-app's
session**; it does NOT run its own cookie-SSO or self-logout.

So **aisee-agent's standalone login/logout sync is LOCAL-ONLY** (gated on
`NEXT_PUBLIC_ENV === 'local'`). aisee-agent is essentially "another postiz
frontend" run on `localhost:3001` for developing the engage UI — there it's a
separate origin and needs its own bootstrap/validate. In prod, only **aisee-app**
matters for the SSO described below; aisee-agent rides along via the shared origin.

The extension's **standalone login** authenticates against **aisee_auth**, and
the `refresh_token`-cookie SSO (section 2) is an aisee_auth feature shared with
aisee-app / aisee-agent (one shared `.aisee.live` refresh cookie).

`apps/frontend` is **also backed by aisee_auth**, but indirectly: its
`POST /auth/login` hits the **postiz backend**, which (when `SSO_AUTH_URL` is set)
proxies to aisee_auth via `sso.client.ts` and returns the aisee **access_token**
as the postiz `auth` cookie. So the `auth` cookie *is* an aisee access token —
that's why `auth` and the aisee `refresh_token` carry the same `sub`.

**SSO into apps/frontend (extension/aisee login → apps/frontend logged in):**
apps/frontend's login state is its postiz `auth` cookie. The extension logs into
aisee_auth directly and only ever holds the aisee access token + the shared
`refresh_token` cookie — it never sets `auth`. To bridge that, apps/frontend
**bootstraps** in its Next.js `middleware.ts`: when a request has a
`refresh_token` cookie but no `auth` cookie, it POSTs the backend
`/auth/token-refresh`, which calls the sso's **`GET /access-token`** (NON-rotating
— see below), lazily creates the local postiz user/org if missing (the extension
never created one), and returns a fresh access token; the middleware sets it as
the `auth` cookie and redirects once (`?_ssob` one-shot guard against a loop).

> ⚠️ **Non-rotating on purpose.** The `refresh_token` cookie is **shared** with the
> extension (same host-only cookie on this host). `POST /token-refresh` *rotates*
> (invalidates the old token), which would break whichever consumer didn't trigger
> it. So the bootstrap uses `GET /access-token`, which mints an access token
> WITHOUT touching the refresh_token. The extension keeps using `/token-refresh`
> (rotating) for its own 20-day keep-alive; the rotation updates the shared cookie
> in place, so the next apps/frontend bootstrap just reads the current one.

## 2. Single sign-on (login once → both)

Mechanism = the **shared httpOnly `refresh_token` cookie** on `.aisee.live` (or
`192.168.110.98` on LAN — cookies ignore port).

- **Website login → extension**: the extension popup bootstraps from the cookie
  (`getAuthUser` → silent refresh) on open.
- **Extension login → website**: each aisee frontend bootstraps on first screen
  (`authHttp.bootstrapFromCookie()` in `main-provider.tsx`, calls `GET
  /access-token`). Added to both aisee-app and aisee-agent.

ℹ️ `apps/frontend` participates too, but via its **middleware** rather than a
client-side bootstrap: no `auth` cookie + a `refresh_token` cookie → it calls the
backend `/auth/token-refresh` (sso `GET /access-token`, non-rotating) to mint the
`auth` cookie. See section 1.

**Auto-enter a login tab already open.** A tab sitting on a login screen won't
re-check auth on its own. So after an extension login the background
**reloads** any frontend tab whose path is a login path (`enterFrontendAuthTabs`,
matches `/auth`, `/sign-in`, `/sign-up`). On reload:
- `apps/frontend`: the middleware bootstrap runs **on `/auth` pages too** (the
  `/auth` exclusion was removed) → mints `auth` → into the app.
- `aisee-app` (and `aisee-agent` **in local dev only**): `main-provider`
  `bootstrapFromCookie()` resolves true and, if the path is `/sign-in`/`/sign-up`,
  does `window.location.replace('/')` → into the app. (aisee-agent gates this on
  `NEXT_PUBLIC_ENV === 'local'`; in prod it inherits aisee-app's shared session.)

**Logout everywhere (extension logout → websites logout).** The access token is a
stateless JWT and can't be revoked, so logging out can't rely on it expiring. On
extension logout the background revokes + removes the shared `refresh_token`, then
`logoutFrontendTabs()` removes the postiz `auth` cookie on every frontend origin
and **reloads all** frontend tabs. On reload:
- `apps/frontend`: middleware sees no `auth` + no `refresh_token` → login screen.
- `aisee-app` (and `aisee-agent` **in local dev only**): their session is in
  `localStorage` (the extension can't touch another origin's storage), so they
  **self-validate**: `main-provider` calls `authHttp.validateSessionOrLogout()`,
  which hits the sso `GET /access-token`; a **401** (refresh revoked) → clears
  localStorage → `/sign-in`. This also catches logout from another device / admin
  revoke. aisee-agent gates this on `NEXT_PUBLIC_ENV === 'local'`; in prod it
  shares aisee-app's origin/localStorage, so clearing there logs `/post` out too.

## 3. The protocol handshake must match on both sides

Frontend ↔ extension postMessage strings come from ONE source of truth:
`postiz-app/libraries/helpers/src/extension/brand.ts` (`EXTENSION_MESSAGE`).
The aisee frontends inline the same literals (separate repos) — keep them in sync:

- page → extension: `source: 'aisee'`, `action: 'aisee:engage-reply'`
- extension → page: `source: 'aisee-extension'`, `action: 'aisee:engage-reply-result'`

To rebrand, change `EXTENSION_BRAND` in `brand.ts` AND the inlined strings in
`aisee-agent/.../extension-reply.ts`.

## 4. `content_scripts.matches` must list every frontend origin

The bridge only runs where the manifest matches. Built in
`apps/extension/vite.config.base.ts`. Currently (dev): `localhost:3001`
(aisee-agent — `:3001` so it doesn't collide with the postiz backend on `:3000`),
`app-dev.aisee.live`, `app.aisee.live`, `192.168.110.98:4200`. **A new frontend
origin = add it here**, or the page can't talk to the extension. Note `:3000` in
the manifest stays the **backend** (`backendApiHosts`), not a frontend.

## 5. `backendBase` for the reply backfill MUST be absolute  ⚠️ main gotcha

The page passes `backendBase` (= `NEXT_PUBLIC_POST_API_URL`) in the postMessage;
the extension PATCHes `${backendBase}/engage/sent/{id}/reply-url` from the
background.

- prod = `https://api-post.aisee.live`, dev = `https://api-post-dev.aisee.live`
  → absolute, works.
- **If a local `.env` sets `NEXT_PUBLIC_POST_API_URL` to a relative/proxy path
  (e.g. `/api`), the extension backfill fails** — the background SW can't resolve
  relative URLs. For local testing point it at an absolute backend, or test on
  dev/prod.

## 6. Extension auth-base resolution

`apps/extension/src/utils/auth.service.ts`:
- **dev** builds probe `/health` in priority order **localhost:9001 → 192.168.110.98:9001
  → api-auth-dev → api-auth**, caching the first reachable (mirrors the website's
  local→LAN→dev order). Set `AUTH_URL` in `.env` to pin one and skip probing.
- **prod** (`build:prod`, `EXTENSION_ENV=production`) is fixed to
  `https://api-auth.aisee.live`, no probe (dev candidates are tree-shaken out).

### ⚠️ The auth base host MUST match the frontend host (cookie-jar gotcha)

`login` / `refresh` / `logout` all read & write the `refresh_token` cookie via
`chrome.cookies.get({ url: authBase })`, so the cookie lands on **the auth base's
host**. Cookies are scoped by **host, not port** — `localhost` and
`192.168.110.98` are *different* jars.

If auto-probe picks `localhost:9001` (it's first in the list) but your dev
frontend is `http://192.168.110.98:4200`, the extension's `refresh_token` is set
on `localhost` while the frontend reads it on `192.168.110.98` → **SSO and the
backfill token silently break** (you'll see the extension POSTing
`localhost:9001/token-refresh` while the app is on `192.168.110.98`).

**Fix:** pin `AUTH_URL` in repo-root `.env` to the **same host** as
`FRONTEND_URL` / `NEXT_PUBLIC_BACKEND_URL`, then rebuild (`npm run pack-ext` /
`npm run dev` — `AUTH_URL` is a build-time `import.meta.env` value, baked at
build, NOT read at runtime):

```
FRONTEND_URL="http://192.168.110.98:4200"
NEXT_PUBLIC_BACKEND_URL="http://192.168.110.98:3000"
AUTH_URL="http://192.168.110.98:9001"   # same host → one cookie jar
```

(`build:prod` already pins everything to `*.aisee.live`, so prod is fine.)

### ⚠️ aisee_auth must not hardcode the cookie Domain (root cause)

Even with the auth base pinned to the right host, aisee_auth used to stamp the
`refresh_token` `Set-Cookie` with **`Domain=localhost`** (it derived the domain
from a hardcoded `FRONTEND_URL=localhost:3000`, not the request host). A browser
**rejects** a `Set-Cookie` whose `Domain` doesn't domain-match the response host,
so a client on `192.168.110.98:9001` never stored the cookie → the extension's
`chrome.cookies.get` found nothing → `/token-refresh` 401'd.

Fixed in `aisee-core/aisee_auth/service/oauth_service.py` `get_frontend_domain()`:
it now matches the **request** host against an allowlist `COOKIE_DOMAINS`
(settings, comma-separated; default `.aisee.live`). **`localhost`, `127.0.0.1`
and this machine's own IP(s) are auto-injected** (`_local_host_aliases`, detected
via `socket` once per process), so a dev box never hardcodes its LAN IP —
`COOKIE_DOMAINS` only needs the real domains.

- entry `.aisee.live` → set `Domain=.aisee.live` when the host equals / is a
  subdomain of it (prod cross-subdomain sharing intact);
- bare entry (`localhost` / an IP, incl. the auto-injected ones) → **host-only**
  cookie (no Domain) on exact match;
- no match → derive from host (localhost / bare IP → host-only, real domain →
  root domain).

So a client on `192.168.110.98:9001` gets a host-only `refresh_token` cookie the
browser actually stores. Restart aisee_auth after changing the code / env (also
re-detects the machine IP after a network change). (Cross-repo: `aisee-core`.)

## 7. Token handling (security)

- Login password is **SHA-1 hashed** before sending; never stored.
- `access_token` lives in `chrome.storage.session` (in memory, gone on browser
  close, not on disk). `refresh_token` stays an httpOnly cookie.
- Refresh is on-demand (near-expiry / 401) + a 20-day `chrome.alarms` keep-alive,
  with single-flight to avoid racing the refresh-token rotation. Logout revokes
  server-side, clears the cookie + token + alarm.
- Backfill token priority: page-passed `token` → extension's own login token →
  `auth` cookie.

## 8. Build & release

`apps/extension/`:
- `npm run pack-ext` — zip for coworkers to **Load unpacked** (LAN/dev hosts, from `.env`).
- `npm run build:prod` — Chrome Web Store zip (prod hosts only).
- `npm run dev` — watch.

Bump `version` in **both** `package.json` and `manifest.json` before any store
upload. See `apps/extension/RELEASE.md`. Recommended path: publish **Unlisted**
first (stable extension ID + auto-update), flip to Public later (same ID).

### Sharing with a coworker (Load unpacked)  ⚠️ use the `.zip`, NOT a `.tgz`

The deliverable is the **`.zip` produced by `npm run pack-ext`** — its contents are
the built `dist/` (manifest + compiled service-worker + assets), which is what
Chrome's "Load unpacked" needs.

```bash
cd apps/extension
npm run pack-ext                      # → aisee-extension-v<version>-<timestamp>.zip
```

Coworker steps:
1. Unzip → folder `aisee-extension-v<version>/`.
2. `chrome://extensions` → toggle **Developer mode** (top-right).
3. **Load unpacked** → pick the **folder** (not the zip).
4. Log in at the `FRONTEND_URL` the build targets (printed by `pack`) — they must
   reach that backend. `pack` defaults to the **LAN** backend
   (`192.168.110.98:4200`); off-LAN coworkers need an env pointed at a reachable
   backend (`bash scripts/pack.sh /path/to/other.env`) or the store build.

> ❌ Do **not** send the output of `npm pack` (`aisee-extension-<v>.tgz`). That is
> an npm-registry tarball — it contains `package/src/...` source with **no `dist/`
> build**, so Chrome cannot load it. `npm pack` is unrelated to `npm run pack-ext`.

## 9. Cross-repo verification

Changes here touch `aisee-app` and `aisee-agent` (separate Next.js projects not
built by this repo). After editing them, run their own `tsc` / build to verify.
