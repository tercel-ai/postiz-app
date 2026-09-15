import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  CustomFileValidationPipe,
  isUploadableMimeType,
} from '../custom.upload.validation';

describe('isUploadableMimeType', () => {
  it('allows any image/*, including gif', () => {
    expect(isUploadableMimeType('image/jpeg')).toBe(true);
    expect(isUploadableMimeType('image/png')).toBe(true);
    expect(isUploadableMimeType('image/webp')).toBe(true);
    expect(isUploadableMimeType('image/gif')).toBe(true);
  });

  it('allows video/mp4 but not other video containers', () => {
    expect(isUploadableMimeType('video/mp4')).toBe(true);
    expect(isUploadableMimeType('video/webm')).toBe(false);
    expect(isUploadableMimeType('video/quicktime')).toBe(false);
  });

  it('refuses non-media types', () => {
    expect(isUploadableMimeType('application/pdf')).toBe(false);
    expect(isUploadableMimeType('text/html')).toBe(false);
  });
});

describe('CustomFileValidationPipe', () => {
  const pipe = new CustomFileValidationPipe();

  it('accepts a gif under the 10MB image budget', async () => {
    const file = { mimetype: 'image/gif', size: 5 * 1024 * 1024 };
    await expect(pipe.transform(file)).resolves.toBe(file);
  });

  it('accepts an mp4 under the 1GB video budget', async () => {
    const file = { mimetype: 'video/mp4', size: 500 * 1024 * 1024 };
    await expect(pipe.transform(file)).resolves.toBe(file);
  });

  it('rejects a gif over the 10MB image budget', async () => {
    const file = { mimetype: 'image/gif', size: 11 * 1024 * 1024 };
    await expect(pipe.transform(file)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unsupported container even under budget', async () => {
    const file = { mimetype: 'video/webm', size: 1024 };
    await expect(pipe.transform(file)).rejects.toBeInstanceOf(BadRequestException);
  });
});
