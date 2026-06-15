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
});
