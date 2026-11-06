import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareSqlMigration } from './prepare-sql-migration';

const directory = resolve(__dirname, '../libraries/nestjs-libraries/src/database/prisma/migrations');
const read = (name: string) => readFileSync(resolve(directory, name), 'utf8');
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('post-db-push send safety repair preparation', () => {
  it('prepares only two missing indexes and eighteen checks without rewriting business data', () => {
    const source = read('repair-send-safety-after-db-push.sql');
    const sql = prepareSqlMigration(source, 'postgresql://private-user:private-password@production/aisee_postiz?sslmode=no-verify');
    expect(sql).toContain("SET LOCAL postiz.expected_database = E'aisee_postiz';");
    expect(sql).toContain('SET LOCAL search_path = pg_catalog, public;');
    expect(sql.match(/^CREATE (?:UNIQUE )?INDEX /gm)).toHaveLength(2);
    expect(sql.match(/ADD CONSTRAINT "[^"]+"\s+CHECK/g)).toHaveLength(18);
    expect(sql).not.toMatch(/^(?:CREATE TABLE|DROP|UPDATE|INSERT|DELETE|TRUNCATE)\b/gm);
    expect(sql).not.toMatch(/private-user|private-password|sslmode|aisee_postiz_dev/);
    expect(sql.indexOf('current_database() <> expected_database')).toBeLessThan(sql.indexOf('CREATE UNIQUE INDEX'));
  });

  it('retains every named CHECK from the original reviewed migrations', () => {
    const repair = normalize(read('repair-send-safety-after-db-push.sql'));
    for (const name of ['add-send-coordination.sql', 'add-stable-social-identity-checks.sql',
      'add-linkedin-company-actor-sessions.sql', 'add-automatic-send-owners.sql']) {
      const checks = read(name).match(/ALTER TABLE "[^"]+" ADD CONSTRAINT "[^"]+"\s+CHECK[\s\S]*?;/g) ?? [];
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) expect(repair).toContain(normalize(check));
    }
  });

  it('preserves the original active execution and claim scan predicates', () => {
    const repair = normalize(read('repair-send-safety-after-db-push.sql'));
    const active = read('add-send-coordination.sql').match(/CREATE UNIQUE INDEX "SendExecution_one_active_content"[\s\S]*?;/)![0];
    const scan = read('add-send-claim-cursors.sql').match(/CREATE INDEX IF NOT EXISTS "Post_controlled_claim_scan_idx"[\s\S]*?;/)![0];
    expect(repair).toContain(normalize(active));
    expect(repair).toContain(normalize(scan.replace('IF NOT EXISTS ', '')));
    expect(repair).not.toContain('IF NOT EXISTS');
  });

  it('preserves the node and cursor invariants and deferred identity validation', () => {
    const source = read('repair-send-safety-after-db-push.sql');
    expect(source).toContain('CHECK ("nodeId" ~ \'^[0-9a-f]{64}$\')');
    expect(source).toContain('CHECK (("afterPublishDate" IS NULL) = ("afterPostId" IS NULL))');
    expect(source).toContain('CHECK ("revision" >= 0)');
    expect(source.match(/NOT VALID;/g)).toHaveLength(3);
    expect(source.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(source.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
