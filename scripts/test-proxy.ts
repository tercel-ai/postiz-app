/**
 * Proxy connectivity tester.
 *
 * Verifies that the configured HTTPS_PROXY (or a URL passed as argv) works by
 * routing requests through undici's ProxyAgent and printing the exit IP. Also
 * normalizes the common `host:port:user:pass` panel format into a valid proxy
 * URL, since undici's ProxyAgent throws "Invalid URL" on the former.
 *
 * Usage:
 *   npx tsx scripts/test-proxy.ts                         # reads HTTPS_PROXY / HTTP_PROXY from env
 *   npx tsx scripts/test-proxy.ts "<proxy-url>"           # tests an explicit value
 *   npx tsx scripts/test-proxy.ts "<proxy-url>" --direct  # also prints a direct-control result
 */
import { setDefaultResultOrder } from 'node:dns';
import { performance } from 'node:perf_hooks';
import { ProxyAgent, request } from 'undici';

const DEFAULT_TARGETS = [
  'https://api.ipify.org?format=json',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
];

interface CliOptions {
  proxy?: string;
  direct: boolean;
  family: 4 | 6 | 0;
  rounds: number;
  timeoutMs: number;
  targets: string[];
}

interface ProbeResult {
  ok: boolean;
  label: string;
  url: string;
  status?: number;
  ip?: string;
  elapsedMs: number;
  error?: string;
  code?: string;
  body?: string;
}

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    direct: false,
    family: 4,
    rounds: 2,
    timeoutMs: 10000,
    targets: [...DEFAULT_TARGETS],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--direct') {
      options.direct = true;
      continue;
    }
    if (arg === '--ipv6') {
      options.family = 6;
      continue;
    }
    if (arg === '--any-family') {
      options.family = 0;
      continue;
    }
    if (arg === '--rounds') {
      options.rounds = Math.max(1, Number(argv[++i] || 1));
      continue;
    }
    if (arg === '--timeout') {
      options.timeoutMs = Math.max(1000, Number(argv[++i] || 10000));
      continue;
    }
    if (arg === '--target') {
      const target = argv[++i];
      if (target) options.targets = [target];
      continue;
    }
    if (!options.proxy) {
      options.proxy = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

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

function extractIp(text: string): string | null {
  const trimmed = text.trim();
  try {
    const json = JSON.parse(trimmed);
    if (typeof json?.ip === 'string') return json.ip;
  } catch {
    /* plain-text IP endpoints fall through */
  }

  const match = trimmed.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|[a-f0-9:]{3,}/i);
  return match?.[0] ?? null;
}

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

function createProxyAgent(proxyUrl: string, options: CliOptions): ProxyAgent {
  const connectOptions =
    options.family === 0
      ? { timeout: options.timeoutMs }
      : { timeout: options.timeoutMs, family: options.family };

  return new ProxyAgent({
    uri: proxyUrl,
    proxyTls: connectOptions,
    requestTls: { timeout: options.timeoutMs },
  });
}

async function probeIp(
  label: string,
  url: string,
  timeoutMs: number,
  agent?: ProxyAgent
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const { statusCode, body } = await request(url, {
      dispatcher: agent,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const text = await body.text();
    const elapsedMs = Math.round(performance.now() - started);
    if (statusCode !== 200) {
      return {
        ok: false,
        label,
        url,
        status: statusCode,
        elapsedMs,
        body: text.slice(0, 160).replace(/\s+/g, ' '),
      };
    }
    return {
      ok: true,
      label,
      url,
      status: statusCode,
      ip: extractIp(text) ?? text.trim().slice(0, 80),
      elapsedMs,
    };
  } catch (err) {
    return {
      ok: false,
      label,
      url,
      elapsedMs: Math.round(performance.now() - started),
      error: (err as Error).message,
      code: errorCode(err),
    };
  }
}

function printResult(result: ProbeResult): void {
  const origin = new URL(result.url).hostname;
  const elapsed = `${result.elapsedMs}ms`.padStart(7);
  if (result.ok) {
    console.log(`  ${result.label.padEnd(11)} ${origin.padEnd(16)} ${elapsed}  ${result.ip}`);
    return;
  }

  const status = result.status ? `HTTP ${result.status}` : 'FAILED';
  const detail = result.error || result.body || '';
  const code = result.code ? `${result.code}: ` : '';
  console.log(`  ${result.label.padEnd(11)} ${origin.padEnd(16)} ${elapsed}  ${status} — ${code}${detail}`);
}

async function main() {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const raw = options.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  if (!raw) {
    console.error('No proxy provided. Set HTTPS_PROXY/HTTP_PROXY or pass a URL as the first argument.');
    process.exit(1);
  }

  const normalized = normalizeProxyUrl(raw);

  console.log('=== Proxy Test ===');
  console.log('Raw input   :', maskProxyUrl(raw));
  console.log('Normalized  :', maskProxyUrl(normalized));
  console.log('DNS family  :', options.family === 4 ? 'ipv4-first' : options.family === 6 ? 'ipv6' : 'system default');
  console.log('Rounds      :', options.rounds);
  console.log('Timeout     :', `${options.timeoutMs}ms`);
  console.log('Direct check:', options.direct ? 'yes' : 'no (use --direct to compare)');

  if (options.family === 4) {
    setDefaultResultOrder('ipv4first');
  }

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
    agent = createProxyAgent(normalized, options);
  } catch (err) {
    console.error('\n❌ ProxyAgent construction failed:', (err as Error).message);
    process.exit(1);
  }

  console.log('\n--- Exit IP checks ---');
  console.log('  route       target             elapsed  result');

  const proxyResults: ProbeResult[] = [];
  const directResults: ProbeResult[] = [];

  try {
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const target of options.targets) {
        if (options.direct) {
          const direct = await probeIp(`direct #${round}`, target, options.timeoutMs);
          directResults.push(direct);
          printResult(direct);
        }

        const proxied = await probeIp(`proxy #${round}`, target, options.timeoutMs, agent);
        proxyResults.push(proxied);
        printResult(proxied);
      }
    }
  } finally {
    await agent.close().catch(() => undefined);
  }

  console.log('\n--- Result ---');
  const okProxyResults = proxyResults.filter((r) => r.ok);
  if (okProxyResults.length > 0) {
    const ips = Array.from(new Set(okProxyResults.map((r) => r.ip).filter(Boolean)));
    const okCount = okProxyResults.length;
    const total = proxyResults.length;
    const fastest = Math.min(...okProxyResults.map((r) => r.elapsedMs));
    const slowest = Math.max(...okProxyResults.map((r) => r.elapsedMs));
    console.log(`✅ Proxy usable: ${okCount}/${total} checks passed; exit IP(s): ${ips.join(', ')}`);
    console.log(`   Latency range through proxy: ${fastest}ms..${slowest}ms`);

    const directIps = new Set(directResults.filter((r) => r.ok).map((r) => r.ip));
    if (ips.some((ip) => ip && directIps.has(ip))) {
      console.log('⚠️  At least one proxy exit IP equals the direct IP — verify the proxy endpoint and credentials.');
    }
    process.exit(0);
  }

  const failures = proxyResults
    .map((r) => r.code || (r.status ? `HTTP ${r.status}` : r.error))
    .filter(Boolean);
  console.log(`❌ Proxy checks failed: 0/${proxyResults.length} passed.`);
  if (failures.length) {
    console.log(`   Failure summary: ${Array.from(new Set(failures)).join(', ')}`);
  }
  console.log('   Compare with: curl -4 -x "' + maskProxyUrl(normalized) + '" https://api.ipify.org?format=json');
  process.exit(1);
}

main();
