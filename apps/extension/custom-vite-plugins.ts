import esbuild from 'esbuild';
import fs from 'fs';
import { resolve } from 'path';
import type { PluginOption } from 'vite';

// plugin to remove dev icons from prod build
export function stripDevIcons(isDev: boolean) {
  if (isDev) return null;

  return {
    name: 'strip-dev-icons',
    resolveId(source: string) {
      return source === 'virtual-module' ? source : null;
    },
    renderStart(outputOptions: any, inputOptions: any) {
      const outDir = outputOptions.dir;
      fs.rm(resolve(outDir, 'dev-icon-32.png'), () =>
        console.log(`Deleted dev-icon-32.png from prod build`)
      );
      fs.rm(resolve(outDir, 'dev-icon-128.png'), () =>
        console.log(`Deleted dev-icon-128.png from prod build`)
      );
    },
  };
}

/**
 * Make every content script a SELF-CONTAINED bundle, and drop the
 * `web_accessible_resources` entries that only existed to serve its chunks.
 *
 * WHY (the fingerprinting problem this closes):
 * LinkedIn (and other sites) enumerate installed extensions by fetching
 * `chrome-extension://<id>/<known-file>` for a hardcoded list of ids — a fetch
 * that resolves means "installed", and the hit is reported through their
 * `AedEvent` tracking payload. crxjs does not bundle a content script into one
 * file: it injects a tiny loader that pulls the real module in with a dynamic
 * `import()`, which forces every content-script chunk into
 * `web_accessible_resources` — exactly the probeable surface.
 *
 * WHY NOT `use_dynamic_url` (the obvious fix, and a trap):
 * Serving those resources under a per-session GUID does hide them from outside
 * pages, but it also breaks the loader that has to fetch them:
 *   - MAIN world: the loader runs in PAGE context and imports a RELATIVE
 *     './chunk.js', which resolves against the real extension id.
 *   - ISOLATED world: the loader imports `chrome.runtime.getURL('assets/…')`.
 *     getURL does hand back the GUID URL, but the module fetch of it fails with
 *     "TypeError: Failed to fetch dynamically imported module".
 * Either way the loader's promise rejects and NOTHING in that content script
 * installs — silently, because crxjs only `.catch(console.error)`s it. That took
 * down the whole app bridge (presence ping included, so the web app reported the
 * extension as not installed) and the x.com/linkedin.com script with it.
 *
 * WHAT THIS DOES INSTEAD:
 * Bundle each content script's chunk graph into one IIFE and point
 * `content_scripts.js` straight at it. With nothing left to fetch at runtime,
 * the `web_accessible_resources` entries serving those chunks are removed — a
 * resource that is not web-accessible cannot be fetched by a page at all, so
 * there is nothing to probe. Every content script keeps working, in both worlds,
 * with no dynamic import and no async gap before it installs.
 *
 * All three of ours are pure side-effect modules (none exports the `onExecute`
 * hook crxjs's loader optionally calls), so running the bundle IS the whole
 * contract. `assertSelfContained` below fails the build if that ever stops
 * holding, rather than shipping a content script that silently does nothing.
 */
