/**
 * Fold the two OLD write-window settings into `platform_pacing[*].window`.
 *
 *   extension_publish.time_window       (per platform, 'HH:MM' + IANA timezone)
 *   engage_reply_pacing.activeHoursUtc  (one global pair of UTC hours)
 *
 * WHY THIS SCRIPT EXISTS AT ALL. Renaming a settings key needs no migration when
 * the value is still the seeded default — the new key seeds itself on boot and
 * the old row is just litter. It needs one the moment an operator has TUNED the
 * value, because the new key would then seed a default that silently replaces
 * their setting. That is the whole job here: carry tuned values across, and only
 * then delete the old rows.
 *
 * WHAT IT MERGES, AND WHY THAT ORDER.
 * `time_window` wins over `activeHoursUtc` wherever both speak about a platform.
 * It is strictly more expressive — per platform, arbitrary minutes, a real
 * timezone — while `activeHoursUtc` can only say "these UTC hours, everywhere".
 * Taking the weaker one would lose information that cannot be recovered.
 *
 * `activeHoursUtc` therefore lands on `default.window` (its scope was global)
 * and only when `time_window` had no global default of its own.
 *
 * SKIPPED VALUES ARE REPORTED, NEVER GUESSED AT. A malformed window is left
 * alone and logged: writing a wrong window is worse than writing none, because
 * a wrong one posts at the wrong hour while none simply does not constrain.
 *
 * IDEMPOTENT. A platform that already has a `window` in `platform_pacing` is
 * left untouched unless --force. Re-running after a partial run is safe.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/migrate-write-window-to-platform-pacing.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/migrate-write-window-to-platform-pacing.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/migrate-write-window-to-platform-pacing.ts --execute --force
 *   npx ts-node --project scripts/tsconfig.json scripts/migrate-write-window-to-platform-pacing.ts --execute --keep-old
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';
process.env.ENGAGE_DISABLE_LOCAL_NLI = 'true';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  PLATFORM_PACING_KEY,
  PlatformPacingConfigService,
} from '@gitroom/nestjs-libraries/engage/platform-pacing-config.service';
import {
  EXTENSION_PUBLISH_TIME_WINDOW_KEY,
  type PublishTimeWindowSetting,
} from '@gitroom/nestjs-libraries/database/prisma/posts/extension-publish-config.service';
import { ENGAGE_REPLY_PACING_KEY } from '@gitroom/nestjs-libraries/engage/engage-auto-reply.service';
import type { PacingWindow } from '@gitroom/helpers/extension/platform-pacing';

// DatabaseModule alone is not enough: it provides NotificationService, which
// takes a TemporalService, which lives in the Temporal module. Without this the
// context fails to build before the script's own code ever runs. `false` skips
// connecting to a Temporal server — nothing here starts a workflow.
@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  dryRun: boolean;
  force: boolean;
  keepOld: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let dryRun = true;
  let force = false;
  let keepOld = false;
  for (const arg of args) {
    switch (arg) {
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--force': force = true; break;
      case '--keep-old': keepOld = true; break;
      case '--help':
        console.log(
          'Usage: migrate-write-window-to-platform-pacing.ts [--dry-run|--execute] [--force] [--keep-old]'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return { dryRun, force, keepOld };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A window is only carried across when BOTH bounds are real clock times. */
function validWindow(w: unknown): PacingWindow | null {
  if (!w || typeof w !== 'object') return null;
  const raw = w as Record<string, unknown>;
  const start = raw.windowStart;
  const end = raw.windowEnd;
  if (typeof start !== 'string' || !HHMM.test(start)) return null;
  if (typeof end !== 'string' || !HHMM.test(end)) return null;
  // start === end is how the old resolver spelled "empty window"; carrying it
  // over would silently block every write instead of allowing every one.
  if (start === end) return null;
  const out: PacingWindow = { windowStart: start, windowEnd: end };
  if (typeof raw.timezone === 'string' && raw.timezone) out.timezone = raw.timezone;
  return out;
}

/**
 * `[startHour, endHour)` UTC → a PacingWindow.
 *
 * `[0, 24]` is the old default and means "no restriction" — it becomes NO
 * window rather than a 24-hour one, because an explicit full-day window and an
 * absent window differ the moment someone edits one of them.
 */
function windowFromActiveHours(hours: unknown): PacingWindow | null {
  if (!Array.isArray(hours) || hours.length !== 2) return null;
  const [start, end] = hours.map(Number);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start > 24 || end < 0 || end > 24) return null;
  if (start === 0 && end === 24) return null;
  if (start === end) return null;
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return { windowStart: hh(start), windowEnd: hh(end), timezone: 'UTC' };
}

