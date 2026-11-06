import { describe, expect, it } from 'vitest';
import { databaseNameFromUrl } from './database-url';

describe('configured PostgreSQL database target', () => {
  it.each(['aisee_postiz_dev', 'aisee_postiz', 'aisee_posiz', 'custom_staging'])('derives %s without an environment-specific allowlist', database => {
    expect(databaseNameFromUrl(`postgresql://user:secret@host/${database}?schema=tenant`)).toBe(database);
  });

  it.each(['postiz production', "postiz'production", 'postiz\\production', 'postiz/production', '生产数据库'])('decodes the explicit database name: %s', database => {
    expect(databaseNameFromUrl(`postgres://user:secret@host/${encodeURIComponent(database)}`)).toBe(database);
  });

  it.each([
    undefined, '', 'not-a-url', 'https://user:secret@host/postiz',
    'postgresql://user:secret@host/', 'postgresql://user:secret@host',
    'postgresql:///postiz', 'postgresql://user:secret@host/db/other',
    'postgresql://user:secret@host/%ZZ', 'postgresql://user:secret@host/%00',
    'postgresql://user:secret@host/%20', 'postgresql://user:secret@host/db#other',
  ])('rejects invalid or ambiguous configuration without echoing secrets: %s', value => {
    expect(() => databaseNameFromUrl(value)).toThrow('DATABASE_URL');
    try { databaseNameFromUrl(value); } catch (error) {
      expect(String(error)).not.toMatch(/secret|user:|postgresql:\/\//);
    }
  });
});
