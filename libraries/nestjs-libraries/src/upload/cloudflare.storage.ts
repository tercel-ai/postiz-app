import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import 'multer';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import mime from 'mime-types';
// @ts-ignore
import { getExtension } from 'mime';
import { IUploadProvider } from './upload.interface';
import axios from 'axios';
import { extname } from 'path';

const UNKNOWN_MIME_TYPE = 'application/octet-stream';
const UNKNOWN_EXTENSION = 'bin';

/**
 * Identifies a file by its leading bytes. This is the last resort, for an
 * upload whose MIME type and filename both say nothing — an untyped blob sent
 * under an extension-less name would otherwise be stored as <id>.bin.
 */
function sniffExtension(buffer: Buffer | undefined): string {
  if (!buffer?.length) {
    return '';
  }

  // subarray and slice clamp to what is there, so a file shorter than a
  // signature simply fails to match rather than throwing.

  const hex = buffer.subarray(0, 12).toString('hex');
  const ascii = buffer.subarray(0, 12).toString('latin1');

  if (hex.startsWith('89504e470d0a1a0a')) return 'png';
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (ascii.startsWith('BM')) return 'bmp';
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'tiff';
  if (hex.startsWith('1a45dfa3')) return 'webm';

  // ISO base media container — the brand at bytes 8-11 separates the formats
  // that share the ftyp header.
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (brand === 'qt  ') return 'mov';
    if (brand.startsWith('avi')) return 'avif';
    if (brand.startsWith('hei') || brand === 'mif1') return 'heic';
    return 'mp4';
  }

  return '';
}

/**
 * mime.extension() maps application/octet-stream to "bin", so a client that
 * uploads without a MIME type gets its image stored as <id>.bin. Treat that
 * type as unknown and fall back to the filename, then to the file's own bytes.
 */
function extensionFor(file: Express.Multer.File): string {
  const fromMimeType =
    file.mimetype && file.mimetype !== UNKNOWN_MIME_TYPE
      ? mime.extension(file.mimetype)
      : '';

  const fromFilename = extname(file.originalname || '')
    .slice(1)
    .toLowerCase();

  return (
    fromMimeType ||
    (fromFilename === UNKNOWN_EXTENSION ? '' : fromFilename) ||
    sniffExtension(file.buffer) ||
    UNKNOWN_EXTENSION
  );
}

class CloudflareStorage implements IUploadProvider {
  private _client: S3Client;

  constructor(
    accountID: string,
    accessKey: string,
    secretKey: string,
    private region: string,
    private _bucketName: string,
    private _uploadUrl: string
  ) {
    this._client = new S3Client({
      endpoint: `https://${accountID}.r2.cloudflarestorage.com`,
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });

    this._client.middlewareStack.add(
      (next) =>
        async (args): Promise<any> => {
          const request = args.request as RequestInit;

          // Remove checksum headers
          const headers = request.headers as Record<string, string>;
          delete headers['x-amz-checksum-crc32'];
          delete headers['x-amz-checksum-crc32c'];
          delete headers['x-amz-checksum-sha1'];
          delete headers['x-amz-checksum-sha256'];
          request.headers = headers;

          Object.entries(request.headers).forEach(
            // @ts-ignore
            ([key, value]: [string, string]): void => {
              if (!request.headers) {
                request.headers = {};
              }
              (request.headers as Record<string, string>)[key] = value;
            }
          );

          return next(args);
        },
      { step: 'build', name: 'customHeaders' }
    );
  }

  async uploadSimple(path: string) {
    let body: Buffer;
    let extension: string;
    let contentType: string | null;

    if (path.startsWith('data:')) {
      // Handle data URIs (e.g. data:image/png;base64,iVBOR...)
      const matches = path.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        throw new Error('Invalid data URI format');
      }
      contentType = matches[1];
      extension = getExtension(contentType) || 'png';
      body = Buffer.from(matches[2], 'base64');
    } else {
      const loadImage = await fetch(path);
      contentType =
        loadImage?.headers?.get('content-type') ||
        loadImage?.headers?.get('Content-Type');
      extension = getExtension(contentType)!;
      body = Buffer.from(await loadImage.arrayBuffer());
    }

    const id = makeId(10);

    const params = {
      Bucket: this._bucketName,
      Key: `${id}.${extension}`,
      Body: body,
      ContentType: contentType,
      ChecksumMode: 'DISABLED',
    };

    const command = new PutObjectCommand({ ...params });
    await this._client.send(command);

    return `${this._uploadUrl}/${id}.${extension}`;
  }

  async uploadFile(file: Express.Multer.File): Promise<any> {
    try {
      const id = makeId(10);
      const extension = extensionFor(file);
      // Without an explicit ContentType, R2 serves the object as
      // application/octet-stream and browsers download it instead of
      // rendering it, whatever the key's extension says.
      const contentType = mime.lookup(extension) || file.mimetype;

      // Create the PutObjectCommand to upload the file to Cloudflare R2
      const command = new PutObjectCommand({
        Bucket: this._bucketName,
        ACL: 'public-read',
        Key: `${id}.${extension}`,
        Body: file.buffer,
        ContentType: contentType,
      });

      await this._client.send(command);

      return {
        filename: `${id}.${extension}`,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
        originalname: `${id}.${extension}`,
        fieldname: 'file',
        path: `${this._uploadUrl}/${id}.${extension}`,
        destination: `${this._uploadUrl}/${id}.${extension}`,
        encoding: '7bit',
        stream: file.buffer as any,
      };
    } catch (err) {
      console.error('Error uploading file to Cloudflare R2:', err);
      throw err;
    }
  }

  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType: string
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this._bucketName,
      ACL: 'public-read',
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });

    await this._client.send(command);

    return `${this._uploadUrl}/${key}`;
  }

  // Implement the removeFile method from IUploadProvider
  async removeFile(filePath: string): Promise<void> {
    // const fileName = filePath.split('/').pop(); // Extract the filename from the path
    // const command = new DeleteObjectCommand({
    //   Bucket: this._bucketName,
    //   Key: fileName,
    // });
    // await this._client.send(command);
  }
}

export { CloudflareStorage };
export default CloudflareStorage;
