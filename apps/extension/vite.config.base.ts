import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { ManifestV3Export } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, BuildOptions } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { stripDevIcons, crxI18n } from './custom-vite-plugins';
import manifest from './manifest.json';
import devManifest from './manifest.dev.json';
import pkg from './package.json';
import { ProviderList } from './src/providers/provider.list';

const isDev = process.env.NODE_ENV === 'development';
// set this flag to true, if you want localization support
const localize = false;

const merge = isDev ? devManifest : ({} as ManifestV3Export);
const { matches, ...providerContentScript } =
  manifest?.content_scripts?.[0] || {};
const frontendUrl = import.meta.env?.FRONTEND_URL || process?.env?.FRONTEND_URL;
const frontendMatch = frontendUrl ? `${frontendUrl.replace(/\/$/, '')}/*` : undefined;
const providerMatches = ProviderList.map((p) => `${p.baseUrl}/*`);

// Production store build (EXTENSION_ENV=production, via `npm run build:prod`)
// ships ONLY production origins — no localhost / LAN / dev hosts, which would
// otherwise read as suspicious during Chrome Web Store review and serve no
// purpose in a released build.
const isProdRelease = process.env.EXTENSION_ENV === 'production';

// Strip `console.debug(...)` calls from the bundle. Always on for the store
// release; otherwise opt-in by setting STRIP_DEBUG at all (presence = on, e.g.
// `STRIP_DEBUG=1 vite build` or `pack.sh --strip-debug`). `esbuild.pure` marks
// the call side-effect-free so minification drops it, keeping log/warn/error.
const stripDebug = isProdRelease || !!process.env.STRIP_DEBUG;

// Hosts the background fetches directly (with the user's session cookies) to
// post in-browser replies. No content script runs on these — background only.
const replyHostPermissions = [
  'https://www.reddit.com/*',
  'https://*.reddit.com/*',
  // Reddit media uploads: /api/media/asset.json leases point the multipart
  // POST at Reddit's own S3 bucket (image posts in the publish queue).
  'https://reddit-uploaded-media.s3-accelerate.amazonaws.com/*',
];

// Backend API origins the background fetches to backfill the reply URL
// (token-authenticated). Background only — no content script.
const backendApiHosts = isProdRelease
  ? ['https://api-post.aisee.live/*']
  : [
      'http://localhost:3000/*',
      'http://192.168.110.98:3000/*',
      'https://api-post-dev.aisee.live/*',
      'https://api-post.aisee.live/*',
    ];

// aisee_auth origins the background calls for login / token-refresh / logout,
// and reads the refresh_token cookie from. Background only.
const authHosts = isProdRelease
  ? ['https://api-auth.aisee.live/*']
  : [
      'http://localhost:9001/*',
      'http://192.168.110.98:9001/*',
      'https://api-auth-dev.aisee.live/*',
      'https://api-auth.aisee.live/*',
    ];

// Frontend (web app) origins: the extension reads the `auth` cookie here AND
// runs the engage bridge content script here (so the page can postMessage to the
// extension). These need BOTH host_permissions and content_scripts.matches.
const postizAppHosts = isProdRelease
  ? ['https://app.aisee.live/*']
  : [
      'http://localhost:3001/*', // aisee-agent local dev (3001 to avoid the postiz backend on :3000)
      'https://app-dev.aisee.live/*',
      // app-dev2 shares the dev backend (api-post-dev / api-auth-dev) — it's just
      // a second frontend domain, so the same dev build serves both. Listing it
      // here grants the `auth` cookie read + engage/auth bridge content script on
      // app-dev2, which is all the extension needs there.
      'https://app-dev2.aisee.live/*',
      'https://app.aisee.live/*',
    ];

// dedupe — app.aisee.live can appear via both postizAppHosts and frontendMatch.
const uniq = (arr: (string | undefined)[]) =>
  Array.from(new Set(arr.filter((v): v is string => !!v)));

export const baseManifest = {
  ...manifest,
  host_permissions: uniq([
    ...providerMatches,
    ...replyHostPermissions,
    ...backendApiHosts,
    ...authHosts,
    ...postizAppHosts,
    frontendMatch,
  ]),
  permissions: [
    ...(manifest.permissions || []),
    'scripting',
    'alarms',
    'notifications',
  ],
  content_scripts: [
    {
      matches: uniq(providerMatches),
      ...providerContentScript,
    },
    {
      matches: uniq([...postizAppHosts, frontendMatch]),
      js: ['src/pages/content/bridge.ts'],
    },
    // MAIN-world, document_start interceptor on x.com: installs the fetch/XHR
    // capture (x-capture.ts) BEFORE X's own scripts run, so the page's own
    // UserTweets / SearchTimeline / TweetResultByRestId responses can be read.
    {
      matches: ['https://x.com/*', 'https://twitter.com/*'],
      js: ['src/pages/content/x-capture.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    } as any,
  ],
  version: pkg.version,
  ...merge,
  ...(localize
    ? {
        name: '__MSG_extName__',
        description: '__MSG_extDescription__',
        default_locale: 'en',
      }
    : {}),
} as ManifestV3Export;

export const baseBuildOptions: BuildOptions = {
  sourcemap: isDev,
  emptyOutDir: !isDev,
};

export default defineConfig({
  envPrefix: ['NEXT_PUBLIC_', 'FRONTEND_URL', 'AUTH_URL', 'EXTENSION_ENV', 'LOGIN_URL', 'ENGAGE_X_ENABLED', 'ENGAGE_LINKEDIN_ENABLED'],
  esbuild: stripDebug ? { pure: ['console.debug'] } : {},
  plugins: [
    tailwindcss(),
    tsconfigPaths(),
    react(),
    stripDevIcons(isDev),
    crxI18n({ localize, src: './src/locales' }),
  ],
  publicDir: resolve(__dirname, 'public'),
});
