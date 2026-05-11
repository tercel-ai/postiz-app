import { describe, it, expect, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
// We exercise logError only — it touches `_post` (findUnique) and `_errors`
// (create). Unused PrismaRepository slots are passed empty.

type Captured = {
  data: {
    message: string;
    body: string;
    platform: string;
    postId: string;
    organizationId: string;
  };
};

function buildRepo() {
  const captured: Captured[] = [];

  const postModel = {
    model: {
      post: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'post-1',
          organizationId: 'org-1',
          integration: { providerIdentifier: 'x' },
        }),
      },
    },
  };

  const errorsModel = {
    model: {
      errors: {
        create: vi.fn(async (args: Captured) => {
          captured.push(args);
          return args.data;
        }),
      },
    },
  };

  const repo = new PostsRepository(
    postModel as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    errorsModel as any
  );

  return { repo, captured };
}

// ---------------------------------------------------------------------------
// Error-shape fixtures
// ---------------------------------------------------------------------------

// twitter-api-v2 ApiResponseError shape.
class ApiResponseError extends Error {
  code = 401;
  data = { errors: [{ message: 'Unauthorized', code: 89 }] };
  rateLimit = { limit: 300, remaining: 0, reset: 1234567890 };
  constructor(message: string) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

// Temporal-style nested ApplicationFailure → cause chain.
class ApplicationFailureLike extends Error {
  type: string;
  cause?: Error;
  details?: any;
  constructor(message: string, type: string, cause?: Error, details?: any) {
    super(message);
    this.name = 'ApplicationFailure';
    this.type = type;
    this.cause = cause;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostsRepository.logError — message field content', () => {
  it('preserves the full stack (not truncated to 3 lines) in the message field', async () => {
    const { repo, captured } = buildRepo();

    const err = new Error('boom');
    err.stack =
      'Error: boom\n' +
      Array.from({ length: 50 }, (_, i) => `    at frame${i} (/file${i}.ts:${i}:${i})`).join('\n');

    await repo.logError('post-1', err);

    const message = captured[0].data.message;
    expect(message).toContain('Stack:');
    // Should retain the full stack, not just the first 3 lines.
    expect(message).toContain('frame49');
    expect(message).toContain('frame25');
  });

  it('includes code, type, and structured details for 401 ApiResponseError', async () => {
    const { repo, captured } = buildRepo();

    await repo.logError('post-1', new ApiResponseError('Request failed with code 401'));

    const message = captured[0].data.message;
    expect(message).toContain('[ApiResponseError]');
    expect(message).toContain('(Code: 401)');
    expect(message).toContain('Request failed with code 401');
    // Structured details — Twitter SDK payload + rate limit info
    expect(message).toContain('Details:');
    expect(message).toContain('Unauthorized');
    expect(message).toContain('rateLimit');
  });

  it('walks the cause chain (Temporal ApplicationFailure → inner platform error)', async () => {
    const { repo, captured } = buildRepo();

    const inner = new ApiResponseError('Request failed with code 401');
    const outer = new ApplicationFailureLike(
      'Activity task failed',
      'refresh_token',
      inner
    );

    await repo.logError('post-1', outer);

    const message = captured[0].data.message;
    // Outer Temporal frame
    expect(message).toContain('[refresh_token]');
    expect(message).toContain('Activity task failed');
    // Inner platform frame
    expect(message).toContain('[ApiResponseError]');
    expect(message).toContain('Request failed with code 401');
    expect(message).toContain('(Code: 401)');
    // Inner platform details
    expect(message).toContain('Unauthorized');
  });

  it('handles plain string errors without crashing', async () => {
    const { repo, captured } = buildRepo();

    await repo.logError('post-1', 'simple string error');

    expect(captured[0].data.message).toBe('simple string error');
  });

  it('caps overly long messages with a truncation marker (no unbounded growth)', async () => {
    const { repo, captured } = buildRepo();

    const err = new Error('huge');
    err.stack = 'Error: huge\n' + 'x'.repeat(200_000);

    await repo.logError('post-1', err);

    const message = captured[0].data.message;
    expect(message.length).toBeLessThan(70_000); // well under MAX_MESSAGE_LEN + slack
    expect(message).toContain('[truncated');
  });

  it('keeps the legacy `body` column unchanged (still postsList context)', async () => {
    const { repo, captured } = buildRepo();

    const postsList = [{ id: 'post-1' }, { id: 'post-2' }];
    await repo.logError('post-1', new Error('boom'), postsList);

    expect(captured[0].data.body).toBe(JSON.stringify(postsList));
    expect(captured[0].data.message).toContain('boom');
  });

  it('handles circular references in error.details without throwing', async () => {
    const { repo, captured } = buildRepo();

    const circular: any = { name: 'circle' };
    circular.self = circular;
    const err = new Error('cycle') as any;
    err.data = circular;

    await repo.logError('post-1', err);

    expect(captured).toHaveLength(1);
    expect(captured[0].data.message).toContain('[Circular]');
  });

  // -------------------------------------------------------------------------
  // W2 fix: credential redaction in captured headers + URLs
  // -------------------------------------------------------------------------
  // Provider SDK errors (axios, twitter-api-v2, etc.) routinely expose the
  // request `config` with the Authorization header that was sent. Without
  // redaction, persisting these into the multi-tenant Errors.message column
  // would leak OAuth Bearer tokens to anyone with read access to the table.
  // -------------------------------------------------------------------------

  describe('credential redaction (W2)', () => {
    it('redacts Authorization / Cookie / x-api-key headers but keeps innocuous ones', async () => {
      const { repo, captured } = buildRepo();
      const err: any = new Error('401 from platform');
      err.response = {
        status: 401,
        headers: {
          authorization: 'Bearer eyJabc.def.ghi-VERY-SECRET-TOKEN',
          cookie: 'session=DEADBEEF; csrf=ABC',
          'set-cookie': ['session=NEW-SESSION-TOKEN; path=/'],
          'x-api-key': 'sk_live_SECRET_KEY',
          'x-auth-token': 'auth-secret-token',
          'content-type': 'application/json',
          'x-ratelimit-limit': '300',
          'x-ratelimit-remaining': '0',
        },
        data: { error: 'invalid_token' },
      };

      await repo.logError('post-1', err);

      const message = captured[0].data.message;

      // Sensitive material is gone, marker present.
      expect(message).not.toContain('eyJabc.def.ghi-VERY-SECRET-TOKEN');
      expect(message).not.toContain('DEADBEEF');
      expect(message).not.toContain('NEW-SESSION-TOKEN');
      expect(message).not.toContain('sk_live_SECRET_KEY');
      expect(message).not.toContain('auth-secret-token');
      expect(message).toContain('[REDACTED]');

      // Innocuous diagnostic headers survive for triage value.
      expect(message).toContain('application/json');
      expect(message).toContain('x-ratelimit-limit');
      expect(message).toContain('300');
    });

    it('redacts headers regardless of case (Authorization vs authorization vs AUTHORIZATION)', async () => {
      const { repo, captured } = buildRepo();
      const err: any = new Error('boom');
      err.response = {
        status: 401,
        headers: {
          Authorization: 'Bearer SECRET1',
          AUTHORIZATION: 'Bearer SECRET2',
          'X-API-Key': 'SECRET3',
        },
      };

      await repo.logError('post-1', err);

      const message = captured[0].data.message;
      expect(message).not.toContain('SECRET1');
      expect(message).not.toContain('SECRET2');
      expect(message).not.toContain('SECRET3');
    });

    it('redacts headers from fetch/undici-style Headers objects (forEach + get)', async () => {
      const { repo, captured } = buildRepo();
      // Simulate WHATWG Headers shape (used by undici / native fetch).
      const fakeHeaders = {
        _data: new Map([
          ['authorization', 'Bearer FETCH-SECRET'],
          ['content-type', 'application/json'],
        ]),
        get(name: string) {
          return this._data.get(name.toLowerCase());
        },
        forEach(cb: (value: string, name: string) => void) {
          this._data.forEach((v: string, k: string) => cb(v, k));
        },
      };
      const err: any = new Error('boom');
      err.response = { status: 401, headers: fakeHeaders };

      await repo.logError('post-1', err);

      const message = captured[0].data.message;
      expect(message).not.toContain('FETCH-SECRET');
      expect(message).toContain('[REDACTED]');
      expect(message).toContain('application/json');
    });

    it('strips access_token / refresh_token / code / client_secret from captured config.url', async () => {
      const { repo, captured } = buildRepo();
      const err: any = new Error('400 from platform');
      err.config = {
        method: 'POST',
        url: 'https://api.x.com/2/oauth/token?access_token=AAAA-LEAK&refresh_token=BBBB-LEAK&code=CCCC&client_secret=DDDD&grant_type=refresh_token',
      };

      await repo.logError('post-1', err);

      const message = captured[0].data.message;
      expect(message).not.toContain('AAAA-LEAK');
      expect(message).not.toContain('BBBB-LEAK');
      expect(message).not.toContain('CCCC');
      expect(message).not.toContain('DDDD');
      // Non-sensitive params survive
      expect(message).toContain('grant_type=refresh_token');
      // The URL itself is still there for triage
      expect(message).toContain('api.x.com/2/oauth/token');
    });

    it('handles non-URL-parseable url strings gracefully (regex fallback)', async () => {
      const { repo, captured } = buildRepo();
      const err: any = new Error('boom');
      err.config = {
        method: 'GET',
        // Intentionally malformed-but-recognizable shape
        url: 'not-a-real-url?access_token=LEAKY-VALUE&foo=bar',
      };

      await repo.logError('post-1', err);

      const message = captured[0].data.message;
      expect(message).not.toContain('LEAKY-VALUE');
      expect(message).toContain('foo=bar');
    });

    it('does not crash when response.headers is null/undefined/missing', async () => {
      const { repo, captured } = buildRepo();
      const err: any = new Error('boom');
      err.response = { status: 500, data: { error: 'server' } };
      // headers intentionally absent

      await expect(repo.logError('post-1', err)).resolves.not.toThrow();
      expect(captured).toHaveLength(1);
    });
  });
});
