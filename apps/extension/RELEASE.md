# Aisee Extension — Build, Share & Release

Three build flavours, picked by **which backend/hosts the build targets**.

| Command | Use for | Hosts baked in |
| --- | --- | --- |
| `npm run pack-ext` | **Share with coworkers** for `Load unpacked` (test the latest against the LAN/dev backend) | all (local + LAN + dev + prod) |
| `npm run dev` | Your own local dev (watch + auto-rebuild) | all |
| `npm run build:prod` | **Chrome Web Store** upload (Unlisted → Public) | **prod only** (`app.aisee.live`, `api-post.aisee.live`) |

The dev/LAN builds read `FRONTEND_URL` + `NEXT_PUBLIC_BACKEND_URL` from the repo-root
`.env`. `build:prod` hardcodes the production domains and sets `EXTENSION_ENV=production`,
which makes `vite.config.base.ts` drop all `localhost` / `192.168.*` / `*-dev` hosts (those
read as suspicious during store review and are useless in a release).

---

## A. Share a build with a coworker (Load unpacked)

```bash
cd apps/extension
npm run pack-ext                       # uses ../../.env (currently the LAN backend)
# or: bash scripts/pack.sh /path/to/other.env
```

Produces `aisee-extension-v<version>-<timestamp>.zip`. Send it; the coworker:

1. Unzips it → folder `aisee-extension-v<version>/`.
2. `chrome://extensions` → enable **Developer mode** (top-right).
3. **Load unpacked** → select the **folder** (not the zip).
4. Logs in at the `FRONTEND_URL` the build targets (printed by the script) — they must be
   able to reach that backend.

> Reloading after a new build: drop in the new folder and click the reload icon, or remove
> and re-add. There is no auto-update for unpacked installs.

Caveat: `npm run pack-ext` defaults to the **LAN** backend (`192.168.110.98`). Coworkers off the
LAN can't use it — point `.env` at a reachable backend first, or have them use the Unlisted
store build (Section B).

---

## B. Publish to the Chrome Web Store

### 1. Build the store package
```bash
cd apps/extension
npm run build:prod                 # → dist/ + extension.zip (prod hosts only)
```
Verify `dist/manifest.json` `host_permissions` contains ONLY: `x.com`, `reddit.com`,
`app.aisee.live`, `api-post.aisee.live` (and `linkedin.com` only if the disabled overlay is
still bundled — see note).

### 2. Upload
1. https://chrome.google.com/webstore/devconsole (one-time **$5** developer fee).
2. **New item** → upload `extension.zip`.
3. Store listing: name, description, 128×128 icon, screenshots (1280×800), category.
4. **Privacy policy URL** (required — uses `cookies` + host permissions) + data-use disclosures.
5. Justify each permission (`cookies`, `scripting`, `tabs`, host permissions).
6. **Visibility → Unlisted** (or **Private** for a Google Workspace org) → submit for review.

### 3. Internal → Public later
Flip **Visibility: Unlisted → Public** in the dev console + re-review. The extension **ID does
not change**, existing users keep auto-updating, and the website install link stays the same.

> ⚠️ Public review is stricter. The in-browser posting (Option A) may be flagged as
> "automating user accounts / bypassing platform APIs". If so, ship the public build more
> conservatively (e.g. X fills the draft but the user clicks Reply — `autoSubmit: false`).

---

## C. Website install button

Inline install was removed by Chrome in 2018 — link to the store page:

```html
<a href="https://chromewebstore.google.com/detail/<EXTENSION_ID>" target="_blank" rel="noopener">
  Add Aisee to Chrome
</a>
```

`<EXTENSION_ID>` is assigned by Google on first upload (stable across Unlisted/Public).
Optional "already installed?" detection: add `"externally_connectable": { "matches":
["https://app.aisee.live/*"] }` to the manifest and ping the extension with
`chrome.runtime.sendMessage(EXTENSION_ID, …)`.

---

## D. Versioning

Bump `version` in **both** `package.json` and `manifest.json` before every store upload — the
Web Store rejects a re-upload with an unchanged version. `pack.sh` does not need a bump (the
zip name is timestamped).

## Notes
- Rebrand: change `EXTENSION_BRAND` in `libraries/helpers/src/extension/brand.ts` (protocol
  strings + content-root id derive from it). The manifest `name` and `package.json` name are
  separate.
- `linkedin.com` host comes from the disabled in-page overlay provider. It has no active
  feature — consider removing the LinkedIn provider before a public submission to avoid an
  unexplained permission.
