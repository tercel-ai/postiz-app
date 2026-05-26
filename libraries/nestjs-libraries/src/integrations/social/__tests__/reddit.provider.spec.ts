import 'reflect-metadata'; // reddit.dto.ts uses class-validator decorators
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedditProvider } from '../reddit.provider';

// Regression guard: Reddit blocks the undici default User-Agent ("node") with
// HTTP 403. RedditProvider.fetch must inject a descriptive UA on every request.
describe('RedditProvider — User-Agent injection', () => {
  afterEach(() => vi.restoreAllMocks());

  function headersOf(spy: ReturnType<typeof vi.spyOn>): Record<string, string> {
    return (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it('injects a descriptive User-Agent and preserves caller headers', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const provider = new RedditProvider();
    await provider.fetch('https://oauth.reddit.com/api/v1/me', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(spy).toHaveBeenCalledOnce();
    const headers = headersOf(spy);
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers['User-Agent']).not.toBe('node'); // the blocked undici default
    expect(headers['Authorization']).toBe('Bearer token');
  });

  it('uses a Reddit-compliant UA format on requests with no headers', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const provider = new RedditProvider();
    await provider.fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
    });

    // Format: <platform>:<app id>:<version> (by /u/<username>)
    expect(headersOf(spy)['User-Agent']).toMatch(/^[^:]+:[^:]+:.+\(by \/u\/.+\)$/);
  });
});
