/**
 * Proxy connectivity tester.
 *
 * Verifies that the configured HTTPS_PROXY (or a URL passed as argv) actually
 * works by routing a request through undici's ProxyAgent and printing the exit
 * IP. Also normalizes the common `host:port:user:pass` panel format into a valid
 * proxy URL, since undici's ProxyAgent throws "Invalid URL" on the former.
 *
 * Usage:
 *   npx tsx scripts/test-proxy.ts                 # reads HTTPS_PROXY / HTTP_PROXY from env
 *   npx tsx scripts/test-proxy.ts "<proxy-url>"   # tests an explicit value
 */
import { ProxyAgent, request } from 'undici';

/**
 * Accepts either a valid proxy URL (scheme://user:pass@host:port) or the panel
 * format host:port:user:pass and returns a URL undici can parse.
 */
function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();

  // Already a URL with a scheme — try to parse as-is first.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
      return trimmed;
    } catch {
      // Fall through: scheme present but body is host:port:user:pass.
    }
  }

  const scheme = (trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1] ?? 'http').toLowerCase();
  const body = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  // If it already has credentials embedded (user:pass@host:port), keep as-is.
  if (body.includes('@')) {
    return `${scheme}://${body}`;
  }

  const parts = body.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  if (parts.length === 2) {
    // host:port with no auth
    return `${scheme}://${body}`;
  }

  // Unknown shape — hand it back untouched and let ProxyAgent report the error.
  return `${scheme}://${body}`;
}

/** Masks the password in a proxy URL so it is safe to log. */
function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

async function checkIp(label: string, agent?: ProxyAgent): Promise<string | null> {
  try {
    const { statusCode, body } = await request('https://api.ipify.org?format=json', {
      dispatcher: agent,
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    const text = await body.text();
    if (statusCode !== 200) {
      console.log(`  ${label}: HTTP ${statusCode} — ${text}`);
      return null;
    }
    const ip = JSON.parse(text).ip as string;
    console.log(`  ${label}: ${ip}`);
    return ip;
  } catch (err) {
    console.log(`  ${label}: FAILED — ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  const raw = process.argv[2] || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  if (!raw) {
    console.error('No proxy provided. Set HTTPS_PROXY/HTTP_PROXY or pass a URL as the first argument.');
    process.exit(1);
  }

  const normalized = normalizeProxyUrl(raw);

  console.log('=== Proxy Test ===');
  console.log('Raw input   :', maskProxyUrl(raw));
  console.log('Normalized  :', maskProxyUrl(normalized));

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (err) {
    console.error('\n❌ Normalized value is still not a valid URL:', (err as Error).message);
    console.error('   Expected format: http://username:password@host:port');
    process.exit(1);
  }
  console.log('Parsed parts: host=%s port=%s user=%s', parsed.hostname, parsed.port, parsed.username || '(none)');

  let agent: ProxyAgent;
  try {
    agent = new ProxyAgent(normalized);
  } catch (err) {
    console.error('\n❌ ProxyAgent construction failed:', (err as Error).message);
    process.exit(1);
  }

  console.log('\n--- Exit IP check ---');
  const directIp = await checkIp('direct  ', undefined);
  const proxyIp = await checkIp('via proxy', agent);

  console.log('\n--- Result ---');
  if (proxyIp) {
    if (directIp && proxyIp === directIp) {
      console.log('⚠️  Proxy responded but exit IP equals the direct IP — traffic may not be going through the proxy.');
    } else {
      console.log(`✅ Proxy is working. Exit IP: ${proxyIp}` + (directIp ? ` (direct: ${directIp})` : ''));
    }
    process.exit(0);
  } else {
    console.log('❌ Proxy is NOT usable. See the error above.');
    process.exit(1);
  }
}

main();
