/** Prepare guarded SQL artifacts offline; never connect to or modify a database. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { databaseNameFromUrl } from './lib/database-url';

const migrations = new Map([
  ['profile-uniqueness', 'unique-active-integration-profile.sql'],
  ['send-safety', 'repair-send-safety-after-db-push.sql'],
]);

export function prepareSqlMigration(source: string, databaseUrl: string | undefined): string {
  const database = databaseNameFromUrl(databaseUrl);
  if ((source.match(/^BEGIN;\r?$/gm) ?? []).length !== 1 ||
      !source.includes("current_setting('postiz.expected_database', true)")) {
    throw new Error('MIGRATION_TRANSACTION_OR_TARGET_GUARD_MISSING');
  }
  // E literals escape backslashes regardless of standard_conforming_strings.
  const literal = `E'${database.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  return source.replace(/^BEGIN;\r?$/m,
    () => `BEGIN;\n\nSET LOCAL postiz.expected_database = ${literal};`);
}

export function runPreparation(defaultMigration = 'profile-uniqueness') {
  try {
    const { values } = parseArgs({ options: {
      migration: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('Usage: pnpm migration:prepare:profile-uniqueness --output <new.sql>\n       pnpm migration:prepare:send-safety --output <new.sql>\nLoads DATABASE_URL from the environment or .env and writes SQL only. No database connection is made.');
      return;
    }
    const sourceName = migrations.get(values.migration ?? defaultMigration);
    if (!sourceName || !values.output?.trim()) throw new Error('VALID_MIGRATION_AND_OUTPUT_PATH_REQUIRED');
    dotenv.config({ path: resolve(__dirname, '../.env') });
    const sourcePath = resolve(__dirname, '../libraries/nestjs-libraries/src/database/prisma/migrations', sourceName);
    const sql = prepareSqlMigration(readFileSync(sourcePath, 'utf8'), process.env.DATABASE_URL);
    const outputPath = resolve(values.output);
    // Exclusive creation also protects the source and existing reviewed artifacts.
    writeFileSync(outputPath, sql, { flag: 'wx', mode: 0o600 });
    console.log(`Prepared SQL: ${outputPath}`);
    console.log(`Database: ${JSON.stringify(databaseNameFromUrl(process.env.DATABASE_URL))}`);
    console.log('No database connection was made. Review the artifact before applying it through the deployment pipeline.');
  } catch {
    console.error('Migration preparation failed. Check DATABASE_URL, the migration selection, --output, and that the output file does not already exist.');
    process.exitCode = 1;
  }
}

if (require.main === module) runPreparation();
