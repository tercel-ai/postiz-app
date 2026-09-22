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
    getOpportunityForReply: vi.fn(async () => ({ id: 'opp1', projectId: null, platform: 'x' })),
    reserveReplyGeneration: vi.fn(async () => ({ cost: 3, taskId: 't1' })),
    settleReplyGeneration: vi.fn(async () => undefined),
    releaseReplyGeneration: vi.fn(async () => undefined),
    recordGeneration: vi.fn(async (..._args: any[]) => undefined),
    ...overrides,
  };
  const draftService = {
    generateDraft: overrides.generateDraft
      ? vi.fn(overrides.generateDraft)
      : vi.fn(async function* () {
          yield 'hello world';
        }),
  };
  const controller = new EngageController(
    engageService as any,
    draftService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { controller, engageService, draftService };
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
    const [org, oppId, entry] = engageService.recordGeneration.mock.calls[0] as any[];
    expect(org).toBe(ORG);
    expect(oppId).toBe('opp1');
    expect(entry).toMatchObject({
      source: 'ai',
      content: 'hello world',
      length: 'medium',
      cost: 3,
      strategy: 'EXPERT_ANSWER',
      brandStrength: 1,
      billingTaskId: 't1',
    });
    expect(typeof entry.createdAt).toBe('string');
  });

  it('uses the state id only for lookup, then bills and records against its resolved context', async () => {
    const { controller, engageService } = build({
      getOpportunityForReply: vi.fn(async () => ({
        id: 'shared-opportunity',
        stateId: 'project-state',
        projectId: 'project-1',
        platform: 'x',
      })),
    });
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(ORG, 'project-state', BODY, req, res);

    expect(engageService.getOpportunityForReply).toHaveBeenCalledWith(
      ORG,
      'project-state',
      undefined
    );
    expect(engageService.reserveReplyGeneration).toHaveBeenCalledWith(
      ORG,
      'medium',
      'shared-opportunity'
    );
    expect(engageService.recordGeneration).toHaveBeenCalledWith(
      ORG,
      'shared-opportunity',
      expect.any(Object),
      'project-1'
    );
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

// X's post ceiling is a property of the ACCOUNT's subscription — 280 weighted
// characters without one, 25000 with one — so the same reply request has to be
// written to a different length depending on which account will send it.
describe('EngageController.generateDraft — the account ceiling', () => {
  it('writes a long reply to the account"s own ceiling', async () => {
    const { controller, draftService } = build();
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(
      ORG,
      'opp1',
      { ...BODY, length: 'long', maxWeighted: 25000 },
      req,
      res
    );

    // generateDraft(opportunity, strategy, brandStrength, mentions, signal, outputLength)
    const outputLength = draftService.generateDraft.mock.calls[0][5];
    // The REPLY ladder (200/600/2000), not the original-post one (280/1500/
    // 4096): a reply aimed at someone else's post is a different social act.
    expect(outputLength).toBe(2000);
  });

  it('keeps a free account on the tier it has always had', async () => {
    const { controller, draftService } = build();
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(
      ORG,
      'opp1',
      { ...BODY, length: 'long' },
      req,
      res
    );

    expect(draftService.generateDraft.mock.calls[0][5]).toBe(255);
  });

  it('still honours an explicit outputLength over the tier', async () => {
    // The field is the caller saying what it wants; the ceiling only decides
    // what a TIER means when no number was given.
    const { controller, draftService } = build();
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(
      ORG,
      'opp1',
      { ...BODY, length: 'long', outputLength: 400, maxWeighted: 25000 },
      req,
      res
    );

    expect(draftService.generateDraft.mock.calls[0][5]).toBe(400);
  });

  it('does not reject a long reply the account can actually send', async () => {
    // The gate and the target must be fed the SAME ceiling. Told 3000 and then
    // judged against 280, every long reply on a subscribed account would fail
    // after it had already been generated and charged for.
    const { controller, engageService } = build({
      generateDraft: async function* () {
        yield 'a'.repeat(2000);
      },
    });
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(
      ORG,
      'opp1',
      { ...BODY, length: 'long', maxWeighted: 25000 },
      req,
      res
    );

    expect(engageService.settleReplyGeneration).toHaveBeenCalledTimes(1);
    expect(engageService.releaseReplyGeneration).not.toHaveBeenCalled();
  });

  it('hands the draft service the ceiling, not just the target', async () => {
    // The service hard-rejects above max(target, ceiling). Given only the
    // target, a 2000-character reply would be rejected at exactly 2000 —
    // destroying the slack that split exists for, and failing a reply that
    // overran by one character after it had burned its retry.
    const { controller, draftService } = build();
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(
      ORG,
      'opp1',
      { ...BODY, length: 'long', maxWeighted: 25000 },
      req,
      res
    );

    // generateDraft(opportunity, strategy, brandStrength, mentions, signal,
    //               outputLength, maxWeighted)
    expect(draftService.generateDraft.mock.calls[0][6]).toBe(25000);
  });
});

describe('EngageController.generateDraft — an untrusted ceiling', () => {
  it('ignores a ceiling past anything X grants', async () => {
    // The value is CLIENT-supplied. One outside the range X is known to hand
    // out is a bug, a stale client or a forged body — never a more generous
    // account — and honouring it would write a reply that cannot be sent.
    const { controller, draftService } = build();
    const { res } = makeRes();
    const { req } = makeReq();

    await controller.generateDraft(
      ORG,
      'opp1',
      { ...BODY, length: 'long', maxWeighted: 1_000_000 },
      req,
      res
    );

    expect(draftService.generateDraft.mock.calls[0][5]).toBe(255);
    expect(draftService.generateDraft.mock.calls[0][6]).toBe(280);
  });
});
