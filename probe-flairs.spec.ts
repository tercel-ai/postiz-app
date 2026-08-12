// TEMPORARY one-off probe (delete after running).
// Question: can a subreddit's link-flair list be read WITHOUT OAuth, through the
// same loid + REDDIT_PROXY path the Engage scanner already uses?
// Runs under vitest so .env (REDDIT_PROXY) and the @gitroom aliases load.
// Never prints REDDIT_PROXY's value — only whether it is set.
import { describe, it } from 'vitest';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';

const SUB = process.env.PROBE_SUB || 'ClaudeAI';

const ENDPOINTS = [
  // Baseline: known-good in production. If this fails, nothing below is
  // evidence about the flair endpoints themselves.
  `https://www.reddit.com/r/${SUB}/about.json`,
  `https://www.reddit.com/r/${SUB}/api/link_flair_v2.json`,
  `https://www.reddit.com/r/${SUB}/api/link_flair.json`,
  `https://old.reddit.com/r/${SUB}/api/link_flair.json`,
];

function summarize(body: string): string {
  const head = body.slice(0, 140).replace(/\s+/g, ' ');
  const t = body.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return `NOT JSON (WAF/HTML) — ${head}`;
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json)) {
      const labels = json.map((f: any) => f?.text).filter((x: unknown) => typeof x === 'string');
      return `JSON array, ${json.length} entries; labels=${JSON.stringify(labels)}`;
    }
    return `JSON object, keys=${JSON.stringify(Object.keys(json).slice(0, 10))} — ${head}`;
  } catch {
    return `unparseable — ${head}`;
  }
}

describe('flair endpoint probe', () => {
  it(
    'reports reachability of each candidate endpoint',
    async () => {
      console.log(
        `\nREDDIT_PROXY set=${!!process.env.REDDIT_PROXY} ` +
          `HTTPS_PROXY set=${!!process.env.HTTPS_PROXY} ` +
          `REDIS_URL set=${!!process.env.REDIS_URL}\nsubreddit: r/${SUB}\n`
      );
      for (const url of ENDPOINTS) {
        try {
          const res = await redditPublicGet(url, {}, { log: (m) => console.log(`   ${m}`) });
          const body = await res.text();
          console.log(`[${res.status}] ${url}\n   ${summarize(body)}\n`);
        } catch (e: any) {
          console.log(`[ERR] ${url}\n   ${e?.message || e}\n`);
        }
      }
    },
    300_000
  );
});
