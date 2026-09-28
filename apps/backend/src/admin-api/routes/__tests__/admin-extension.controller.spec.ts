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

describe('AdminExtensionController', () => {
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

  it('stores a dev upload under the standard Chrome setting in the dev database', async () => {
    const res = await controller.uploadChrome(file(DEV));

    expect(res).toMatchObject({ channel: 'dev' });
    expect(uploadBuffer).toHaveBeenCalledWith(
      'extensions/aisee-extension-chrome-dev-1.20.2.zip',
      expect.anything(),
      'application/zip'
    );
    expect(settings['extension.chrome']).toMatchObject({ version: '1.20.2' });
    expect(settings['extension.chrome.dev']).toBeUndefined();
  });

  it('stores a dev Firefox upload under the standard Firefox setting', async () => {
    await controller.uploadChrome(file(DEV));
    await controller.uploadFirefox(file(DEV));

    expect(uploadBuffer).toHaveBeenCalledWith(
      'extensions/aisee-extension-firefox-dev-1.20.2.zip',
      expect.anything(),
      'application/zip'
    );
    expect(Object.keys(settings).sort()).toEqual([
      'extension.chrome',
      'extension.firefox',
    ]);
  });

  it('reports only the standard browser fields', async () => {
    await controller.uploadChrome(file(PROD));
    await controller.uploadChrome(file(DEV));

    const latest = await controller.getLatest();

    expect(latest.chrome).toMatchObject({ version: '1.20.2' });
    expect(latest.firefox).toBeNull();
    expect(latest).toEqual({
      chrome: expect.any(Object),
      firefox: null,
    });
  });

  it('treats an unmarked build as production', async () => {
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
