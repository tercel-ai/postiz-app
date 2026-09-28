// The admin upload route decides, from the zip alone, which release line a
// build belongs to.
//
// It has to, because dev and prod are two DIFFERENT extensions — different
// signing key, id and name — that were previously stored under one filename and
// one setting key. Whichever was uploaded second silently replaced the first,
// so `extension.chrome` (served unauthenticated by GET /public/extension/latest
// and polled by every installed extension) could start pointing at a dev build,
// and the dev one would vanish. Nothing errored; the wrong file was simply on
// the URL.
//
// The zips these cases upload are built the way the real ones are, by
// scripts/pack.sh: manifest.json at the ROOT (which is also what Chrome's own
// drag-to-install requires) carrying the name vite's manifest overlay gives the
// build.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';

const uploadBuffer = vi.fn(async (path: string) => `https://cdn.test/${path}`);
vi.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadBuffer }) },
}));

import { AdminExtensionController } from '../admin-extension.controller';

/** A zip shaped like pack.sh's: manifest.json at the top level. */
function buildZip(manifest: Record<string, unknown>): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('assets/index.js', Buffer.from('// build output'));
  return zip.toBuffer();
}

const file = (manifest: Record<string, unknown>) =>
  ({
    originalname: 'aisee-extension-v1.20.2-chrome-dev-20260928-1632.zip',
    buffer: buildZip(manifest),
  } as any);

const PROD = { name: 'Aisee', version: '1.20.2' };
const DEV = { name: 'Aisee - Dev', version: '1.20.2' };

let settings: Record<string, unknown>;
let controller: AdminExtensionController;

beforeEach(() => {
  uploadBuffer.mockClear();
  settings = {};
  controller = new AdminExtensionController({
    get: async (k: string) => settings[k] ?? null,
    set: async (k: string, v: unknown) => {
      settings[k] = v;
    },
  } as any);
});

describe('AdminExtensionController — release lines', () => {
  it('keeps a prod upload on the names every published URL already uses', async () => {
    const res = await controller.uploadChrome(file(PROD));

    expect(res).toMatchObject({ platform: 'chrome', channel: 'prod', version: '1.20.2' });
    expect(uploadBuffer).toHaveBeenCalledWith(
      'extensions/aisee-extension-chrome-1.20.2.zip',
      expect.anything(),
      'application/zip'
    );
    // The key GET /public/extension/latest reads.
    expect(settings['extension.chrome']).toMatchObject({ version: '1.20.2' });
  });

  it('routes a dev upload to its own file and its own setting', async () => {
    const res = await controller.uploadChrome(file(DEV));

    expect(res).toMatchObject({ channel: 'dev' });
    expect(uploadBuffer).toHaveBeenCalledWith(
      'extensions/aisee-extension-chrome-dev-1.20.2.zip',
      expect.anything(),
      'application/zip'
    );
    expect(settings['extension.chrome.dev']).toMatchObject({ version: '1.20.2' });
    expect(settings['extension.chrome']).toBeUndefined();
  });

  it('does not let a dev upload touch the production release', async () => {
    // The whole point. Same platform, same version, uploaded back to back —
    // previously the second one overwrote the first's file AND its setting.
    await controller.uploadChrome(file(PROD));
    await controller.uploadChrome(file(DEV));

    expect(settings['extension.chrome']).toMatchObject({
      downloadUrl: 'https://cdn.test/extensions/aisee-extension-chrome-1.20.2.zip',
    });
    expect(settings['extension.chrome.dev']).toMatchObject({
      downloadUrl: 'https://cdn.test/extensions/aisee-extension-chrome-dev-1.20.2.zip',
    });
  });

  it('keeps the two browsers apart as well as the two channels', async () => {
    await controller.uploadChrome(file(DEV));
    await controller.uploadFirefox(file(DEV));

    expect(uploadBuffer).toHaveBeenCalledWith(
      'extensions/aisee-extension-firefox-dev-1.20.2.zip',
      expect.anything(),
      'application/zip'
    );
    expect(Object.keys(settings).sort()).toEqual([
      'extension.chrome.dev',
      'extension.firefox.dev',
    ]);
  });

  it('reports both lines, with the old fields unchanged', async () => {
    await controller.uploadChrome(file(PROD));
    await controller.uploadChrome(file(DEV));

    const latest = await controller.getLatest();

    // `chrome`/`firefox` keep their exact previous meaning, so an admin UI that
    // has not been updated is unaffected.
    expect(latest.chrome).toMatchObject({ version: '1.20.2' });
    expect(latest.chromeDev).toMatchObject({ version: '1.20.2' });
    expect(latest.firefox).toBeNull();
    expect(latest.firefoxDev).toBeNull();
  });

  it('treats an unmarked build as production', async () => {
    // The dev marker is applied by vite to EVERY build that is not an explicit
    // EXTENSION_ENV=production release, so its absence is what identifies a
    // real release. A build with no name at all is the same case.
    await controller.uploadChrome(file({ version: '1.20.2' }));

    expect(settings['extension.chrome']).toBeDefined();
    expect(settings['extension.chrome.dev']).toBeUndefined();
  });

  it('refuses a zip that wraps the build in a folder', async () => {
    // `zip -r out.zip dist` puts manifest.json at dist/manifest.json. Chrome's
    // own installer rejects that shape too, so failing here is the same answer
    // the user would get from the browser — not a new restriction.
    const zip = new AdmZip();
    zip.addFile('dist/manifest.json', Buffer.from(JSON.stringify(PROD)));

    await expect(
      controller.uploadChrome({ originalname: 'x.zip', buffer: zip.toBuffer() } as any)
    ).rejects.toThrow(/manifest\.json not found/);
  });
});
