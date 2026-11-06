import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareProfileUniquenessMigration } from './prepare-profile-uniqueness-migration';

const source = readFileSync(resolve(__dirname, '../libraries/nestjs-libraries/src/database/prisma/migrations/unique-active-integration-profile.sql'), 'utf8');

describe('offline profile uniqueness migration preparation', () => {
  it('binds the transaction to the configured production target before the guard and DDL', () => {
    const sql = prepareProfileUniquenessMigration(source, 'postgresql://private-user:private-password@production/aisee_postiz?schema=public');
    const setting = sql.indexOf("SET LOCAL postiz.expected_database = E'aisee_postiz';");
    expect(setting).toBeGreaterThan(sql.indexOf('BEGIN;'));
    expect(setting).toBeLessThan(sql.indexOf("current_setting('postiz.expected_database', true)"));
    expect(sql.indexOf('current_database()')).toBeLessThan(sql.indexOf('CREATE FUNCTION'));
    expect(sql).not.toMatch(/private-user|private-password|postgresql:\/\//);
    expect(sql).toContain(source.slice(source.indexOf('-- Match normalizeHandle')));
  });

  it('escapes encoded quotes and backslashes without permitting SQL injection', () => {
    const database = "postiz'\\; DROP TABLE x; --";
    const sql = prepareProfileUniquenessMigration(source, `postgresql://user:secret@host/${encodeURIComponent(database)}`);
    expect(sql).toContain("SET LOCAL postiz.expected_database = E'postiz''\\\\; DROP TABLE x; --';");
  });

  it('preserves decoded Unicode names', () => {
    expect(prepareProfileUniquenessMigration(source, 'postgresql://user:secret@host/%E7%94%9F%E4%BA%A7'))
      .toContain("SET LOCAL postiz.expected_database = E'生产';");
  });

  it.each(['postiz$&', 'postiz$$', "postiz$'", 'postiz$`'])('does not expand JavaScript replacement tokens in the database name: %s', database => {
    const sql = prepareProfileUniquenessMigration(source, `postgresql://host/${encodeURIComponent(database)}`);
    expect(sql).toContain(`SET LOCAL postiz.expected_database = E'${database.replace(/'/g, "''")}';`);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('retains fail-closed guards for absent settings and mismatched connections', () => {
    expect(source).toContain('expected_database IS NULL');
    expect(source).toContain("btrim(expected_database) = ''");
    expect(source).toContain('current_database() <> expected_database');
    expect(source).not.toContain('aisee_postiz_dev');
  });

  it('refuses malformed configuration and a source without its transaction or guard', () => {
    expect(() => prepareProfileUniquenessMigration(source, undefined)).toThrow('DATABASE_URL');
    expect(() => prepareProfileUniquenessMigration('CREATE TABLE x (id INT);', 'postgresql://host/postiz'))
      .toThrow('MIGRATION_TRANSACTION_OR_TARGET_GUARD_MISSING');
  });
});
