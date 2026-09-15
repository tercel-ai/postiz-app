import { describe, it, expect } from 'vitest';
import {
  hasValidMediaExtension,
  VALID_MEDIA_EXTENSIONS,
} from '../valid.url.path';

// The case this was widened for, measured live (Sep 2026):
//
//   https://pbs.twimg.com/card_img/2099484736326418433/DnKAG7nW?format=jpg&name=orig
//     → HTTP 200, image/jpeg, 53152 bytes
//
// and every extension-bearing rewrite of it 404s on that host:
//
//   …/DnKAG7nW.jpg?name=orig   404
//   …/DnKAG7nW.jpg             404
//   …/DnKAG7nW.jpeg            404
//   …/DnKAG7nW:orig            404
//   …/DnKAG7nW/img.jpg         404
//
// So a card image can ONLY be addressed with the format in the query, and
// rejecting that shape made every X post whose only picture is a link-preview
// card unusable — reported to the user as an unsupported file format.
const CARD_IMG =
  'https://pbs.twimg.com/card_img/2099484736326418433/DnKAG7nW?format=jpg&name=orig';

describe('hasValidMediaExtension — extension on the path', () => {
  it('accepts every extension MediaDto allows', () => {
    for (const ext of VALID_MEDIA_EXTENSIONS) {
      expect(hasValidMediaExtension(`https://cdn.example.com/a${ext}`), ext).toBe(
        true
      );
    }
  });

  it('ignores the query string when the path already has an extension', () => {
    expect(
      hasValidMediaExtension('https://pbs.twimg.com/media/ABC.jpg?name=large')
    ).toBe(true);
  });

  it('rejects an extension no platform can take', () => {
    // The reason the list exists: X serves image/avif and Reddit video/webm,
    // and a re-hosted file named from those content types must not reach a post.
    expect(hasValidMediaExtension('https://cdn.example.com/a.avif')).toBe(false);
    expect(hasValidMediaExtension('https://cdn.example.com/a.webm')).toBe(false);
  });

  it('rejects a path with no extension at all', () => {
    expect(hasValidMediaExtension('https://cdn.example.com/a')).toBe(false);
  });

  it('rejects empty and nullish input rather than throwing', () => {
    expect(hasValidMediaExtension('')).toBe(false);
    expect(hasValidMediaExtension(undefined as unknown as string)).toBe(false);
    expect(hasValidMediaExtension(null as unknown as string)).toBe(false);
  });
});

describe('hasValidMediaExtension — format declared in the query', () => {
  it('accepts an X link-preview card image', () => {
    expect(hasValidMediaExtension(CARD_IMG)).toBe(true);
  });

  it('accepts the format parameter in either position', () => {
    const base = 'https://pbs.twimg.com/card_img/1/h';
    expect(hasValidMediaExtension(`${base}?format=jpg&name=orig`)).toBe(true);
    expect(hasValidMediaExtension(`${base}?name=orig&format=jpg`)).toBe(true);
  });

  it('accepts every allowed format, however it is cased', () => {
    for (const ext of VALID_MEDIA_EXTENSIONS) {
      const fmt = ext.slice(1);
      expect(hasValidMediaExtension(`https://x.test/h?format=${fmt}`), fmt).toBe(
        true
      );
      expect(
        hasValidMediaExtension(`https://x.test/h?format=${fmt.toUpperCase()}`),
        fmt
      ).toBe(true);
    }
  });

  it('still rejects a declared format the platforms cannot take', () => {
    // Widening the check must not smuggle in the formats the list exists to
    // keep out — X hands out avif for exactly these card images sometimes.
    expect(hasValidMediaExtension('https://x.test/h?format=avif')).toBe(false);
    expect(hasValidMediaExtension('https://x.test/h?format=webm')).toBe(false);
    expect(hasValidMediaExtension('https://x.test/h?format=svg')).toBe(false);
  });

  it('rejects a query that declares no format', () => {
    expect(hasValidMediaExtension('https://x.test/h?name=orig')).toBe(false);
    expect(hasValidMediaExtension('https://x.test/h?format=')).toBe(false);
    expect(hasValidMediaExtension('https://x.test/h?')).toBe(false);
  });

  it('is not fooled by the format appearing somewhere other than a parameter', () => {
    // A path segment or another parameter's value that merely contains "jpg"
    // says nothing about the file.
    expect(hasValidMediaExtension('https://x.test/jpg/h?name=orig')).toBe(false);
    expect(hasValidMediaExtension('https://x.test/h?name=jpg')).toBe(false);
    expect(hasValidMediaExtension('https://x.test/h?myformat=jpg')).toBe(false);
  });
});
