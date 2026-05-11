import { describe, it, expect, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
// Build a PostsRepository instance with minimal dependencies. We only exercise
// logError, which touches `_post` (for findUnique) and `_errors` (for create).
// The remaining PrismaRepository slots are unused by the code paths under test.

type Captured = {
  data: {
    message: string;
    body: string;
    stack: string | null;
    code: string | null;
    type: string | null;
    details: string | null;
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

// twitter-api-v2 ApiResponseError shape (the actual class is harder to import
// here; we replicate the relevant surface).
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

describe('PostsRepository.logError — error detail persistence', () => {
  it('saves the full stack into the dedicated `stack` column (not truncated to 3 lines)', async () => {
    const { repo, captured } = buildRepo();

    const err = new Error('boom');
    // Force a long stack so we can detect truncation.
    err.stack =
      'Error: boom\n' +
      Array.from({ length: 50 }, (_, i) => `    at frame${i} (/file${i}.ts:${i}:${i})`).join('\n');

    await repo.logError('post-1', err);

    expect(captured).toHaveLength(1);
    const { stack } = captured[0].data;
    expect(stack).not.toBeNull();
    // Should retain far more than the old 3-line cap.
    const lineCount = (stack as string).split('\n').length;
    expect(lineCount).toBeGreaterThan(20);
    // And specifically: the last frame must be present.
    expect(stack).toContain('frame49');
  });

  it('extracts code, type, and ApiResponseError-style details for 401 failures', async () => {
    const { repo, captured } = buildRepo();

    await repo.logError('post-1', new ApiResponseError('Request failed with code 401'));

    const d = captured[0].data;
    expect(d.code).toBe('401');
    expect(d.type).toBe('ApiResponseError');
    // Human-readable summary still gets the message
    expect(d.message).toContain('Request failed with code 401');
    expect(d.message).toContain('[ApiResponseError]');
    // Structured details column contains the platform response bodies
    expect(d.details).not.toBeNull();
    expect(d.details).toContain('Unauthorized');
    expect(d.details).toContain('rateLimit');
  });

  it('walks the cause chain (Temporal ApplicationFailure → original platform error)', async () => {
    const { repo, captured } = buildRepo();

    const inner = new ApiResponseError('Request failed with code 401');
    const outer = new ApplicationFailureLike(
      'Activity task failed',
      'refresh_token',
      inner
    );

    await repo.logError('post-1', outer);

    const d = captured[0].data;
    // For Temporal ApplicationFailure we prefer .type ("refresh_token") over
    // .name ("ApplicationFailure") because the type is what actually drives
    // the workflow's retry / refresh decisions and is far more useful for
    // triage / aggregation than the generic class name.
    expect(d.type).toBe('refresh_token');
    // Code should come from the inner platform error since outer has none.
    expect(d.code).toBe('401');
    // Message should include both levels joined with ' | '
    expect(d.message).toContain('Activity task failed');
    expect(d.message).toContain('Request failed with code 401');
    expect(d.message).toContain('[refresh_token]');
    expect(d.message).toContain('[ApiResponseError]');
    // Details should include the inner ApiResponseError data
    expect(d.details).toContain('Unauthorized');
  });

  it('handles plain string errors without crashing', async () => {
    const { repo, captured } = buildRepo();

    await repo.logError('post-1', 'simple string error');

    const d = captured[0].data;
    expect(d.message).toBe('simple string error');
    expect(d.stack).toBeNull();
    expect(d.code).toBeNull();
    expect(d.type).toBeNull();
    expect(d.details).toBeNull();
  });

  it('truncates absurdly long stacks with a marker rather than blowing up the DB row', async () => {
    const { repo, captured } = buildRepo();

    const err = new Error('huge');
    err.stack = 'Error: huge\n' + 'x'.repeat(200_000);

    await repo.logError('post-1', err);

    const stack = captured[0].data.stack as string;
    expect(stack.length).toBeLessThan(40_000);
    expect(stack).toContain('[truncated');
  });

  it('does NOT overwrite the legacy `body` column (postsList context) with error data', async () => {
    const { repo, captured } = buildRepo();

    const postsList = [{ id: 'post-1' }, { id: 'post-2' }];
    await repo.logError('post-1', new Error('boom'), postsList);

    const d = captured[0].data;
    // body keeps the original postsList semantics
    expect(d.body).toBe(JSON.stringify(postsList));
    // structured error info goes into the new columns
    expect(d.message).toContain('boom');
    expect(d.stack).not.toBeNull();
  });

  it('handles circular references in error.details without throwing', async () => {
    const { repo, captured } = buildRepo();

    const circular: any = { name: 'circle' };
    circular.self = circular;
    const err = new Error('cycle') as any;
    err.data = circular;

    await repo.logError('post-1', err);

    expect(captured).toHaveLength(1);
    expect(captured[0].data.details).toContain('[Circular]');
  });
});
