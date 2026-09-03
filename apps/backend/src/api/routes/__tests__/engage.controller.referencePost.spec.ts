import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EngageController } from '../engage.controller';
import { TooSimilarToReferenceError } from '@gitroom/nestjs-libraries/engage/engage-reference-post.service';

// Locks the SSE contract for the reference-post generation endpoint — a
// sibling of generateDraft, but with no reply-credit reservation, its own
// typed error frame for the similarity gate, and — unlike generateDraft — it
// persists a Post itself (no separate save endpoint). See
// docs/engage/reference-post-generation.md §5/§6.

function makeRes() {
  const frames: string[] = [];
  let ended = false;
  return {
    frames,
    res: {
      setHeader: vi.fn(),
      write: vi.fn((s: string) => frames.push(s)),
      end: vi.fn(() => {
        ended = true;
      }),
      get writableEnded() {
        return ended;
      },
    } as any,
  };
}

function makeReq() {
  let closeHandler: (() => void) | undefined;
  return {
    req: {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'close') closeHandler = cb;
      }),
    } as any,
    triggerClose: () => closeHandler?.(),
  };
}

function build(overrides: Record<string, any> = {}) {
  const engageService = {
    generateReferencePost: vi.fn(async () => ({
      text: 'a fresh original post',
      postId: 'post1',
      parts: ['a fresh original post'],
      thread: false,
    })),
    ...overrides,
  };
  const controller = new EngageController(
    engageService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { controller, engageService };
}

const ORG = { id: 'org1' } as any;
const USER = { id: 'user1' } as any;
const BODY = { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 } as any;

describe('EngageController.generateReferencePost', () => {
  it('streams the generated text + postId then [DONE] on success', async () => {
    const { controller } = build();
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    expect(frames.join('')).toContain('a fresh original post');
    expect(frames.join('')).toContain('"postId":"post1"');
    expect(frames.join('')).toContain('[DONE]');
    expect(res.end).toHaveBeenCalled();
  });

  it('forwards the thread outcome (parts / thread / skip reason) in the final frame', async () => {
    // The client cannot infer any of this: it never picks the platform (that
    // is the opportunity's), so only the response can say whether a thread
    // was actually produced.
    const { controller } = build({
      generateReferencePost: vi.fn(async () => ({
        text: 'anchor\n\nfollow-up',
        postId: 'post1',
        parts: ['anchor', 'follow-up'],
        thread: true,
      })),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', { ...BODY, thread: true } as any, req, res);

    const stream = frames.join('');
    expect(stream).toContain('"thread":true');
    expect(stream).toContain('"parts":["anchor","follow-up"]');
  });

  it('publishes only the declared wire fields, never whatever else the service returns', async () => {
    // The frame is a public contract: serializing the service result
    // wholesale would leak any field a future change adds to
    // ReferencePostResult without anyone deciding it should be public.
    const { controller } = build({
      generateReferencePost: vi.fn(async () => ({
        text: 'a fresh original post',
        postId: 'post1',
        parts: ['a fresh original post'],
        thread: false,
        internalDebugTrace: 'should never reach the client',
      })),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    const stream = frames.join('');
    expect(stream).not.toContain('internalDebugTrace');
    // …and a plain single-post request keeps its original frame shape.
    expect(stream).not.toContain('threadSkippedReason');
  });

  it('reports a thread that degraded to one post on an unsupported platform', async () => {
    const { controller } = build({
      generateReferencePost: vi.fn(async () => ({
        text: 'just one post',
        postId: 'post1',
        parts: ['just one post'],
        thread: false,
        threadSkippedReason: 'platform_unsupported',
      })),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', { ...BODY, thread: true } as any, req, res);

    expect(frames.join('')).toContain('"threadSkippedReason":"platform_unsupported"');
  });

  it('reports a thread that was truncated for length via droppedParts', async () => {
    const { controller } = build({
      generateReferencePost: vi.fn(async () => ({
        text: 'anchor\n\nsecond',
        postId: 'post1',
        parts: ['anchor', 'second'],
        thread: true,
        droppedParts: 2,
      })),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', { ...BODY, thread: true } as any, req, res);

    expect(frames.join('')).toContain('"droppedParts":2');
  });

  it('passes the userId through to EngageService (needed to persist the draft)', async () => {
    const { controller, engageService } = build();
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    expect(engageService.generateReferencePost).toHaveBeenCalledWith(
      ORG,
      'user1',
      'opp1',
      BODY,
      expect.anything()
    );
  });

  it('emits opportunity_unavailable on a NotFoundException', async () => {
    const { controller } = build({
      generateReferencePost: vi.fn(async () => {
        throw new NotFoundException('Opportunity not found');
      }),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    expect(frames.join('')).toContain('opportunity_unavailable');
  });

  it('emits too_similar_to_reference when the similarity gate rejects both attempts', async () => {
    const { controller } = build({
      generateReferencePost: vi.fn(async () => {
        throw new TooSimilarToReferenceError([]);
      }),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    expect(frames.join('')).toContain('too_similar_to_reference');
  });

  it('emits generation_failed on an unexpected error (e.g. post persistence failed)', async () => {
    const { controller } = build({
      generateReferencePost: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    expect(frames.join('')).toContain('generation_failed');
  });

  // Without this the frame is a single opaque token and the only way to learn
  // what actually broke is a server log the caller has no access to.
  it('carries the underlying failure message as `reason` on the generation_failed frame', async () => {
    const { controller } = build({
      generateReferencePost: vi.fn(async () => {
        throw new BadRequestException(
          'No available posting time slot found within the next 365 days'
        );
      }),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    const payload = JSON.parse(
      frames.join('').split('data: ')[1].split('\n\n')[0]
    );
    expect(payload).toEqual({
      error: 'generation_failed',
      reason: 'No available posting time slot found within the next 365 days',
    });
  });

  // The typed frames say everything their code already says; a reason there
  // would just be a second, redundant string for the client to ignore.
  it('does not add a reason to the typed frames', async () => {
    const { controller } = build({
      generateReferencePost: vi.fn(async () => {
        throw new TooSimilarToReferenceError([]);
      }),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    const payload = JSON.parse(
      frames.join('').split('data: ')[1].split('\n\n')[0]
    );
    expect(payload).toEqual({ error: 'too_similar_to_reference' });
  });

  it('writes nothing when the client aborts before generation resolves', async () => {
    const { triggerClose, req } = makeReq();
    const { controller } = build({
      generateReferencePost: vi.fn(async () => {
        triggerClose();
        return { text: 'too late', postId: 'post1' };
      }),
    });
    const { res, frames } = makeRes();

    await controller.generateReferencePost(ORG, USER, 'opp1', BODY, req, res);

    expect(frames.join('')).toBe('');
  });
});

describe('EngageController.generateReferencePost — gate frames', () => {
  it('surfaces a credit block as its own typed frame, not generation_failed', async () => {
    // The client branches on `error`; collapsing a gate block into the generic
    // failure code would leave it unable to prompt a top-up.
    const { ForbiddenException } = await import('@nestjs/common');
    const { controller } = build({
      generateReferencePost: vi.fn(async () => {
        throw new ForbiddenException({
          code: 'engage_insufficient_credits',
          message: 'Not enough credits to generate a post. Top up to continue.',
        });
      }),
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateReferencePost(
      ORG,
      USER,
      'opp1',
      BODY,
      req as any,
      res as any
    );

    const payload = JSON.parse(frames[0].replace(/^data: /, '').trim());
    expect(payload.error).toBe('engage_insufficient_credits');
    expect(payload.detail.message).toContain('Top up');
    expect(frames[frames.length - 1]).toContain('[DONE]');
  });
});
