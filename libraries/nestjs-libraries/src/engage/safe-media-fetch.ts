import axios from 'axios';
import { isIP } from 'net';
import { lookup } from 'dns/promises';

/**
 * SSRF-guarded download of a third-party media URL, returning a `data:` URI
 * the storage layer can ingest directly (`uploadSimple` already parses that
 * shape — it is how the DALL-E upload path works).
 *
 * WHY THIS EXISTS, rather than handing the URL straight to
 * `storage.uploadSimple(url)`:
 *
 * `uploadSimple` does a bare `axios.get(path)` — no scheme check, no host
 * check, and redirects followed by default. That is fine for its existing
 * callers, whose URLs come from an OAuth'd platform API response or from our
 * own image generator. It is NOT fine for engage reference-media reuse
 * (docs/engage/reference-post-generation.md §6.1): those URLs originate in
 * `EngageOpportunity.rawData.mediaUrls`, which the browser extension scrapes
 * off third-party pages and ingests with only `@IsString()` validation
 * (`scan-ingest.dto.ts`). Until that feature existed those URLs were only
 * ever rendered client-side; fetching them *from the backend* turns a
 * hostile post author into an SSRF vector — `http://169.254.169.254/...`
 * (cloud instance metadata), `http://localhost:6379/...`, internal RFC1918
 * hosts — with the response body landing in the org's media library, i.e.
 * readable exfiltration.
 *
 * Guards, in order:
 *   1. http/https only (no file:, gopher:, etc.)
 *   2. host must not be a literal private/loopback/link-local IP
 *   3. host must not *resolve* to one (blocks `evil.com A 127.0.0.1`)
 *   4. redirects followed MANUALLY, re-running 1-3 on every hop — a
 *      pre-flight check alone is bypassable by a 302 from a public host
 *   5. hard byte cap + timeout (uploadSimple has neither, and buffers whole)
 *   6. response must declare an image/* or video/* content type
 *
 * This is a deliberate, auditable baseline — not a hardened egress proxy. It
 * does not defeat DNS rebinding (the resolve-then-connect gap is inherent
 * without a custom agent pinning the checked address). Treat it as raising
 * the bar for one specific untrusted-input path, and prefer a network-level
 * egress policy if this app ever fetches untrusted URLs more broadly.
 */

const MAX_REDIRECTS = 3;

/** Blocked IPv4 ranges, as [network, prefixLength]. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — cloud instance metadata lives here
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const value = v4ToInt(ip);
    if (value === null) return true; // unparseable → refuse
    return BLOCKED_V4.some(([network, bits]) => {
      const net = v4ToInt(network)!;
      const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === (net & mask) >>> 0;
    });
  }

  if (version === 6) {
    const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
    // IPv4-mapped (::ffff:127.0.0.1) — judge by the embedded v4 address.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
    if (/^ff/.test(normalized)) return true; // multicast
    return false;
  }

  return true; // not an IP at all → caller should have resolved first
}

/** Throws when `rawUrl` is not a safe, public http(s) target. */
async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported protocol ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`blocked address ${host}`);
    }
    return url;
  }

  const resolved = await lookup(host, { all: true });
  if (!resolved.length) {
    throw new Error(`could not resolve ${host}`);
  }
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new Error(`${host} resolves to blocked address ${address}`);
    }
  }
  return url;
}

export interface SafeFetchOptions {
  /** Hard cap on downloaded bytes. */
  maxBytes: number;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

/**
 * Fetch `rawUrl` under the guards described above and return it as a
 * `data:<contentType>;base64,<...>` URI. Throws on any guard violation, a
 * non-media content type, an oversized body, or a transport error — callers
 * are expected to treat a throw as "skip this one attachment".
 */
export async function fetchMediaAsDataUri(
  rawUrl: string,
  { maxBytes, timeoutMs }: SafeFetchOptions
): Promise<string> {
  let target = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertSafeUrl(target);

    const response = await axios.get(url.toString(), {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      // Followed by hand so every hop is re-validated — see guard 4.
      maxRedirects: 0,
      // 3xx must reach us rather than throwing, so we can re-validate the
      // Location. Everything else is a failure.
      validateStatus: (status) =>
        (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });

    if (response.status >= 300) {
      const location = response.headers?.['location'];
      if (!location) throw new Error(`redirect with no location`);
      // Relative redirects are legal; resolve against the current URL.
      target = new URL(location, url).toString();
      continue;
    }

    const contentType = String(
      response.headers?.['content-type'] ??
        response.headers?.['Content-Type'] ??
        ''
    )
      .split(';')[0]
      .trim()
      .toLowerCase();

    // Guard 6. Also closes the `mime.getExtension(undefined) || 'png'`
    // fallback in the storage layer, which would otherwise let a
    // content-type-less internal response be stored as a viewable ".png".
    if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
      throw new Error(`unexpected content-type "${contentType || 'none'}"`);
    }

    const buffer = Buffer.from(response.data);
    if (buffer.byteLength > maxBytes) {
      throw new Error(`body exceeds ${maxBytes} bytes`);
    }

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  throw new Error(`exceeded ${MAX_REDIRECTS} redirects`);
}