async function main() {
  const { dryRun, force, keepOld } = parseArgs();
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });

  try {
    const settings = app.get(SettingsService);
    const pacingService = app.get(PlatformPacingConfigService);

    const [oldWindows, replyPacing, pacing] = await Promise.all([
      settings.get<PublishTimeWindowSetting>(EXTENSION_PUBLISH_TIME_WINDOW_KEY),
      settings.get<Record<string, unknown>>(ENGAGE_REPLY_PACING_KEY),
      pacingService.getPlatformPacing(),
    ]);

    const next = {
      ...pacing,
      default: { ...pacing.default },
      platforms: { ...pacing.platforms },
    };
    const applied: string[] = [];
    const skipped: string[] = [];

    // ── per-platform windows from extension_publish.time_window ──────────────
    for (const [platform, raw] of Object.entries(oldWindows?.platforms ?? {})) {
      const window = validWindow(raw);
      if (!window) {
        skipped.push(`${platform}: malformed time_window ${JSON.stringify(raw)}`);
        continue;
      }
      if (next.platforms[platform]?.window && !force) {
        skipped.push(`${platform}: already has a window (use --force to overwrite)`);
        continue;
      }
      next.platforms[platform] = { ...next.platforms[platform], window };
      applied.push(`${platform}: ${window.windowStart}–${window.windowEnd} ${window.timezone ?? 'UTC'}`);
    }

    // ── the global default ───────────────────────────────────────────────────
    const globalFromWindows = validWindow(oldWindows?.default);
    const globalFromHours = windowFromActiveHours(replyPacing?.activeHoursUtc);
    // time_window's default wins: it can express minutes and a timezone, which
    // activeHoursUtc cannot, so preferring the other way would lose information.
    const globalWindow = globalFromWindows ?? globalFromHours;
    if (globalWindow) {
      if (next.default.window && !force) {
        skipped.push('default: already has a window (use --force to overwrite)');
      } else {
        next.default = { ...next.default, window: globalWindow };
        const from = globalFromWindows ? 'time_window.default' : 'activeHoursUtc';
        applied.push(
          `default (from ${from}): ${globalWindow.windowStart}–${globalWindow.windowEnd} ${globalWindow.timezone ?? 'UTC'}`
        );
      }
    } else if (replyPacing?.activeHoursUtc && !globalFromHours) {
      skipped.push(
        `activeHoursUtc ${JSON.stringify(replyPacing.activeHoursUtc)} means "no restriction" — nothing to carry`
      );
    }

    console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Write-window migration`);
    console.log(`  applied: ${applied.length}`);
    for (const line of applied) console.log(`    + ${line}`);
    console.log(`  skipped: ${skipped.length}`);
    for (const line of skipped) console.log(`    - ${line}`);

    if (dryRun) {
      console.log('\nResulting platform_pacing would be:');
      console.log(JSON.stringify(next, null, 2));
      console.log('\nRe-run with --execute to write it.');
      return;
    }

    if (applied.length) {
      // No `description`: the repository leaves it untouched when undefined, so
      // the canonical schema documentation seeded by PlatformPacingConfigService
      // survives. Passing a one-line note here would replace it permanently —
      // onModuleInit only writes when the key is ABSENT, so it never comes back.
      await settings.set(PLATFORM_PACING_KEY, next, { type: 'object' });
      console.log(`\nWrote ${PLATFORM_PACING_KEY}.`);
    } else {
      console.log('\nNothing to carry across; platform_pacing left as it is.');
    }

    // Deleting the old rows is the point of the migration — leaving them is how
    // a second source of truth comes back. --keep-old exists for a cautious
    // first run, not as the normal path.
    if (keepOld) {
      console.log('--keep-old: leaving the old keys in place.');
      return;
    }

    // But never delete a value we refused to carry across. The header promises
    // "carry tuned values across, and only THEN delete the old rows", and a
    // window skipped as malformed was NOT carried — deleting it would destroy
    // the only record of what the operator had configured. Every other step is
    // ordered so a failure is recoverable by re-running; this one is not.
    const malformed = skipped.filter((line) => line.includes('malformed'));
    if (malformed.length) {
      console.warn(
        `\nRefusing to delete the old keys: ${malformed.length} value(s) could not be ` +
          `carried across. Fix them at the source, or re-run with --force to overwrite ` +
          `what is already in platform_pacing. The old rows are untouched.`
      );
      return;
    }
    await settings.delete(EXTENSION_PUBLISH_TIME_WINDOW_KEY);
    console.log(`Deleted ${EXTENSION_PUBLISH_TIME_WINDOW_KEY}.`);
    if (replyPacing && 'activeHoursUtc' in replyPacing) {
      const { activeHoursUtc: _dropped, ...rest } = replyPacing;
      await settings.set(ENGAGE_REPLY_PACING_KEY, rest, { type: 'object' });
      console.log(`Removed activeHoursUtc from ${ENGAGE_REPLY_PACING_KEY}.`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
