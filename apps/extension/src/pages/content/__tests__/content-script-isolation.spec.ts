import { describe, expect, it } from 'vitest';
import { baseManifest } from '../../../../vite.config.base';

describe('extension content script isolation', () => {
  it('keeps app bridges CSS-free while provider pages receive the UI stylesheet', () => {
    const contentScripts = (
      baseManifest as {
        content_scripts: Array<{
          matches: string[];
          js?: string[];
          css?: string[];
        }>;
      }
    ).content_scripts;

    const appScript = contentScripts.find((script) =>
      script.matches.includes('http://localhost:3001/*')
    );
    const providerScript = contentScripts.find((script) =>
      script.matches.includes('https://x.com/*')
    );

    expect(appScript).toMatchObject({
      js: ['src/pages/content/bridge.ts'],
    });
    expect(appScript?.css).toBeUndefined();
    expect(providerScript).toMatchObject({
      js: ['src/pages/content/index.tsx'],
      css: ['contentStyle.css'],
    });
    expect(
      appScript?.matches.some((match) => providerScript?.matches.includes(match))
    ).toBe(false);
  });

  // Regression guard. The app bridge is loaded by crxjs via
  // `import(chrome.runtime.getURL(...))` and its web-accessible resources are
  // hardened with use_dynamic_url. At document_start that dynamic URL is not yet
  // resolvable: getURL returns `chrome-extension://invalid/`, the import fails
  // with net::ERR_FAILED, and NO bridge installs — the web app then reports the
  // extension as missing. Attaching early looks like an easy win for the
  // presence-ping race; it is not. That race is closed on the page side instead.
  it('leaves the app bridge at the default document_idle', () => {
    const contentScripts = (
      baseManifest as {
        content_scripts: Array<{ matches: string[]; js?: string[]; run_at?: string }>;
      }
    ).content_scripts;

    const appScript = contentScripts.find((script) =>
      script.js?.includes('src/pages/content/bridge.ts')
    );

    expect(appScript?.run_at).toBeUndefined();
  });
});
