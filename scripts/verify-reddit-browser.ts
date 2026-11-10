import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { chromium, type Page, type Response } from 'playwright';

const REDDIT = 'https://www.reddit.com';
const TIMEOUT_MS = 15_000;
const SUBREDDIT_PATH = /^\/r\/([a-z\d_]{2,21})\/?$/i;
const MAIN_CONTENT = 'main, [role="main"], #main-content';
const COMMUNITY_LINK = 'a[href^="/r/"], a[href^="https://www.reddit.com/r/"]';
const EMPTY_SEARCH =
  /^(no (?:search )?results(?: found)?|we couldn.t find (?:any (?:communities|results)|a match)(?: for.*)?)[.!]?$/i;
const ACCESS_BLOCK =
  /^(?:(?:you.ve been|your request has been) blocked (?:due to|by) (?:network security|a network policy)|whoa there, pardner|checking your browser|verify (?:that )?you(?: are|.re) human)/i;
const USAGE = `Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/verify-reddit-browser.ts [query] [subreddit] [options]

  Defaults: query=aiagents, subreddit=aiagents
  --profile <path>  Dedicated persistent Chromium profile
  --headed          Show Chromium on a machine with a graphical session
  --login           Open the login page and wait for manual login; implies --headed
  --proxy           Use REDDIT_PROXY from the process environment
  --help            Show this help

Without --proxy, Chromium connects directly. Exit 0 means both UI checks passed
before and after reopening Chromium. Exit 1 means verification failed.`;

function getProxy() {
  const value = process.env.REDDIT_PROXY;
  if (!value)
    throw new Error('--proxy requires REDDIT_PROXY in the environment.');

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      throw new Error('Invalid proxy protocol or hostname.');
    }
    return {
      server: `${url.protocol}//${url.host}`,
      username: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
    };
  } catch {
    throw new Error('REDDIT_PROXY must be a valid HTTP or HTTPS proxy URL.');
  }
}

async function openRedditPage(page: Page, url: URL) {
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const status = response?.status();
  const current = new URL(page.url());
  console.log(
    `[HTTP] ${status ?? 'unknown'} ${current.origin}${current.pathname}`
  );
  if (status === 403 || status === 429)
    throw new Error(`Reddit returned HTTP ${status}.`);
  if (
    current.pathname.startsWith('/login') ||
    current.hostname === 'accounts.reddit.com'
  ) {
    throw new Error('Reddit requires login.');
  }
  if (!response?.ok())
    throw new Error(`Unexpected HTTP status ${status ?? 'unknown'}.`);
  if (
    current.origin !== REDDIT ||
    current.pathname.replace(/\/$/, '').toLowerCase() !==
      url.pathname.replace(/\/$/, '').toLowerCase()
  ) {
    throw new Error('Reddit redirected away from the requested page.');
  }
  if (await page.getByText(ACCESS_BLOCK).filter({ visible: true }).count()) {
    throw new Error('Reddit displayed an access block or browser challenge.');
  }
}

async function searchCommunities(page: Page, query: string) {
  const url = new URL('/search/', REDDIT);
  url.search = new URLSearchParams({
    q: query,
    type: 'communities',
  }).toString();
  await openRedditPage(page, url);
  if (new URL(page.url()).searchParams.get('type') !== 'communities') {
    throw new Error('Reddit did not open the Communities search tab.');
  }

  // Search cards can link a display title such as "Python" to /r/Python/.
  const links = page
    .locator(MAIN_CONTENT)
    .locator(COMMUNITY_LINK)
    .filter({ visible: true });
  const empty = page.getByText(EMPTY_SEARCH).filter({ visible: true });
  const block = page.getByText(ACCESS_BLOCK).filter({ visible: true });
  await links
    .first()
    .or(empty)
    .or(block)
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {
      throw new Error(
        'No community results or recognized empty state appeared.'
      );
    });
  if (await block.count()) {
    throw new Error('Reddit displayed an access block or browser challenge.');
  }

  const communities = new Map<string, string>();
  for (const href of await links.evaluateAll((items) =>
    items.map((item) => item.getAttribute('href'))
  )) {
    if (!href) continue;
    const name = SUBREDDIT_PATH.exec(new URL(href, REDDIT).pathname)?.[1];
    if (name) communities.set(name.toLowerCase(), name);
  }
  if (!communities.size) {
    throw new Error(
      (await empty.count())
        ? 'Reddit showed an empty search result.'
        : 'No valid subreddit links were found.'
    );
  }

  const names = [...communities.values()].slice(0, 10);
  console.log(
    `[PASS] Communities search returned ${communities.size}: ${names
      .map((name) => `r/${name}`)
      .join(', ')}`
  );
}

