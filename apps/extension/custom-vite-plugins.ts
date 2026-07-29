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
 * Harden the crxjs-generated `web_accessible_resources` against extension
 * fingerprinting.
 *
 * LinkedIn (and other sites) enumerate installed extensions by fetching
 * `chrome-extension://<id>/<known-file>` for a hardcoded list of ids — a fetch
 * that resolves means "installed", and the hit is reported through their
 * `AedEvent` tracking payload. crxjs emits every content-script chunk into
 * `web_accessible_resources` with `use_dynamic_url: false`, which leaves those
 * paths static and therefore probeable once the store id is public.
 *
 * `use_dynamic_url: true` makes Chrome serve the resource under a per-session
 * random GUID instead of the extension id, so an outside page cannot guess the
 * URL. Resources reached from the extension's own contexts still resolve.
 *
 * MAIN-world content scripts are the exception and MUST stay static: crxjs
 * loads their chunk with a RELATIVE `import('./chunk.js')` from a loader that
 * runs in the PAGE context, which resolves against the real extension id. Under
 * a dynamic URL the page is no longer allowed to fetch that path and the
 * interceptor silently fails to install. Those entries are left untouched.
 *
 * Chrome-only: `use_dynamic_url` is not a Firefox manifest key, and Firefox
 * already randomises the moz-extension:// origin per profile.
 */
export function hardenWebAccessibleResources(): PluginOption {
  return {
    name: 'crx-harden-web-accessible-resources',
    enforce: 'post',
    writeBundle: {
      order: 'post',
      handler(outputOptions: any) {
        // Every exit below says something. A build where the hardening applied
        // to nothing must not be byte-identical in the console to one where it
        // applied to everything — nothing downstream re-checks the property
        // (pack.sh only zips dist/), so this log IS the release evidence.
        const manifestPath = resolve(outputOptions.dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
          // Only reachable if this plugin no longer runs after crx().
          throw new Error(
            `[crx-harden] ${manifestPath} not found — the plugin ran before ` +
              `crx() emitted the manifest; fix the plugin order.`
          );
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const war = manifest.web_accessible_resources;
        if (!Array.isArray(war) || war.length === 0) {
          console.warn(
            '[crx-harden] skipped: manifest declares no web_accessible_resources'
          );
          return;
        }

        // Chunks reachable from a MAIN-world loader, collected by following the
        // relative import the loader emits. crxjs writes it as
        // `import(/* @vite-ignore */ "./chunk.js")`, hence the comment skip.
        // One level is enough today (the MAIN-world entry is self-contained); a
        // chunk importing further chunks would need the same treatment.
        const mainWorldFiles = new Set<string>();
        for (const script of manifest.content_scripts || []) {
          if (script?.world !== 'MAIN') continue;
          for (const loader of script.js || []) {
            mainWorldFiles.add(loader);
            const loaderPath = resolve(outputOptions.dir, loader);
            if (!fs.existsSync(loaderPath)) {
              throw new Error(
                `[crx-harden] MAIN-world loader ${loader} not found on disk — ` +
                  `cannot tell which chunks must stay statically addressable.`
              );
            }
            const dir = loader.slice(0, loader.lastIndexOf('/') + 1);
            const source = fs.readFileSync(loaderPath, 'utf-8');
            const imports = [
              ...source.matchAll(
                /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["']\.\/([^"']+)["']/g
              ),
            ];
            // A MAIN-world loader that imports nothing means crxjs changed its
            // codegen. Failing loudly beats silently hardening a chunk the page
            // context still has to fetch by real extension id.
            if (imports.length === 0) {
              throw new Error(
                `[crx-harden] no relative import found in MAIN-world loader ${loader} — ` +
                  `crxjs codegen changed; update the parser before shipping.`
              );
            }
            for (const [, rel] of imports) mainWorldFiles.add(dir + rel);
          }
        }

        let hardened = 0;
        for (const entry of war) {
          // Entries exposed to no page cannot be probed in the first place.
          if (!entry?.matches?.length) continue;
          if (entry.use_dynamic_url === true) continue;
          const resources: string[] = entry.resources || [];
          if (resources.some((r) => mainWorldFiles.has(r))) continue;
          entry.use_dynamic_url = true;
          hardened++;
        }
        if (!hardened) {
          console.warn(
            `[crx-harden] skipped: nothing to harden — all ${war.length} ` +
              `web_accessible_resources entr${
                war.length === 1 ? 'y is' : 'ies are'
              } already dynamic, page-unreachable, or MAIN-world exempt`
          );
          return;
        }

        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(
          `[crx-harden] use_dynamic_url=true on ${hardened} web_accessible_resources entr${
            hardened === 1 ? 'y' : 'ies'
          }`
        );
      },
    },
  };
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
