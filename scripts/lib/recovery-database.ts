/** Shared connection guard for local diagnostics and explicitly requested recovery. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { databaseNameFromUrl } from './database-url';

export function recoveryDatabase(verified: boolean | undefined) {
  if (verified !== true) throw new Error('VERIFY_ACTUAL_DATABASE_BEFORE_USING_DATABASE_VERIFIED');
  const envPath = resolve(__dirname, '../../.env');
  const env = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
  const database = databaseNameFromUrl(databaseUrl);
  const url = new URL(databaseUrl!);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    url.hostname, url.port || '5432', url.pathname, url.username, url.searchParams.get('schema') || 'public',
  ])).digest('hex');
  url.searchParams.set('connect_timeout', '5');
  url.searchParams.set('pool_timeout', '5');
  return { url: url.href, fingerprint, target: { host: url.hostname, port: url.port || '5432',
    database, schema: url.searchParams.get('schema') || 'public' } };
}