async function verifySubreddit(page: Page, subreddit: string) {
  await openRedditPage(page, new URL(`/r/${subreddit}/`, REDDIT));
  const heading = page.getByRole('heading', {
    name: new RegExp(`^(?:r/)?${subreddit}$`, 'i'),
  });
  await heading
    .or(page.locator('shreddit-subreddit-header'))
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {
      throw new Error(
        'The requested page did not show a recognizable community header.'
      );
    });
  console.log(`[PASS] Exact community opened: r/${subreddit}`);
}

async function runCheck(
  page: Page,
  pass: string,
  label: string,
  check: () => Promise<void>
) {
  const started = Date.now();
  const failedRequests = new Set<string>();
  const onResponse = (response: Response) => {
    if (
      response.status() < 400 ||
      !['fetch', 'xhr'].includes(response.request().resourceType())
    )
      return;
    const url = new URL(response.url());
    if (url.origin === REDDIT && failedRequests.size < 5) {
      failedRequests.add(`${response.status()} ${url.pathname}`);
    }
  };
  page.on('response', onResponse);
  try {
    await check();
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.error(`[FAIL] ${label}: ${message}`);
    const [title, mainLinks, pageLinks] = await Promise.all([
      page.title().catch(() => '(unavailable)'),
      page
        .locator(MAIN_CONTENT)
        .locator(COMMUNITY_LINK)
        .filter({ visible: true })
        .count()
        .catch(() => -1),
      page
        .locator(COMMUNITY_LINK)
        .filter({ visible: true })
        .count()
        .catch(() => -1),
    ]);
    console.log(
      `[page] title=${JSON.stringify(
        title.slice(0, 120)
      )} visibleRedditLinks=${mainLinks} in main, ${pageLinks} total`
    );
    if (failedRequests.size)
      console.log(
        `[page] Failed Reddit data requests: ${[...failedRequests].join(', ')}`
      );
    return false;
  } finally {
    page.off('response', onResponse);
    console.log(`[${pass}] ${label} took ${Date.now() - started} ms`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      headed: { type: 'boolean' },
      login: { type: 'boolean' },
      proxy: { type: 'boolean' },
      profile: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(USAGE);

  const [rawQuery = 'aiagents', rawSubreddit = 'aiagents'] = positionals;
  const query = rawQuery.trim();
  const subreddit = rawSubreddit.trim().replace(/^\/?r\//i, '');
  if (
    positionals.length > 2 ||
    !query ||
    !SUBREDDIT_PATH.test(`/r/${subreddit}/`)
  ) {
    throw new Error(
      'Provide a nonempty query and a valid exact subreddit name. See --help.'
    );
  }
  if (values.login && !process.stdin.isTTY)
    throw new Error('--login requires an interactive terminal.');

  const profile = resolve(
    values.profile ??
      join(homedir(), '.local', 'state', 'postiz', 'reddit-browser')
  );
  const proxy = values.proxy ? getProxy() : undefined;
  await mkdir(profile, { recursive: true, mode: 0o700 });
  console.log(
    `Reddit browser probe | query=${JSON.stringify(
      query
    )} | exact=r/${subreddit} | route=${proxy ? 'proxy' : 'direct'}`
  );

  let authenticated = false;
  for (const pass of ['initial', 'reopened']) {
    console.log(`[${pass}] Starting Chromium`);
    const context = await chromium.launchPersistentContext(profile, {
      headless: !values.headed && !(values.login && pass === 'initial'),
      locale: 'en-US',
      proxy,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(TIMEOUT_MS);
      if (values.login && pass === 'initial') {
        await page.goto(`${REDDIT}/login/`, { waitUntil: 'domcontentloaded' });
        const prompt = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          await prompt.question(
            'Log in in Chromium, then press Enter here to continue. '
          );
        } finally {
          prompt.close();
        }
      }

      const searchPassed = await runCheck(
        page,
        pass,
        'Communities search',
        () => searchCommunities(page, query)
      );
      const exactPassed = await runCheck(page, pass, 'Exact community', () =>
        verifySubreddit(page, subreddit)
      );
      if (!searchPassed || !exactPassed) {
        throw new Error(
          `[${pass}] Search ${
            searchPassed ? 'passed' : 'failed'
          }; exact lookup ${exactPassed ? 'passed' : 'failed'}.`
        );
      }

      const userMenu = page
        .getByRole('button', { name: /^(open )?(user|profile) menu$/i })
        .first();
      const signedIn = await userMenu.isVisible();
      if ((values.login || authenticated) && !signedIn) {
        throw new Error(
          'The signed-in user menu was not visible. Login reuse could not be confirmed.'
        );
      }
      authenticated = signedIn;
      console.log(
        `[${pass}] Sign-in: ${signedIn ? 'confirmed' : 'unconfirmed'}`
      );
    } finally {
      await context.close();
    }
  }
  console.log(
    `[PASS] Search and exact lookup worked after reopening the profile. Login reuse: ${
      authenticated ? 'confirmed' : 'unconfirmed'
    }.`
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message.split('\n')[0] : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
