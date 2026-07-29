import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { selfContainedContentScripts } from '../../../../custom-vite-plugins';

// Guards the extension-fingerprinting fix. Sites like LinkedIn enumerate
// installed extensions by fetching `chrome-extension://<id>/<known-file>`; the
// only reason our content-script chunks were fetchable at all is that crxjs
// splits every content script into a loader + web-accessible chunks. The plugin
// bundles each one self-contained and removes those entries. If a future crxjs
// upgrade changes its codegen, this test fails instead of silently restoring the
// probe surface.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal stand-in for a crxjs build output: loader → chunk → shared chunk. */
function scaffold(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'crx-selfcontained-'));
  dirs.push(dir);
  fs.mkdirSync(join(dir, 'assets'));

  fs.writeFileSync(
    join(dir, 'assets/shared-abc.js'),
    'export const marker = "shared-chunk-code";\n'
  );
  fs.writeFileSync(
    join(dir, 'assets/bridge-def.js'),
    'import { marker } from "./shared-abc.js";\nglobalThis.__installed = marker;\n'
  );
  // Isolated-world loader form.
  fs.writeFileSync(
    join(dir, 'assets/bridge-loader.js'),
    '(async () => { await import(/* @vite-ignore */ chrome.runtime.getURL("assets/bridge-def.js")); })().catch(console.error);\n'
  );
  // MAIN-world loader form (relative import).
  fs.writeFileSync(
    join(dir, 'assets/main-ghi.js'),
    'globalThis.__mainInstalled = true;\n'
  );
  fs.writeFileSync(
    join(dir, 'assets/main-loader.js'),
    '(async () => { await import(/* @vite-ignore */ "./main-ghi.js"); })().catch(console.error);\n'
  );

  fs.writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      content_scripts: [
        { matches: ['https://app.example.com/*'], js: ['assets/bridge-loader.js'] },
        {
          matches: ['https://x.com/*'],
          js: ['assets/main-loader.js'],
          world: 'MAIN',
          run_at: 'document_start',
        },
      ],
      web_accessible_resources: [
        {
          matches: ['https://app.example.com/*'],
          resources: ['assets/bridge-def.js', 'assets/shared-abc.js'],
          use_dynamic_url: false,
        },
        {
          matches: ['https://x.com/*'],
          resources: ['assets/main-ghi.js'],
          use_dynamic_url: false,
        },
        // Not page-reachable, and not a content-script chunk — must survive.
        { matches: [], resources: ['icon-128.png'], use_dynamic_url: false },
      ],
    })
  );
  return dir;
}

function run(dir: string) {
  const plugin = selfContainedContentScripts() as any;
  plugin.writeBundle.handler({ dir });
  return JSON.parse(fs.readFileSync(join(dir, 'manifest.json'), 'utf-8'));
}

describe('selfContainedContentScripts', () => {
  it('leaves no page-reachable web_accessible_resources entry', () => {
    const manifest = run(scaffold());

    const reachable = manifest.web_accessible_resources.filter(
      (entry: any) => entry.matches?.length
    );
    expect(reachable).toEqual([]);
    // The page-unreachable entry is untouched — it was never probeable.
    expect(manifest.web_accessible_resources).toEqual([
      { matches: [], resources: ['icon-128.png'], use_dynamic_url: false },
    ]);
  });

  it('inlines both loader forms into self-contained bundles that still self-install', () => {
    const dir = scaffold();
    const manifest = run(dir);

    for (const script of manifest.content_scripts) {
      const [file] = script.js;
      expect(file).toMatch(/\.bundle\.js$/);
      const source = fs.readFileSync(join(dir, file), 'utf-8');
      // Nothing left to fetch at runtime — that is what makes dropping the
      // web_accessible_resources entries safe.
      expect(source).not.toMatch(/chrome\.runtime\.getURL\s*\(/);
      expect(source).not.toMatch(/\bimport\s*\(/);
    }

    const bridge = fs.readFileSync(join(dir, manifest.content_scripts[0].js[0]), 'utf-8');
    // The shared chunk was inlined, not left behind as a separate fetch.
    expect(bridge).toContain('shared-chunk-code');
    expect(bridge).toContain('__installed');

    // world / run_at are preserved — the MAIN-world interceptor must still run
    // at document_start, now synchronously instead of behind an async import.
    expect(manifest.content_scripts[1]).toMatchObject({
      world: 'MAIN',
      run_at: 'document_start',
    });

    // Loaders are gone: their only purpose was the fetch we removed.
    expect(fs.existsSync(join(dir, 'assets/bridge-loader.js'))).toBe(false);
    expect(fs.existsSync(join(dir, 'assets/main-loader.js'))).toBe(false);
  });

  it('fails the build when crxjs stops emitting a loader to inline', () => {
    const dir = scaffold();
    const manifest = JSON.parse(fs.readFileSync(join(dir, 'manifest.json'), 'utf-8'));
    // Simulate a codegen change: content scripts point at plain scripts, so the
    // plugin has nothing to inline and the chunks would stay web-accessible.
    manifest.content_scripts = [
      { matches: ['https://app.example.com/*'], js: ['assets/shared-abc.js'] },
    ];
    fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));

    expect(() => run(dir)).toThrow(/no content-script loader found to inline/);
  });
});
