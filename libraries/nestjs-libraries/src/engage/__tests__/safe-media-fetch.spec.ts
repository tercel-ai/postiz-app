import { describe, it, expect, vi, beforeEach } from 'vitest';

const axiosGet = vi.fn();
vi.mock('axios', () => ({
  default: { get: (...args: any[]) => axiosGet(...args) },
}));

const dnsLookup = vi.fn();
vi.mock('dns/promises', () => ({
  lookup: (...args: any[]) => dnsLookup(...args),
}));

import { fetchMediaAsDataUri, isBlockedAddress } from '../safe-media-fetch';

// Guards the SSRF surface introduced by engage reference-media reuse: those
// URLs are scraped third-party page content, so a hostile post author would
// otherwise get a server-side fetch primitive. See safe-media-fetch.ts.

function mediaResponse(contentType = 'image/jpeg', body = 'hello') {
  return {
    status: 200,
    headers: { 'content-type': contentType },
    data: Buffer.from(body),
  };
}

const OPTS = { maxBytes: 1024, timeoutMs: 1000 };

beforeEach(() => {
  axiosGet.mockReset();
  dnsLookup.mockReset();
  dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'cloud instance metadata'],
    ['10.1.2.3', 'RFC1918 /8'],
    ['172.16.0.1', 'RFC1918 /12'],
    ['172.31.255.255', 'RFC1918 /12 upper bound'],
    ['192.168.1.1', 'RFC1918 /16'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'CGNAT'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['93.184.216.34', 'public v4'],
    ['8.8.8.8', 'public v4'],
    ['172.32.0.1', 'just outside RFC1918 /12'],
    ['2606:2800:220:1:248:1893:25c8:1946', 'public v6'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('fetchMediaAsDataUri — scheme and host guards', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://example.com/',
    'ftp://example.com/x.jpg',
  ])('refuses non-http(s) scheme: %s', async (url) => {
    await expect(fetchMediaAsDataUri(url, OPTS)).rejects.toThrow(
      /unsupported protocol/
    );
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('refuses a literal private IP without resolving or fetching', async () => {
    await expect(
      fetchMediaAsDataUri('http://169.254.169.254/latest/meta-data/', OPTS)
    ).rejects.toThrow(/blocked address/);
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('refuses a public hostname that RESOLVES to a private IP', async () => {
    dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      fetchMediaAsDataUri('https://evil.example/x.jpg', OPTS)
    ).rejects.toThrow(/resolves to blocked address/);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('refuses when ANY resolved address is private (multi-record DNS)', async () => {
    dnsLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);

    await expect(
      fetchMediaAsDataUri('https://evil.example/x.jpg', OPTS)
    ).rejects.toThrow(/resolves to blocked address/);
  });

  it('fetches a normal public URL', async () => {
    axiosGet.mockResolvedValue(mediaResponse('image/jpeg', 'abc'));

    const uri = await fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS);

    expect(uri).toBe(`data:image/jpeg;base64,${Buffer.from('abc').toString('base64')}`);
  });

  it('never lets axios follow redirects on its own', async () => {
    axiosGet.mockResolvedValue(mediaResponse());

    await fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS);

    expect(axiosGet.mock.calls[0][1]).toMatchObject({ maxRedirects: 0 });
  });
});

describe('fetchMediaAsDataUri — redirect handling', () => {
  it('re-validates each hop, blocking a public → private redirect', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      data: Buffer.alloc(0),
    });

    await expect(
      fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS)
    ).rejects.toThrow(/blocked address/);
    // The second hop must never be requested.
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('follows a legitimate public redirect', async () => {
    axiosGet
      .mockResolvedValueOnce({
        status: 301,
        headers: { location: 'https://cdn2.example/real.jpg' },
        data: Buffer.alloc(0),
      })
      .mockResolvedValueOnce(mediaResponse('image/png', 'png-bytes'));

    const uri = await fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS);

    expect(uri).toContain('data:image/png;base64,');
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  it('resolves a relative redirect against the current URL', async () => {
    axiosGet
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: '/moved/real.jpg' },
        data: Buffer.alloc(0),
      })
      .mockResolvedValueOnce(mediaResponse());

    await fetchMediaAsDataUri('https://cdn.example/a/x.jpg', OPTS);

    expect(axiosGet.mock.calls[1][0]).toBe('https://cdn.example/moved/real.jpg');
  });

  it('gives up after too many redirects rather than looping', async () => {
    axiosGet.mockResolvedValue({
      status: 302,
      headers: { location: 'https://cdn.example/loop.jpg' },
      data: Buffer.alloc(0),
    });

    await expect(
      fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS)
    ).rejects.toThrow(/exceeded \d+ redirects/);
  });

  it('rejects a redirect with no Location header', async () => {
    axiosGet.mockResolvedValue({
      status: 302,
      headers: {},
      data: Buffer.alloc(0),
    });

    await expect(
      fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS)
    ).rejects.toThrow(/redirect with no location/);
  });
});

describe('fetchMediaAsDataUri — response guards', () => {
  it.each([
    ['text/html', 'an HTML error/portal page'],
    ['application/json', 'a JSON API response'],
    ['text/plain', 'a plaintext metadata response'],
    ['', 'no content-type at all'],
  ])('refuses content-type %s (%s)', async (contentType) => {
    axiosGet.mockResolvedValue({
      status: 200,
      headers: contentType ? { 'content-type': contentType } : {},
      data: Buffer.from('secret'),
    });

    await expect(
      fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS)
    ).rejects.toThrow(/unexpected content-type/);
  });

  it('accepts video as well as image', async () => {
    axiosGet.mockResolvedValue(mediaResponse('video/mp4', 'movie'));

    const uri = await fetchMediaAsDataUri('https://cdn.example/x.mp4', OPTS);
    expect(uri).toContain('data:video/mp4;base64,');
  });

  it('strips content-type parameters', async () => {
    axiosGet.mockResolvedValue(mediaResponse('image/jpeg; charset=binary', 'x'));

    const uri = await fetchMediaAsDataUri('https://cdn.example/x.jpg', OPTS);
    expect(uri.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('passes the byte cap and timeout down to axios', async () => {
    axiosGet.mockResolvedValue(mediaResponse());

    await fetchMediaAsDataUri('https://cdn.example/x.jpg', {
      maxBytes: 4096,
      timeoutMs: 5000,
    });

    expect(axiosGet.mock.calls[0][1]).toMatchObject({
      maxContentLength: 4096,
      maxBodyLength: 4096,
      timeout: 5000,
    });
  });

  it('refuses an oversized body even if axios let it through', async () => {
    axiosGet.mockResolvedValue(mediaResponse('image/jpeg', 'x'.repeat(50)));

    await expect(
      fetchMediaAsDataUri('https://cdn.example/x.jpg', {
        maxBytes: 10,
        timeoutMs: 1000,
      })
    ).rejects.toThrow(/exceeds 10 bytes/);
  });
});
