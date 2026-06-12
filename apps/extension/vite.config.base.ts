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
const { matches, ...rest } = manifest?.content_scripts?.[0] || {};
const frontendUrl = import.meta.env?.FRONTEND_URL || process?.env?.FRONTEND_URL;
const frontendMatch = frontendUrl ? `${frontendUrl.replace(/\/$/, '')}/*` : undefined;
const providerMatches = ProviderList.map((p) => `${p.baseUrl}/*`);

// Hosts the background fetches directly (with the user's session cookies) to
// post in-browser replies. No content script runs on these — background only.
const replyHostPermissions = [
  'https://www.reddit.com/*',
  'https://*.reddit.com/*',
];

// Postiz BACKEND API origins the background fetches to backfill the reply URL
// (token-authenticated, via the auth cookie). Background only — no content
// script. Covers local + LAN dev + the aisee dev/prod APIs.
const backendApiHosts = [
  'http://localhost:3000/*',
  'http://192.168.110.98:3000/*',
  'https://api-post-dev.aisee.live/*',
  'https://api-post.aisee.live/*',
];

// Postiz FRONTEND origins: the extension reads the `auth` cookie here AND runs
// the engage bridge content script here (so the page can postMessage to the
// extension). These need BOTH host_permissions and content_scripts.matches.
const postizAppHosts = [
  'https://app-dev.aisee.live/*',
  'https://app.aisee.live/*',
];

export const baseManifest = {
  ...manifest,
  host_permissions: [
    ...providerMatches,
    ...replyHostPermissions,
    ...backendApiHosts,
    ...postizAppHosts,
    ...(frontendMatch ? [frontendMatch] : []),
  ],
  permissions: [...(manifest.permissions || []), 'scripting'],
  content_scripts: [
    {
      matches: [
        ...providerMatches,
        ...postizAppHosts,
        ...(frontendMatch ? [frontendMatch] : []),
      ],
      ...rest,
    },
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
  envPrefix: ['NEXT_PUBLIC_', 'FRONTEND_URL'],
  plugins: [
    tailwindcss(),
    tsconfigPaths(),
    react(),
    stripDevIcons(isDev),
    crxI18n({ localize, src: './src/locales' }),
  ],
  publicDir: resolve(__dirname, 'public'),
});
