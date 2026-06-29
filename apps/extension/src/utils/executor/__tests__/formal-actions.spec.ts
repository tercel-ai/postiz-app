import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

describe('formal Engage collection surfaces', () => {
  it('does not expose debug action or backend route names', () => {
    const background = read('apps/extension/src/pages/background/index.ts');
    const options = read('apps/extension/src/pages/options/Options.tsx');
    const controller = read('apps/backend/src/api/routes/engage.controller.ts');

    for (const source of [background, options]) {
      expect(source).not.toMatch(
        /xdebug:|rdebug:|debug:ingest-posts|debug:sync-metrics/
      );
    }
    expect(controller).not.toContain("@Post('/debug/ingest')");
    expect(controller).toContain("@Post('/scan-posts/ingest')");
  });
});
