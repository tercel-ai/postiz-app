import { describe, it, expect, vi } from 'vitest';
import { CloudflareStorage } from '../cloudflare.storage';

// Real signatures — sniffing reads the first 12 bytes, so the fixtures have to
// be at least that long.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(12),
]);
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.alloc(8),
]);

function storageWithStubbedClient() {
  const storage = new CloudflareStorage(
    'account',
    'access-key',
    'secret-key',
    'auto',
    'test-bucket',
    'https://cdn.test'
  );
  const send = vi.fn(async (_command: any) => undefined);
  (storage as any)._client = { send };

  return { storage, send };
}

function multerFile(
  overrides: Partial<Express.Multer.File> = {}
): Express.Multer.File {
  return {
    buffer: PNG_BYTES,
    mimetype: 'image/png',
    originalname: 'photo.png',
    size: PNG_BYTES.length,
    fieldname: 'file',
    encoding: '7bit',
    destination: '',
    filename: '',
    path: '',
    stream: null as any,
    ...overrides,
  } as Express.Multer.File;
}

async function uploadAndCaptureCommandInput(file: Express.Multer.File) {
  const { storage, send } = storageWithStubbedClient();
  await storage.uploadFile(file);

  return send.mock.calls[0][0].input;
}

describe('CloudflareStorage.uploadFile — object key extension', () => {
  it('derives the extension from the MIME type when the client sends one', async () => {
    const input = await uploadAndCaptureCommandInput(multerFile());
    expect(input.Key).toMatch(/\.png$/);
  });

  // mime.extension('application/octet-stream') is 'bin', so a client that
  // uploads an untyped Blob used to have its image stored as <id>.bin.
  it('falls back to the filename extension when the MIME type is application/octet-stream', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({ mimetype: 'application/octet-stream' })
    );
    expect(input.Key).toMatch(/\.png$/);
    expect(input.Key).not.toMatch(/\.bin$/);
  });

  it('normalises an upper case filename extension', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({
        mimetype: 'application/octet-stream',
        originalname: 'PHOTO.JPG',
      })
    );
    expect(input.Key).toMatch(/\.jpg$/);
  });
});

describe('CloudflareStorage.uploadFile — object content type', () => {
  // R2 serves an object without an explicit ContentType as
  // application/octet-stream, so browsers download it instead of rendering it.
  it('sets a content type matching the resolved extension', async () => {
    const input = await uploadAndCaptureCommandInput(multerFile());
    expect(input.ContentType).toBe('image/png');
  });

  it('recovers the content type when the client uploads without a MIME type', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({ mimetype: 'application/octet-stream' })
    );
    expect(input.ContentType).toBe('image/png');
  });
});

describe('CloudflareStorage.uploadFile — identifying a file by its bytes', () => {
  // A file fetched with curl or written by an image API often lands on disk
  // with no extension, and an untyped upload carries no MIME type either.
  it('sniffs the format when neither the MIME type nor the filename identifies it', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({
        mimetype: 'application/octet-stream',
        originalname: 'generated',
      })
    );
    expect(input.Key).toMatch(/\.png$/);
    expect(input.ContentType).toBe('image/png');
  });

  it('sniffs the format when the file is already named .bin', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({
        mimetype: 'application/octet-stream',
        originalname: 'image.bin',
      })
    );
    expect(input.Key).toMatch(/\.png$/);
    expect(input.ContentType).toBe('image/png');
  });

  it.each([
    ['jpg', JPEG_BYTES, 'image/jpeg'],
    ['mp4', MP4_BYTES, 'video/mp4'],
  ])('sniffs %s from its signature', async (extension, buffer, contentType) => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({
        mimetype: 'application/octet-stream',
        originalname: '',
        buffer,
      })
    );
    expect(input.Key).toMatch(new RegExp(`\\.${extension}$`));
    expect(input.ContentType).toBe(contentType);
  });

  it('trusts the filename over the bytes for a format sniffing does not cover', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({
        mimetype: 'application/octet-stream',
        originalname: 'logo.svg',
      })
    );
    expect(input.Key).toMatch(/\.svg$/);
  });

  it('sniffs a file that is only as long as the signature itself', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({
        mimetype: 'application/octet-stream',
        originalname: 'generated',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      })
    );
    expect(input.Key).toMatch(/\.png$/);
  });

  it('stays on .bin when the bytes match nothing known', async () => {
    const input = await uploadAndCaptureCommandInput(
      multerFile({
        mimetype: 'application/octet-stream',
        originalname: 'mystery',
        buffer: Buffer.alloc(32, 0x5a),
      })
    );
    expect(input.Key).toMatch(/\.bin$/);
  });
});
