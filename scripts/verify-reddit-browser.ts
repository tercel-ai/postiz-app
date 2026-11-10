import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';

const REDDIT = 'https://www.reddit.com';
const TIMEOUT_MS = 15_000;
const SUBREDDIT_PATH = /^\/r\/([a-z\d_]{2,21})\/?$/i;
const COMMUNITY_LINK = /^\s*r\/[a-z\d_]{2,21}\b/i;
const EMPTY_SEARCH =
  /^(no (?:search )?results(?: found)?|we couldn.t find any (?:communities|results)(?: for.*)?)[.!]?$/i;
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
    current.pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, '')
  ) {
    throw new Error('Reddit redirected away from the requested page.');
  }
  if (
    await page
      .getByText(
        /^(you.ve been blocked by network security|whoa there, pardner!?)/i
      )
      .first()
      .isVisible()
  ) {
    throw new Error('Reddit displayed an access block.');
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

  const main = page.getByRole('main');
  const links = main
    .locator('a[href^="/r/"], a[href^="https://www.reddit.com/r/"]')
    .filter({ hasText: COMMUNITY_LINK });
  const empty = main.getByText(EMPTY_SEARCH).first();
  await links
    .first()
    .or(empty)
    .first()
    .waitFor({ state: 'visible' })
    .catch(() => {
      throw new Error(
        'No community results or recognized empty state appeared.'
      );
    });

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
      (await empty.isVisible())
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

      for (const [label, check] of [
        ['Communities search', () => searchCommunities(page, query)],
        ['Exact community', () => verifySubreddit(page, subreddit)],
      ] as const) {
        const started = Date.now();
        try {
          await check();
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message.split('\n')[0]
              : String(error);
          throw new Error(`${label}: ${message}`);
        } finally {
          console.log(`[${pass}] ${label} took ${Date.now() - started} ms`);
        }
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
