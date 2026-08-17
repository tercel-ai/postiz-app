/**
 * Backfill EngageOpportunity.title for rows stored BEFORE the column existed.
 *
 * Background — every scanner used to concatenate the post's title into
 * postContent, because there was nowhere else to put it. The title is now its
 * own column and the scanners send the two apart; that change is FORWARD-ONLY,
 * so rows scanned earlier still carry "title\nbody" in postContent with a null
 * title. This script splits them back apart.
 *
 * The split is only sound where the old shape used a NEWLINE as the joiner and
 * the platform's title cannot itself contain one:
 *
 *   reddit      `${title}\n${selftext}`      title is single-line, ≤300 chars
 *   hackernews  `${title}\n${story_text}`    title is single-line, ≤80 chars
 *   devto       `${title}\n${description}`   title is single-line
 *   medium      `${title}\n${contentSnippet}` title is single-line
 *
 * A body with NO newline at all is a link submission: headline only, empty body.
 *
 * DELIBERATELY EXCLUDED:
 *   - x, linkedin — no title concept, nothing was ever concatenated. Splitting
 *     one would invent a title out of the first line of a real post.
 *   - quora — the old shape joined question and answer with a SPACE, so there
 *     is no boundary to recover. --quora-heuristic opts into a question-mark
 *     guess for it; read its comment before using it, and check the dry-run
 *     sample first. Off by default: a WRONG title is worse than none, since it
 *     is shown to the user and fed to the reply drafter as "the question".
 *
 * IDEMPOTENT: only rows with title IS NULL are considered, and a successful run
 * leaves them non-null, so a second run finds nothing. Rows the split refuses
 * (see splitStoredTitle) stay null and are re-examined — and re-skipped — on
 * every run, which is the intended no-op rather than a retry.
 *
 * Read-only (dry-run) by DEFAULT. Pass --execute to write.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-title.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-title.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-title.ts --platform reddit,hackernews
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-title.ts --limit 200
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-title.ts --quora-heuristic          # inspect the sample
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-title.ts --quora-heuristic --execute
 */
import * as dotenv from 'dotenv';
dotenv.config();

process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';

/** Platforms whose old postContent joined title and body with a newline. */
export const NEWLINE_JOINED_PLATFORMS = [
  'reddit',
  'hackernews',
  'devto',
  'medium',
] as const;

/**
 * Longest first line still credible as a title. Every platform here caps its
 * title well below this (Reddit 300, dev.to 250, Medium ~100, HN 80), so a
 * longer first line means the body simply has no title in front of it — a
 * paragraph, not a headline — and must be left alone.
 */
export const MAX_TITLE_LEN = 400;

/** Quora heuristic bounds — see splitStoredTitle. */
const QUORA_MAX_QUESTION_LEN = 250;
const QUORA_MIN_ANSWER_LEN = 40;
const QUORA_MIN_QUESTION_LEN = 10;

export interface TitleSplit {
  title: string;
  postContent: string;
}

/**
 * Recover (title, body) from a stored postContent, or null when the row must be
 * left untouched. Pure — the caller decides what to write.
 *
 * `quoraHeuristic` opts into the one platform whose joiner was a space: it
 * treats the first "?" as the question boundary, and only when the question
 * looks like a question (long enough, not the whole body, with a real answer
 * left after it). Quora questions do end in "?" as a rule, but an answer may
 * contain one too, so this is a GUESS and stays opt-in.
 */
