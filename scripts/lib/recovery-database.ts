/** Shared connection guard for local diagnostics and explicitly requested recovery. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';

export function recoveryDatabase(verified: boolean | undefined) {
  if (verified !== true) throw new Error('VERIFY_ACTUAL_DATABASE_BEFORE_USING_DATABASE_VERIFIED');
  const envPath = resolve(__dirname, '../../.env');
  const env = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  const url = new URL(process.env.DATABASE_URL || env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== 'aisee_postiz_dev')
    throw new Error('DATABASE_URL_MUST_NAME_AISEE_POSTIZ_DEV');
  const fingerprint = createHash('sha256').update(JSON.stringify([
    url.hostname, url.port || '5432', url.pathname, url.username, url.searchParams.get('schema') || 'public',
  ])).digest('hex');
  url.searchParams.set('connect_timeout', '5');
  url.searchParams.set('pool_timeout', '5');
  return { url: url.href, fingerprint, target: { host: url.hostname, port: url.port || '5432',
    database: decodeURIComponent(url.pathname.slice(1)), schema: url.searchParams.get('schema') || 'public' } };
}
