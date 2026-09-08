import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Keyword abbreviation/expansion table for engage-scorer's keyword matching
 * (e.g. "mcp" ↔ "model context protocol"). Kept as a hand-edited JSON file
 * rather than a code constant so adding a term is a data change reviewed on
 * its own, not a diff to the scoring logic — and rather than a database
 * table because this is engineer-maintained vocabulary, not an
 * org-configurable setting the product surfaces to users (compare
 * EngageKeyword, which IS the latter).
 *
 * Lives at the REPO ROOT, next to .env, not inside this library's own src/
 * tree. This module (libraries/nestjs-libraries) is compiled separately by
 * both apps/backend and apps/orchestrator, each with `assets: []` in its
 * nest-cli.json — plain `tsc`, no resource-copy step — so a file placed
 * under src/ here is simply absent from either app's dist output; reading it
 * via `join(__dirname, ...)` at runtime hit exactly that (ENOENT, silently
 * swallowed below, every abbreviation match quietly stopped working). The
 * repo root survives every build because nothing ever deletes source: both
 * apps' own `.env` is read the identical way (see each package.json's
 * `start` script: `dotenv -e ../../.env`), so this follows the same,
 * already-proven convention instead of inventing a second one.
 */
const CONFIG_FILENAME = 'keyword-abbreviations.json';

// scorePost runs once per scanned post — easily thousands of calls a minute
// during a busy scan cycle — so re-reading and re-hashing the file on every
// call would turn "edit a JSON file" into real per-post disk IO for a table
// that changes maybe a few times a month. Capping how often the file is even
// STATTED keeps the hot path at effectively zero added cost; the tradeoff is
// an edit takes up to this long to take effect instead of being instant.
const RECHECK_INTERVAL_MS = 10_000;

let cachedContentHash: string | null = null;
let cachedTable: Record<string, string[]> = {};
let lastCheckedAt = 0;
// Resolved once and reused — walking up from __dirname is a few stat calls,
// not something to repeat on every recheck tick.
let resolvedPath: string | null = null;

/**
 * Walk up from `startDir` looking for `filename`, the way a monorepo tool
 * locates its own root — no assumption baked in about how many directories
 * separate this compiled module from the repo root, which differs between
 * apps/backend's and apps/orchestrator's dist layouts (and differs again in
 * a local `vitest run`, whose cwd is the repo root itself). Bounded so a
 * missing file fails fast instead of walking to the filesystem root.
 */
function findUp(filename: string, startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
  return null;
}

function readAndHash(): { raw: string; hash: string } | null {
  if (resolvedPath === null) {
    resolvedPath = findUp(CONFIG_FILENAME, __dirname) ?? '';
  }
  if (!resolvedPath) return null; // never found it — see getKeywordAbbreviations doc

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf-8');
  } catch {
    // Found it once, unreadable now (permissions, mid-deploy). Keep serving
    // whatever was cached before rather than throwing out of the hot scoring
    // path over a config problem.
    return null;
  }
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

/**
 * The current abbreviation table, re-read from disk only when its content
 * hash has changed AND at most once per RECHECK_INTERVAL_MS. Never throws —
 * a file that can't be located at all, one that becomes unreadable, or a
 * malformed edit all fall back to the last successfully parsed table (empty
 * if there has never been one), because a data-file problem should not take
 * keyword scoring down.
 */
export function getKeywordAbbreviations(): Record<string, string[]> {
  const now = Date.now();
  if (now - lastCheckedAt < RECHECK_INTERVAL_MS) return cachedTable;
  lastCheckedAt = now;

  const read = readAndHash();
  if (!read || read.hash === cachedContentHash) return cachedTable;

  try {
    const parsed = JSON.parse(read.raw);
    cachedTable = parsed;
    cachedContentHash = read.hash;
  } catch {
    // Malformed JSON: keep the last good table rather than crashing every
    // scorePost call until the edit is fixed. Do NOT update cachedContentHash
    // here — leaving it stale means the NEXT recheck retries parsing this
    // same content instead of silently accepting the broken file forever.
  }
  return cachedTable;
}

/** Test-only: force the next getKeywordAbbreviations() call to re-resolve the
 * file path and re-read its content, dropping any cached table. */
export function _resetKeywordAbbreviationsCacheForTests(): void {
  cachedContentHash = null;
  cachedTable = {};
  lastCheckedAt = 0;
  resolvedPath = null;
}