export function splitStoredTitle(
  platform: string,
  postContent: string,
  opts: { quoraHeuristic?: boolean } = {}
): TitleSplit | null {
  const body = (postContent ?? '').trim();
  if (!body) return null;

  if (platform === 'quora') {
    if (!opts.quoraHeuristic) return null;
    const q = body.indexOf('?');
    if (q < 0) return null;
    const title = body.slice(0, q + 1).trim();
    const rest = body.slice(q + 1).trim();
    if (title.length < QUORA_MIN_QUESTION_LEN) return null;
    if (title.length > QUORA_MAX_QUESTION_LEN) return null;
    if (rest.length < QUORA_MIN_ANSWER_LEN) return null;
    return { title, postContent: rest };
  }

  if (!NEWLINE_JOINED_PLATFORMS.includes(platform as never)) return null;

  const nl = body.indexOf('\n');
  // No newline: a link submission, whose whole stored body IS its title.
  const title = (nl < 0 ? body : body.slice(0, nl)).trim();
  const rest = nl < 0 ? '' : body.slice(nl + 1).trim();
  if (!title || title.length > MAX_TITLE_LEN) return null;
  return { title, postContent: rest };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
/** One-line preview of a possibly-multiline body. */
function preview(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

const PAGE = 500;

async function main(): Promise<void> {
  const execute = flag('execute');
  const quoraHeuristic = flag('quora-heuristic');
  const limit = Number(arg('limit') ?? 0) || Infinity;

  const supported = [
    ...NEWLINE_JOINED_PLATFORMS,
    ...(quoraHeuristic ? (['quora'] as const) : []),
  ];
  const requested = (arg('platform') ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((p) => !supported.includes(p as never));
  if (unknown.length) {
    console.error(
      `Unsupported --platform: ${unknown.join(', ')}. ` +
        `Supported: ${supported.join(', ')}` +
        (unknown.includes('quora') ? ' (quora needs --quora-heuristic)' : '')
    );
    process.exit(1);
  }
  const platforms = requested.length ? requested : [...supported];

  const prisma = new PrismaClient();
  try {
    console.log(
      `Backfilling EngageOpportunity.title | platforms=${platforms.join(',')} | ` +
        `${execute ? 'EXECUTE' : 'dry-run'}${quoraHeuristic ? ' | quora-heuristic ON' : ''}`
    );

    const updated = new Map<string, number>();
    const skipped = new Map<string, number>();
    const samples: string[] = [];
    let scanned = 0;
    // Paginate by id, not by "the next page of title IS NULL": in --execute the
    // rows drop out of that filter as they are written, and in dry-run they
    // never do — an offset/refetch loop would skip half the table in one mode
    // and spin forever in the other.
    let cursor: string | undefined;

    for (;;) {
      const rows = await prisma.engageOpportunity.findMany({
        where: { title: null, platform: { in: platforms } },
        select: { id: true, platform: true, externalPostUrl: true, postContent: true },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        if (scanned >= limit) break;
        scanned++;
        const split = splitStoredTitle(row.platform, row.postContent, {
          quoraHeuristic,
        });
        if (!split) {
          skipped.set(row.platform, (skipped.get(row.platform) ?? 0) + 1);
          continue;
        }
        updated.set(row.platform, (updated.get(row.platform) ?? 0) + 1);
        if (samples.length < 20) {
          samples.push(
            `[${row.platform}] ${row.externalPostUrl}\n` +
              `      title: ${preview(split.title)}\n` +
              `      body:  ${preview(split.postContent) || '(empty — link post)'}`
          );
        }
        if (execute) {
          await prisma.engageOpportunity.update({
            where: { id: row.id },
            // Title and body are written together: leaving postContent as-is
            // would duplicate the title across both fields.
            data: { title: split.title, postContent: split.postContent },
          });
        }
      }
      if (scanned >= limit) break;
    }

    const sum = (m: Map<string, number>) =>
      Array.from(m.values()).reduce((a, b) => a + b, 0);
    console.log(`\n── ${execute ? 'Applied' : 'Would apply'} ${sum(updated)} update(s) ──`);
    for (const s of samples) console.log('  ' + s);
    if (sum(updated) > samples.length) {
      console.log(`  … and ${sum(updated) - samples.length} more`);
    }
    console.log('\nSummary (title IS NULL rows examined):');
    for (const p of platforms) {
      console.log(
        `  ${p.padEnd(12)} ${execute ? 'updated' : 'would-update'}=${updated.get(p) ?? 0}` +
          `  left-alone=${skipped.get(p) ?? 0}`
      );
    }
    console.log(`  ${'TOTAL'.padEnd(12)} scanned=${scanned}  skipped=${sum(skipped)}`);
    if (!quoraHeuristic) {
      console.log(
        '\nquora rows are NOT touched: its old shape joined question and answer ' +
          'with a space, so there is no boundary to recover. --quora-heuristic ' +
          'guesses one from the first "?" — inspect a dry run before writing.'
      );
    }
    if (!execute && sum(updated)) {
      console.log('\nRe-run with --execute to write these changes.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
