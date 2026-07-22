import { describe, expect, it } from 'vitest';
import {
  mediaFilename,
  parseRedditMediaLease,
} from '../reddit.media';
import { buildSelftextWithImages } from '../reddit.poster';

describe('parseRedditMediaLease', () => {
  it('extracts upload url, fields and asset id from a lease response', () => {
    const lease = parseRedditMediaLease({
      args: {
        action: '//reddit-uploaded-media.s3-accelerate.amazonaws.com',
        fields: [
          { name: 'key', value: 'rte_images/abc' },
          { name: 'policy', value: 'xyz' },
        ],
      },
      asset: { asset_id: 'as_123' },
    });
    expect(lease).toEqual({
      uploadUrl: 'https://reddit-uploaded-media.s3-accelerate.amazonaws.com',
      fields: [
        { name: 'key', value: 'rte_images/abc' },
        { name: 'policy', value: 'xyz' },
      ],
      assetId: 'as_123',
    });
  });

  it('keeps absolute action URLs and rejects malformed leases', () => {
    expect(
      parseRedditMediaLease({
        args: { action: 'https://host/up', fields: [] },
        asset: { asset_id: 'a' },
      })?.uploadUrl
    ).toBe('https://host/up');
    expect(parseRedditMediaLease(null)).toBeNull();
    expect(parseRedditMediaLease({ args: { action: '' } })).toBeNull();
    expect(
      parseRedditMediaLease({ args: { action: 'x', fields: 'nope' }, asset: {} })
    ).toBeNull();
  });
});

describe('mediaFilename', () => {
  it('uses the URL basename when it has an extension', () => {
    expect(
      mediaFilename('https://api/uploads/2026/photo.png?sig=1', 'image/png')
    ).toBe('photo.png');
  });

  it('derives an extension from the mimetype otherwise', () => {
    expect(mediaFilename('https://api/uploads/abc123', 'image/webp')).toBe(
      'abc123.webp'
    );
    expect(mediaFilename('https://api/', 'image/jpeg')).toBe('image.jpeg');
  });
});

describe('buildSelftextWithImages', () => {
  it('appends inline image markdown after the text', () => {
    expect(buildSelftextWithImages('hello', ['a1', 'a2'])).toBe(
      'hello\n\n![img](a1)\n\n![img](a2)'
    );
  });

  it('supports image-only and text-only bodies', () => {
    expect(buildSelftextWithImages('', ['a1'])).toBe('![img](a1)');
    expect(buildSelftextWithImages('just text', [])).toBe('just text');
  });
});
