import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tryConsumeHourly } from '../pacing';

describe('platform-scoped hourly pacing', () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, store[key]]))
          ),
          set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
        },
      },
    });
  });

  it('does not let X requests consume the Reddit budget', async () => {
    expect(await tryConsumeHourly(1, 'x')).toBe(true);
    expect(await tryConsumeHourly(1, 'x')).toBe(false);
    expect(await tryConsumeHourly(1, 'reddit')).toBe(true);
  });
});
