import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { normalizeUsername } from '../engage-scan-lease.service';

/**
 * TS ↔ SQL normalisation parity.
 *
 * The scan-target merge made `EngageTrackedAccount.username` the canonical
 * scan-unit key, and TWO implementations now produce it:
 *   - normalizeUsername()            (engage-scan-lease.service.ts) — the app
 *   - engage_normalize_target_key()  (the merge migration)          — the backfill
 *
 * The migration DECLARES they are identical, and its backfill, collision audits
 * and cursor reconciliation all key off the SQL one. For any input the two
 * disagree on, the row is stored and its cursor moved under the SQL key while
 * the running app enumerates the unit under the TS key — that subreddit is then
 * rescanned from scratch forever and its old cursor is orphaned, with no error.
 *
 * Nothing executed both until this spec. It loads the function definition
 * straight out of the migration file (so it cannot test a stale copy) and
 * asserts byte equality across the inputs that actually differentiate the two
 * pipelines.
 *
 * Requires a reachable Postgres (DATABASE_URL). Skipped when absent so the
 * suite still runs on a machine without one — an explicitly reported skip, not
 * a silent pass.
 */

const MIGRATION = join(
  __dirname,
  '../../database/prisma/migrations/merge-monitored-channel-into-tracked-account.sql'
);

/**
 * Every `CREATE OR REPLACE FUNCTION … AS $$ … $$;` block in the migration, in
 * file order (so a helper defined before its caller installs first). Extracting
 * ALL of them — rather than naming one — keeps the spec working when the
 * normaliser is decomposed, which is exactly what happened when the trim step
 * moved into its own function.
 */
function extractFunctionDdl(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const blocks: string[] = [];
  const marker = 'CREATE OR REPLACE FUNCTION ';
  let from = 0;

  for (;;) {
    const start = sql.indexOf(marker, from);
    if (start === -1) break;
    const bodyStart = sql.indexOf('AS $$', start);
    if (bodyStart === -1) throw new Error('Function without a dollar-quoted body.');
    const end = sql.indexOf('$$;', bodyStart + 'AS $$'.length);
    if (end === -1) throw new Error('Unterminated function body in the migration.');
    blocks.push(sql.slice(start, end + 3));
    from = end + 3;
  }

  if (!blocks.some((b) => b.includes('engage_normalize_target_key'))) {
    throw new Error(
      'engage_normalize_target_key not found in the migration — did it get renamed? ' +
        'This spec exists to pin it; update the extractor rather than deleting the test.'
    );
  }
  return blocks;
}

// Inputs chosen to exercise every step the two pipelines perform, plus the
// classes where a naive SQL port drifts. Each is [platform, rawKey].
const CASES: Array<[string, string]> = [
  // Plain values — must be untouched apart from case folding.
  ['reddit', 'askreddit'],
  ['reddit', 'AskReddit'],
  ['x', 'alice'],
  // Prefix stripping.
  ['reddit', 'r/AskReddit'],
  ['reddit', '/r/AskReddit'],
  ['reddit', 'u/alice'],
  ['reddit', '/u/alice'],
  ['x', '@Alice'],
  // Trailing slashes.
  ['reddit', 'r/AskReddit/'],
  ['reddit', 'askreddit//'],
  // Combined prefix + trailing slash.
  ['reddit', '/r/AskReddit/'],
  // ASCII whitespace.
  ['reddit', '  AskReddit  '],
  ['reddit', '\tAskReddit\n'],
  ['reddit', '\r\nAskReddit\r\n'],
  ['reddit', '\fAskReddit\v'],
  // Non-ASCII whitespace — JS String.prototype.trim() strips the full Unicode
  // whitespace set; a SQL character class has to name each one.
  ['reddit', ' AskReddit '], // NBSP
  ['reddit', '﻿AskReddit﻿'], // BOM / ZWNBSP
  ['reddit', ' AskReddit '], // EN QUAD
  ['reddit', ' AskReddit '], // HAIR SPACE
  ['reddit', ' AskReddit '], // LINE / PARAGRAPH SEPARATOR
  ['reddit', ' AskReddit '], // NARROW NBSP
  ['reddit', ' AskReddit '], // MEDIUM MATHEMATICAL SPACE
  ['reddit', '　AskReddit　'], // IDEOGRAPHIC SPACE
  ['reddit', ' AskReddit '], // OGHAM SPACE MARK
  // Case-SENSITIVE platforms must be preserved verbatim (no lowering, no strip).
  ['linkedin', 'Some-Person'],
  ['hackernews', 'PaulG'],
  ['quora', 'First-Last'],
  ['linkedin', '  Some-Person  '],
  // Case-INSENSITIVE platforms beyond reddit/x.
  ['devto', '@BenHalpern'],
  ['medium', '@Ev'],
  ['threads', '@Zuck'],
  // Empty / degenerate.
  ['reddit', ''],
  ['reddit', '   '],
  ['x', '@'],
];

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  'engage_normalize_target_key (SQL) === normalizeUsername (TS)',
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient();
      // Install the functions exactly as the migration defines them, in file
      // order. CREATE OR REPLACE, so this is safe on a database that has them.
      for (const ddl of extractFunctionDdl()) {
        await prisma.$executeRawUnsafe(ddl);
      }
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    it.each(CASES)(
      'agrees on (%s, %j)',
      async (platform, raw) => {
        const [row] = await prisma.$queryRawUnsafe<{ key: string }[]>(
          'SELECT engage_normalize_target_key($1, $2) AS key',
          platform,
          raw
        );
        expect(row.key).toBe(normalizeUsername(platform, raw));
      }
    );

    it('is IMMUTABLE, so it can be used in the migration index predicates', async () => {
      const [row] = await prisma.$queryRawUnsafe<{ provolatile: string }[]>(
        `SELECT provolatile FROM pg_proc WHERE proname = 'engage_normalize_target_key'`
      );
      expect(row.provolatile).toBe('i');
    });
  }
);

// Guard the skip itself: if this spec silently stops running, the parity claim
// goes unverified while the suite still reports green.
describe('parity spec preconditions', () => {
  it('reports whether the SQL parity check actually ran', () => {
    if (!DATABASE_URL) {
      console.warn(
        '[engage-normalize-sql-parity] DATABASE_URL unset — the TS↔SQL parity ' +
          'assertions did NOT run. Set it before trusting the migration.'
      );
    }
    // The migration must still contain the function this spec exists to pin.
    expect(() => extractFunctionDdl()).not.toThrow();
  });
});
