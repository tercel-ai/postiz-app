import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { EngageController } from '../engage.controller';

// Drives the SSE generateDraft flow end-to-end with mocked services to lock the
// §15.4 charging contract: precheck-block-without-generating, settle-once-on-
// success, release (uncount) on abort. The per-module review flagged this path
// as having zero controller-level tests.

const flush = () => new Promise((r) => setImmediate(r));

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
    getOpportunityForReply: vi.fn(async () => ({ platform: 'x' })),
    reserveReplyGeneration: vi.fn(async () => ({ cost: 3, taskId: 't1' })),
    settleReplyGeneration: vi.fn(async () => undefined),
    releaseReplyGeneration: vi.fn(async () => undefined),
    recordGeneration: vi.fn(async () => undefined),
    ...overrides,
  };
  const draftService = {
    generateDraft: overrides.generateDraft ?? (async function* () {
      yield 'hello world';
    }),
  };
  const controller = new EngageController(engageService as any, draftService as any);
  return { controller, engageService };
}

const ORG = { id: 'org1' } as any;
const BODY = { strategy: 'EXPERT_ANSWER', brandStrength: 1 } as any;

describe('EngageController.generateDraft — billing contract', () => {
  it('settles exactly once on a successful generation, never releases', async () => {
    const { controller, engageService } = build();
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(ORG, 'opp1', BODY, req, res);

    expect(engageService.reserveReplyGeneration).toHaveBeenCalledWith(ORG, 'medium', 'opp1');
    expect(engageService.settleReplyGeneration).toHaveBeenCalledTimes(1);
    expect(engageService.settleReplyGeneration).toHaveBeenCalledWith(ORG, 't1', 'medium', 3);
    expect(engageService.releaseReplyGeneration).not.toHaveBeenCalled();
    expect(frames.join('')).toContain('hello world');
    expect(frames.join('')).toContain('[DONE]');

    // Every successful generation is persisted to the opportunity's version
    // history, linked to the BillingRecord taskId charged for it.
    expect(engageService.recordGeneration).toHaveBeenCalledTimes(1);
    const [org, oppId, entry] = engageService.recordGeneration.mock.calls[0];
    expect(org).toBe(ORG);
    expect(oppId).toBe('opp1');
    expect(entry).toMatchObject({
      content: 'hello world',
      length: 'medium',
      cost: 3,
      strategy: 'EXPERT_ANSWER',
      brandStrength: 1,
      billingTaskId: 't1',
    });
    expect(typeof entry.createdAt).toBe('string');
  });

  it('does NOT record history when the client aborts mid-stream (nothing delivered)', async () => {
    const { triggerClose, req } = makeReq();
    const generateDraft = async function* () {
      triggerClose();
      yield 'partial';
    };
    const { controller, engageService } = build({ generateDraft });
    const { res } = makeRes();

    await controller.generateDraft(ORG, 'opp1', BODY, req, res);
    await flush();

    expect(engageService.recordGeneration).not.toHaveBeenCalled();
  });

  it('blocks at the cap WITHOUT generating or charging, emitting the typed error frame', async () => {
    const generateDraft = vi.fn(async function* () {
      yield 'should not run';
    });
    const { controller, engageService } = build({
      reserveReplyGeneration: vi.fn(async () => {
        throw new ForbiddenException({ code: 'engage_reply_cap_reached', cap: 10, used: 10 });
      }),
      generateDraft,
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(ORG, 'opp1', BODY, req, res);

    expect(generateDraft).not.toHaveBeenCalled();
    expect(engageService.settleReplyGeneration).not.toHaveBeenCalled();
    expect(engageService.releaseReplyGeneration).not.toHaveBeenCalled(); // no reservation taken
    expect(frames.join('')).toContain('engage_reply_cap_reached');
  });

  it('blocks an EXPIRED opportunity before reserving/generating, emitting the reason frame', async () => {
    const generateDraft = vi.fn(async function* () {
      yield 'should not run';
    });
    const { controller, engageService } = build({
      getOpportunityForReply: vi.fn(async () => {
        throw new ForbiddenException({
          code: 'engage_opportunity_expired',
          message: 'This opportunity has expired and can no longer be replied to.',
        });
      }),
      generateDraft,
    });
    const { res, frames } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(ORG, 'opp1', BODY, req, res);

    // Status gate runs before billing — no reservation taken, nothing generated.
    expect(engageService.reserveReplyGeneration).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
    expect(engageService.releaseReplyGeneration).not.toHaveBeenCalled();
    // The typed code AND the human reason reach the client.
    expect(frames.join('')).toContain('engage_opportunity_expired');
    expect(frames.join('')).toContain('can no longer be replied to');
  });

  it('releases the reservation (uncounts it) and does not settle when the client aborts mid-stream', async () => {
    const { triggerClose, req } = makeReq();
    // Abort on the first iteration, before any chunk is consumed.
    const generateDraft = async function* () {
      triggerClose();
      yield 'partial';
    };
    const { controller, engageService } = build({ generateDraft });
    const { res } = makeRes();

    await controller.generateDraft(ORG, 'opp1', BODY, req, res);
    await flush();

    expect(engageService.settleReplyGeneration).not.toHaveBeenCalled();
    expect(engageService.releaseReplyGeneration).toHaveBeenCalledWith('t1');
  });
});
