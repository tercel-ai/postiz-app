/**
 * Proof-of-concept: can a real Chromium (Playwright) reach Reddit's data
 * endpoints that block curl/undici with a 403 anti-bot page?
 *
 * Strategy: launch a real browser, visit reddit.com to pick up cookies +
 * present a genuine TLS/HTTP2 fingerprint, then call the JSON API from INSIDE
 * the page context (page.evaluate -> fetch) so it inherits that fingerprint.
 *
 * Usage:
 *   node scripts/test-reddit-playwright.mjs mba
 *   PROXY=http://user:pass@host:port node scripts/test-reddit-playwright.mjs mba
 *   HEADFUL=1 node scripts/test-reddit-playwright.mjs mba   # watch it run
 */
import { chromium } from 'playwright';

const QUERY = process.argv[2] || 'mba';
const PROXY = process.env.PROXY || process.env.REDDIT_PROXY || process.env.HTTPS_PROXY;

function parseProxy(raw) {
  if (!raw) return undefined;
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

const main = async () => {
  const proxy = parseProxy(PROXY);
  console.log('=== Reddit via Playwright ===');
  console.log('query:', QUERY);
  console.log('proxy:', proxy ? `${proxy.server} (user=${proxy.username ? 'set' : 'none'})` : '(none, direct)');

  const browser = await chromium.launch({
    headless: !process.env.HEADFUL,
    proxy,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });

  // Basic stealth: hide the automation fingerprints Reddit's anti-bot checks.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // chrome runtime object present in real Chrome
    window.chrome = window.chrome || { runtime: {} };
  });

  const page = await context.newPage();

  try {
    // 1. Establish a real session by loading the homepage (cookies + warm-up).
    const home = await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('\n[1] homepage status:', home?.status());
    // Give Reddit's anti-bot JS challenge time to run and set its clearance cookie.
    await page.waitForTimeout(4000);

    // 2. Navigate directly to the JSON endpoint so the request goes through the
    //    real Chromium network stack (real TLS/HTTP2 fingerprint + cookies).
    const searchUrl = `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(QUERY)}&limit=10&type=sr`;
    const resp = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp?.status();
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    console.log('\n[2] subreddits/search.json status:', status, 'len:', body.length);

    if (status === 200) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const kids = parsed?.data?.children ?? [];
      console.log('    children:', kids.length);
      for (const c of kids.slice(0, 10)) {
        console.log(`      r/${c.data.display_name}  subs=${c.data.subscribers}`);
      }
      console.log(kids.length ? '\n✅ SUCCESS — Playwright bypassed the block and got subreddits.' : '\n⚠️ 200 but no results (try another query).');
    } else {
      console.log('    body head:', body.slice(0, 200));
      console.log('\n❌ Still blocked (status ' + status + ').');
    }
  } catch (err) {
    console.log('\n❌ ERROR:', err.message);
  } finally {
    await browser.close();
  }
};

main();