export function selfContainedContentScripts(): PluginOption {
  return {
    name: 'crx-self-contained-content-scripts',
    enforce: 'post',
    writeBundle: {
      order: 'post',
      handler(outputOptions: any) {
        const outDir: string = outputOptions.dir;
        const manifestPath = resolve(outDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
          // Only reachable if this plugin no longer runs after crx().
          throw new Error(
            `[crx-selfcontained] ${manifestPath} not found — the plugin ran ` +
              `before crx() emitted the manifest; fix the plugin order.`
          );
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const read = (file: string) => {
          const path = resolve(outDir, file);
          return fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : null;
        };

        // The two import forms crxjs emits, by world. Both carry the
        // `/* @vite-ignore */` comment, hence the optional comment skip.
        const targetOfLoader = (loader: string, source: string) => {
          const viaGetUrl = source.match(
            /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)\s*\)/
          );
          if (viaGetUrl) return viaGetUrl[1];
          const relative = source.match(
            /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["']\.\/([^"']+)["']\s*\)/
          );
          if (relative)
            return loader.slice(0, loader.lastIndexOf('/') + 1) + relative[1];
          return null;
        };

        // Everything the bundled entry pulls in, so we know which
        // web_accessible_resources entries are now dead.
        const reachableFrom = (entry: string) => {
          const seen = new Set<string>();
          const queue = [entry];
          while (queue.length) {
            const file = queue.pop() as string;
            if (seen.has(file)) continue;
            seen.add(file);
            const source = read(file);
            if (!source) continue;
            const dir = file.slice(0, file.lastIndexOf('/') + 1);
            for (const [, rel] of source.matchAll(
              /(?:import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?|from\s*)["']\.\/([^"']+)["']/g
            ))
              queue.push(dir + rel);
          }
          return seen;
        };

        const inlinedChunks = new Set<string>();
        const summary: string[] = [];

        for (const script of manifest.content_scripts || []) {
          const js: string[] = script?.js || [];
          for (let i = 0; i < js.length; i++) {
            const loader = js[i];
            const source = read(loader);
            if (source === null) {
              throw new Error(
                `[crx-selfcontained] content-script file ${loader} not found on disk.`
              );
            }
            const chunk = targetOfLoader(loader, source);
            if (!chunk) {
              // Already a plain script — crxjs only emits a loader when the
              // entry compiles to an ES module. Nothing to inline.
              continue;
            }
            if (!read(chunk)) {
              throw new Error(
                `[crx-selfcontained] loader ${loader} imports ${chunk}, which is ` +
                  `not on disk; crxjs codegen changed — update the parser.`
              );
            }

            for (const file of reachableFrom(chunk)) inlinedChunks.add(file);

            const outFile = `assets/${chunk
              .slice(chunk.lastIndexOf('/') + 1)
              .replace(/\.js$/, '')}.bundle.js`;
            esbuild.buildSync({
              entryPoints: [resolve(outDir, chunk)],
              outfile: resolve(outDir, outFile),
              bundle: true,
              format: 'iife',
              platform: 'browser',
              // Input is already transpiled and minified by vite; re-lowering it
              // would only risk changing semantics.
              target: 'esnext',
              legalComments: 'none',
            });

            assertSelfContained(outFile, read(outFile) as string);
            js[i] = outFile;
            // The loader is referenced by nothing else — leaving it behind would
            // ship a file whose only purpose was the fetch we just removed.
            fs.rmSync(resolve(outDir, loader), { force: true });
            summary.push(`${loader} → ${outFile}`);
          }
        }

        if (summary.length === 0) {
          throw new Error(
            `[crx-selfcontained] no content-script loader found to inline — ` +
              `crxjs codegen changed; the fingerprinting surface this plugin ` +
              `removes is silently back. Update the parser before shipping.`
          );
        }

        // Chunks now live inside the bundles, so nothing fetches them at
        // runtime. Dropping them from web_accessible_resources is what actually
        // closes the probe: a resource that is not web-accessible cannot be
        // fetched by a page, whatever its URL.
        const war = manifest.web_accessible_resources;
        let removedEntries = 0;
        let removedResources = 0;
        if (Array.isArray(war)) {
          manifest.web_accessible_resources = war
            .map((entry: any) => {
              const resources: string[] = entry?.resources || [];
              const kept = resources.filter((r) => !inlinedChunks.has(r));
              removedResources += resources.length - kept.length;
              return { ...entry, resources: kept };
            })
            .filter((entry: any) => {
              if (entry.resources.length > 0) return true;
              removedEntries++;
              return false;
            });
        }

        // Release evidence: a build where this applied to nothing must not look
        // the same in the console as one where it applied to everything.
        const exposed = (manifest.web_accessible_resources || []).filter(
          (e: any) => e?.matches?.length
        ).length;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(
          `[crx-selfcontained] inlined ${summary.length} content script${
            summary.length === 1 ? '' : 's'
          } (${summary.join(', ')}); dropped ${removedResources} resource${
            removedResources === 1 ? '' : 's'
          } across ${removedEntries} web_accessible_resources entr${
            removedEntries === 1 ? 'y' : 'ies'
          }; ${exposed} page-reachable entr${
            exposed === 1 ? 'y' : 'ies'
          } left`
        );
      },
    },
  };
}

/**
 * A bundle that still fetches something at runtime defeats the whole point — it
 * would need a web_accessible_resources entry we just deleted, and would fail
 * silently in the browser. Catch it at build time instead.
 */
function assertSelfContained(file: string, source: string): void {
  const offenders = [
    ['chrome.runtime.getURL', /chrome\.runtime\.getURL\s*\(/],
    ['dynamic import()', /\bimport\s*\(/],
    ['static import', /(?:^|[};\s])import\s*[{*"']/],
  ] as const;
  for (const [label, pattern] of offenders) {
    if (pattern.test(source)) {
      throw new Error(
        `[crx-selfcontained] ${file} still contains a ${label} after bundling — ` +
          `it would need a web_accessible_resources entry to resolve it at ` +
          `runtime, which is exactly the fingerprinting surface this removes.`
      );
    }
  }
}

// plugin to support i18n
export function crxI18n(options: {
  localize: boolean;
  src: string;
}): PluginOption {
  if (!options.localize) return null;

  const getJsonFiles = (dir: string): Array<string> => {
    const files = fs.readdirSync(dir, { recursive: true }) as string[];
    return files.filter((file) => !!file && file.endsWith('.json'));
  };
  const entry = resolve(__dirname, options.src);
  const localeFiles = getJsonFiles(entry);
  const files = localeFiles.map((file) => {
    return {
      id: '',
      fileName: file,
      source: fs.readFileSync(resolve(entry, file)),
    };
  });
  return {
    name: 'crx-i18n',
    enforce: 'pre',
    buildStart: {
      order: 'post',
      handler() {
        files.forEach((file) => {
          const refId = this.emitFile({
            type: 'asset',
            source: file.source,
            fileName: '_locales/' + file.fileName,
          });
          file.id = refId;
        });
      },
    },
  };
}
