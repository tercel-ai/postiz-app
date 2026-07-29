import { resolve } from 'path';
import { mergeConfig, defineConfig } from 'vite';
import { crx, ManifestV3Export } from '@crxjs/vite-plugin';
import baseConfig, { baseManifest, baseBuildOptions } from './vite.config.base';
import { selfContainedContentScripts } from './custom-vite-plugins';
import hotReloadExtension from 'hot-reload-extension-vite';

const outDir = resolve(__dirname, 'dist');
const isDev = process.env.NODE_ENV === 'development';

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      crx({
        manifest: {
          ...baseManifest,
          background: {
            service_worker: 'src/pages/background/index.ts',
            type: 'module',
          },
          // Chrome-only: Firefox has a different, incompatible sidebar_action
          // API, so this stays out of baseManifest (shared with vite.config.firefox.ts).
          side_panel: {
            default_path: 'src/pages/panel/index.html',
          },
          permissions: [...(((baseManifest as any).permissions as string[] | undefined) || []), 'sidePanel'],
        } as ManifestV3Export,
        browser: 'chrome',
        contentScripts: {
          injectCss: true,
        },
      }),
      ...(isDev
        ? [
            hotReloadExtension({
              log: true,
              backgroundPath: 'src/pages/background/index.ts',
            }),
          ]
        : []),
      // Runs after crx() has written the manifest and assets: bundles each
      // content script self-contained and drops the web_accessible_resources
      // entries that only served its chunks (the extension-fingerprinting
      // surface). See the plugin docblock for why use_dynamic_url is not the
      // fix it looks like.
      selfContainedContentScripts(),
    ],
    build: {
      ...baseBuildOptions,
      outDir,
      ...(isDev
        ? {
            rollupOptions: {
              output: {
                entryFileNames: 'assets/[name].js',
                chunkFileNames: 'assets/[name].js',
                assetFileNames: 'assets/[name][extname]',
              },
            },
          }
        : {}),
    },
  })
);
