import { describe, it, expect, vi, beforeEach } from 'vitest';
import { zodResponseFormat } from 'openai/helpers/zod';
import { OperationPlanService } from '../operation-plan.service';

function makePlan(overrides: Partial<any> = {}) {
  return {
    id: 'plan-1',
    organizationId: 'org-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    campaignId: 'campaign-1',
    platforms: ['x'],
    status: 'READY',
    startsAt: new Date('2026-07-20T00:00:00.000Z'),
    endsAt: new Date('2026-07-21T00:00:00.000Z'), // 2-day range
    planPayload: {},
    ...overrides,
  };
}

function createMocks() {
  return {
    getById: vi.fn(),
    getPostsForPlan: vi.fn().mockResolvedValue([]),
    getSentRepliesInRange: vi.fn().mockResolvedValue([]),
    resolveKeywordTexts: vi.fn().mockResolvedValue([]),
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  return new OperationPlanService(mocks as any);
}

describe('OperationPlanService.getOverview', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: OperationPlanService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('returns empty engageStats when the plan has no engagePolicies', async () => {
    mocks.getById.mockResolvedValue(makePlan());

    const result = await service.getOverview('org-1', 'plan-1');

    expect(result.engageStats).toEqual({});
    expect(mocks.resolveKeywordTexts).not.toHaveBeenCalled();
    expect(mocks.getSentRepliesInRange).not.toHaveBeenCalled();
  });

  it('returns empty engageStats when every policy is disabled', async () => {
    mocks.getById.mockResolvedValue(
      makePlan({
        planPayload: {
          engagePolicies: [
            { platform: 'x', enabled: false, keywordTargets: { kw1: 5 } },
          ],
        },
      })
    );

    const result = await service.getOverview('org-1', 'plan-1');
    expect(result.engageStats).toEqual({});
  });

  it('builds a zero-filled day x keyword grid across [startsAt, endsAt] with explicit reply counts', async () => {
    mocks.getById.mockResolvedValue(
      makePlan({
        planPayload: {
          engagePolicies: [
            {
              platform: 'x',
              themeTitle: 'React positioning replies',
              enabled: true,
              keywordTargets: { 'kw-react': 5 },
            },
          ],
        },
      })
    );
    mocks.resolveKeywordTexts.mockResolvedValue([{ id: 'kw-react', keyword: 'react' }]);
    mocks.getSentRepliesInRange.mockResolvedValue([
      { post: { publishDate: new Date('2026-07-20T10:00:00.000Z') }, matchedKeywords: ['react'], opportunity: { platform: 'x' } },
      { post: { publishDate: new Date('2026-07-20T14:00:00.000Z') }, matchedKeywords: ['react', 'nextjs'], opportunity: { platform: 'x' } },
      { post: { publishDate: new Date('2026-07-21T02:00:00.000Z') }, matchedKeywords: ['react'], opportunity: { platform: 'x' } },
    ]);

    const result = await service.getOverview('org-1', 'plan-1');

    // Each day is an array with one entry per platform policy.
    expect(result.engageStats).toEqual({
      '2026-07-20': [
        {
          platform: 'x',
          themeTitle: 'React positioning replies',
          keywords: [
            { keywordId: 'kw-react', keyword: 'react', actualReplies: 2, targetReplies: 5 },
          ],
        },
      ],
      '2026-07-21': [
        {
          platform: 'x',
          themeTitle: 'React positioning replies',
          keywords: [
            { keywordId: 'kw-react', keyword: 'react', actualReplies: 1, targetReplies: 5 },
          ],
        },
      ],
    });
  });

  it('splits the same keyword per platform (x and reddit are separate entries, not summed)', async () => {
    mocks.getById.mockResolvedValue(
      makePlan({
        endsAt: new Date('2026-07-20T00:00:00.000Z'), // single-day range
        planPayload: {
          engagePolicies: [
            {
              platform: 'x',
              themeTitle: 'React replies on X',
              enabled: true,
              keywordTargets: { 'kw-react': 3 },
            },
            {
              platform: 'reddit',
              themeTitle: 'React replies on Reddit',
              enabled: true,
              keywordTargets: { 'kw-react': 2 },
            },
          ],
        },
      })
    );
    mocks.resolveKeywordTexts.mockResolvedValue([{ id: 'kw-react', keyword: 'react' }]);
    mocks.getSentRepliesInRange.mockResolvedValue([
      { post: { publishDate: new Date('2026-07-20T10:00:00.000Z') }, matchedKeywords: ['react'], opportunity: { platform: 'reddit' } },
    ]);

    const result = await service.getOverview('org-1', 'plan-1');

    // Two platform entries, each with its own target; the reddit reply counts
    // only toward the reddit entry.
    expect(result.engageStats['2026-07-20']).toEqual([
      {
        platform: 'x',
        themeTitle: 'React replies on X',
        keywords: [{ keywordId: 'kw-react', keyword: 'react', actualReplies: 0, targetReplies: 3 }],
      },
      {
        platform: 'reddit',
        themeTitle: 'React replies on Reddit',
        keywords: [{ keywordId: 'kw-react', keyword: 'react', actualReplies: 1, targetReplies: 2 }],
      },
    ]);
  });

  it('drops a keywordId that no longer resolves to an existing EngageKeyword', async () => {
    mocks.getById.mockResolvedValue(
      makePlan({
        endsAt: new Date('2026-07-20T00:00:00.000Z'),
        planPayload: {
          engagePolicies: [
            { platform: 'x', enabled: true, keywordTargets: { 'kw-deleted': 5 } },
          ],
        },
      })
    );
    mocks.resolveKeywordTexts.mockResolvedValue([]); // keyword no longer exists

    const result = await service.getOverview('org-1', 'plan-1');
    // Nothing left to report once every configured keywordId fails to
    // resolve — same "nothing to show" shape as no engagePolicies at all.
    expect(result.engageStats).toEqual({});
  });

  it('ignores a matched keyword in EngageSentReply that has no configured target', async () => {
    mocks.getById.mockResolvedValue(
      makePlan({
        endsAt: new Date('2026-07-20T00:00:00.000Z'),
        planPayload: {
          engagePolicies: [
            { platform: 'x', enabled: true, keywordTargets: { 'kw-react': 5 } },
          ],
        },
      })
    );
    mocks.resolveKeywordTexts.mockResolvedValue([{ id: 'kw-react', keyword: 'react' }]);
    mocks.getSentRepliesInRange.mockResolvedValue([
      { post: { publishDate: new Date('2026-07-20T10:00:00.000Z') }, matchedKeywords: ['untracked-keyword'], opportunity: { platform: 'x' } },
    ]);

    const result = await service.getOverview('org-1', 'plan-1');
    expect(result.engageStats['2026-07-20']).toEqual([
      {
        platform: 'x',
        themeTitle: undefined,
        keywords: [
          { keywordId: 'kw-react', keyword: 'react', actualReplies: 0, targetReplies: 5 },
        ],
      },
    ]);
  });

  it('passes the plan\'s own organizationId/projectId/date range to the reply query, not caller input', async () => {
    mocks.getById.mockResolvedValue(
      makePlan({
        endsAt: new Date('2026-07-20T00:00:00.000Z'),
        planPayload: {
          engagePolicies: [{ platform: 'x', enabled: true, keywordTargets: { 'kw-react': 5 } }],
        },
      })
    );
    mocks.resolveKeywordTexts.mockResolvedValue([{ id: 'kw-react', keyword: 'react' }]);

    await service.getOverview('org-1', 'plan-1');

    expect(mocks.getSentRepliesInRange).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      new Date('2026-07-20T00:00:00.000Z'),
      new Date('2026-07-20T00:00:00.000Z')
    );
  });

  it('composes plan + posts + engageStats into the overview shape', async () => {
    mocks.getById.mockResolvedValue(makePlan());
    mocks.getPostsForPlan.mockResolvedValue([{ id: 'post-1' }]);

    const result = await service.getOverview('org-1', 'plan-1');

    expect(result.plan.id).toBe('plan-1');
    expect('contentItems' in result.plan).toBe(false);
    expect(result.posts).toEqual([{ id: 'post-1' }]);
    expect(mocks.getPostsForPlan).toHaveBeenCalledWith('plan-1', 'org-1');
  });
});

describe('OperationPlanService.create', () => {
  function createGenerationDependencies(generatedPlan: any) {
    // Real generation always returns a `goal` (schema-enforced); tests mock
    // past the schema, so default one in unless the fixture provides its own.
    generatedPlan = {
      goal: { title: 'Goal', description: 'Desc', targetScore: 70 },
      ...generatedPlan,
    };
    const basePlan = {
      ...makePlan(),
      startsAt: new Date('2030-01-01T00:00:00.000Z'),
      endsAt: new Date('2030-01-02T00:00:00.000Z'),
      generatorVersion: 'operation-plan-v1',
      sourceTaskVersion: 'v1',
      billingTransactionId: null,
      creditAmount: null,
      errorCode: null,
      planPayload: {
        ...generatedPlan,
        campaignId: 'campaign-1',
        generatorVersion: 'operation-plan-v1',
        durationDays: 2,
      },
    };
    // The GENERATING stub create() persists synchronously up front. The
    // background job reads it back (getById) for its campaignId/generatorVersion,
    // so the stub carries both.
    const generatingStub = {
      ...basePlan,
      status: 'GENERATING',
      planPayload: {},
      data: {},
    };
    const repo = {
      getConnectedPlatforms: vi.fn().mockResolvedValue(['x']),
      findByTaskId: vi.fn().mockResolvedValue(null),
      findStuckGenerating: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(generatingStub),
      getById: vi.fn().mockResolvedValue(generatingStub),
      completeGeneration: vi
        .fn()
        .mockResolvedValue({ ...basePlan, status: 'BILLING_PENDING' }),
      updateStatus: vi.fn().mockResolvedValue({
        ...basePlan,
        status: 'READY',
        billingTransactionId: 'txn-1',
        creditAmount: '1.250000',
      }),
      materializePlanPosts: vi.fn().mockResolvedValue(undefined),
    };
    const aiseeClient = {
      getTaskDetail: vi.fn().mockResolvedValue({
        ok: true,
        task: {
          id: 'task-1',
          userId: 'owner-1',
          productId: 'proj-1',
          status: 'completed',
          result: { summary: 'usable' },
          productSnapshot: { name: 'Product', keywords: ['snapshot-kw-1', 'snapshot-kw-2'] },
          version: 'v1',
        },
      }),
      notifyOperationPlanStatus: vi.fn(),
    };
    const creditService = {
      resolveOwnerUserId: vi.fn().mockResolvedValue('owner-1'),
      hasCredits: vi.fn().mockResolvedValue(true),
      deductUsageAndConfirm: vi.fn().mockResolvedValue({
        deduction: { success: true, transactionId: 'txn-1' },
        costItems: [{ amount: '1.250000' }],
      }),
    };
    const openaiService = {
      generateStructuredText: vi.fn().mockResolvedValue({
        data: generatedPlan,
        usage: { usage: { total_tokens: 100 } },
      }),
      // Default identity: only exercised when OPERATION_SHRINK_MODEL is set.
      shrinkToLimit: vi.fn(async (content: string) => content),
    };
    const engageRepository = {
      // Default: echo each keyword text to a synthetic id ("GEO" -> "id-GEO").
      resolveOrCreateKeywordIds: vi.fn(async (_org: string, _proj: string, texts: string[]) =>
        Object.fromEntries(texts.map((t) => [t, `id-${t}`]))
      ),
    };
    // Per-key settings mock. Default: every operation_plan.* key unset, so the
    // service falls back to its built-in defaults (max 30 days, no allowlist).
    const settingsService = {
      get: vi.fn(async (_key: string) => undefined as unknown),
      set: vi.fn(async () => undefined),
    };
    const service = new OperationPlanService(
      repo as any,
      aiseeClient as any,
      creditService as any,
      settingsService as any,
      openaiService as any,
      engageRepository as any
    );

    return { repo, creditService, openaiService, engageRepository, aiseeClient, settingsService, service };
  }

  // create() (real path) spawns _generateAndBill fire-and-forget and returns the
  // GENERATING stub immediately. Spying on it (spyOn calls the original through)
  // lets a test await the SAME background promise so assertions observe the final
  // persisted state. `background` is undefined on the dry-run/idempotency paths,
  // where no background job is spawned.
  async function createAndSettle(
    service: OperationPlanService,
    input: any,
    options?: { dryRun?: boolean }
  ) {
    const spy = vi.spyOn(service as any, '_generateAndBill');
    const result = await service.create('org-1', 'proj-1', input, options);
    const background = spy.mock.results[0]?.value as Promise<void> | undefined;
    return { result, background };
  }

  it('persists a GENERATING stub and returns immediately, then generates + bills in the background (BILLING_PENDING -> READY + materialize)', async () => {
    const { repo, creditService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    const { result, background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    // The row is persisted as GENERATING with stub payloads, and returned right
    // away — billing has NOT happened by the time create() resolves.
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      projectId: 'proj-1',
      status: 'GENERATING',
      planPayload: {},
      data: {},
    }));
    expect(result.status).toBe('GENERATING');
    expect(result.id).toBe('plan-1');
    expect(creditService.deductUsageAndConfirm).not.toHaveBeenCalled();

    // Drive the background job to completion.
    await background;

    // It fills the stub in (-> BILLING_PENDING), bills, then marks READY and
    // materializes — the create() row is UPDATED, never a second create().
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.completeGeneration).toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({ status: 'BILLING_PENDING' })
    );
    expect(repo.completeGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      creditService.deductUsageAndConfirm.mock.invocationCallOrder[0]
    );
    expect(repo.updateStatus).toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({ status: 'READY', billingTransactionId: 'txn-1' })
    );
    expect(repo.materializePlanPosts).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'plan-1', status: 'READY' }),
      expect.objectContaining({ contentItems: [] })
    );
  });

  it('marks the plan FAILED (GENERATION_FAILED) and does not bill when generation fails', async () => {
    const { repo, creditService, openaiService, aiseeClient, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    openaiService.generateStructuredText.mockRejectedValue(new Error('provider 500'));

    const { result, background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    // The request is still accepted — the failure surfaces on the row, not the
    // response — and the background job never throws out.
    expect(result.status).toBe('GENERATING');
    await expect(background).resolves.toBeUndefined();

    expect(repo.updateStatus).toHaveBeenCalledWith('plan-1', {
      status: 'FAILED',
      errorCode: 'GENERATION_FAILED',
    });
    expect(repo.completeGeneration).not.toHaveBeenCalled();
    expect(creditService.deductUsageAndConfirm).not.toHaveBeenCalled();
    expect(repo.materializePlanPosts).not.toHaveBeenCalled();
    // Generation failure never bills, so Aisee is notified directly (no billing
    // confirm callback fires on this path).
    expect(aiseeClient.notifyOperationPlanStatus).toHaveBeenCalledWith(
      'proj-1',
      'plan-1',
      'failed'
    );
  });

  it('requires post ids, display theme titles, and executable keyword targets in the generation contract', async () => {
    const generatedPlan = {
      goal: { title: 'GEO push', description: 'Close the weakest gaps', targetScore: 72 },
      contentItems: [
        {
          contentId: 'D01',
          utcDate: '2030-01-01T00:00:00.000Z',
          themeKey: 'positioning',
          themeTitle: 'AI search positioning',
          platforms: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              platform: 'x',
              content: 'Publish-ready content',
              // Required-but-nullable: OpenAI structured outputs forbids bare
              // `.optional()`, so "no media" is an explicit null.
              media: null,
            },
          ],
        },
      ],
      engagePolicies: [
        {
          platform: 'x',
          themeTitle: 'Helpful GEO answers',
          targetRepliesPerDay: 5,
          // A LIST (not a Record) — OpenAI structured outputs forbids dynamic keys.
          keywordTargets: [
            { keyword: 'kw-geo', target: 3 },
            { keyword: 'kw-ai-search', target: 2 },
          ],
          // Required (may be empty): per-day overrides keyed by concrete date.
          dailyTargets: [{ date: '2030-01-02', target: 2 }],
          enabled: true,
        },
      ],
      warnings: [],
    };
    const { openaiService, service } = createGenerationDependencies(generatedPlan);

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    const schema = openaiService.generateStructuredText.mock.calls[0][2];
    expect(schema.safeParse(generatedPlan).success).toBe(true);
    expect(schema.safeParse({
      ...generatedPlan,
      engagePolicies: [
        {
          ...generatedPlan.engagePolicies[0],
          dailyHardCap: 8,
          keywords: ['GEO', 'AI search'],
        },
      ],
    }).success).toBe(false);
    expect(schema.safeParse({
      contentItems: [
        {
          contentId: 'D01-x',
          utcDate: '2030-01-01T00:00:00.000Z',
          themeKey: 'positioning',
          platforms: generatedPlan.contentItems[0].platforms,
        },
      ],
      engagePolicies: [
        {
          platform: 'x',
          minimumRepliesPerDay: 2,
          targetRepliesPerDay: 5,
          dailyHardCap: 8,
          keywords: ['GEO', 'AI search'],
          enabled: true,
        },
      ],
      warnings: [],
    }).success).toBe(false);
    expect(schema.safeParse({
      ...generatedPlan,
      contentItems: [
        {
          ...generatedPlan.contentItems[0],
          platforms: [
            {
              platform: 'x',
              content: 'Publish-ready content',
            },
          ],
        },
      ],
    }).success).toBe(false);
  });

  it('does not swallow post materialization failures inside the background job (rejects out of _generateAndBill after billing succeeds)', async () => {
    const { repo, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    repo.materializePlanPosts.mockRejectedValue(new Error('post id conflict'));

    const { result, background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    // create() itself still resolves (the failure is off the request path), but
    // the background job must surface it rather than swallow it — billing already
    // succeeded and the plan is READY, so a materialization failure is a real bug.
    expect(result.status).toBe('GENERATING');
    await expect(background).rejects.toThrow('post id conflict');
  });

  it('dryRun returns the generated preview and does NOT persist, bill, or materialize anything', async () => {
    const { repo, creditService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: ['heads up'],
    });

    const result = await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true });

    // Zero side effects — the whole point of the preview.
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(repo.materializePlanPosts).not.toHaveBeenCalled();
    expect(creditService.deductUsageAndConfirm).not.toHaveBeenCalled();
    // Returns the generated plan, marked as a non-persisted preview.
    expect(result.dryRun).toBe(true);
    expect(result.id).toBeNull();
    expect(result.status).toBe('PREVIEW');
    expect(result.durationDays).toBe(2);
    expect(result.warnings).toEqual(['heads up']);
    expect(result.estimatedUsage).toEqual({ usage: { total_tokens: 100 } });
  });

  it('dryRun still enforces the generation contract (invalid plan rejected, still writes nothing)', async () => {
    // utcDate outside [start,end] must be rejected by _validateGeneratedPlan
    // even on the preview path.
    const { repo, service } = createGenerationDependencies({
      contentItems: [
        {
          contentId: 'D01',
          utcDate: '2999-01-01T00:00:00.000Z',
          themeKey: 'x',
          themeTitle: 'x',
          platforms: [
            { id: '11111111-1111-4111-8111-111111111111', platform: 'x', content: 'c' },
          ],
        },
      ],
      engagePolicies: [],
      warnings: [],
    });

    await expect(service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true })).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  // Regression guard for OpenAI Structured Outputs compatibility. Every other
  // test mocks generateStructuredText, so none of them convert the schema the
  // way the real call does — both bugs below only surfaced as a provider 400:
  //   1. a bare `.optional()` → zodResponseFormat throws locally;
  //   2. an unsupported string `format` (e.g. `.url()` → "uri") → the provider
  //      rejects with `invalid_json_schema`, which NOTHING local catches.
  it('generation schema is OpenAI structured-outputs compatible (converts, and uses only supported string formats)', async () => {
    const { openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    const schema = openaiService.generateStructuredText.mock.calls[0][2];

    // (1) must convert without throwing.
    let responseFormat: any;
    expect(() => {
      responseFormat = zodResponseFormat(schema, 'operation_plan');
    }).not.toThrow();

    // (2) every `format` must be one OpenAI accepts, and every object must be
    //     closed (additionalProperties:false) with `required` listing ALL keys
    //     — i.e. no dynamic-key maps (z.record) anywhere.
    const SUPPORTED_FORMATS = new Set([
      'date-time', 'time', 'date', 'duration',
      'email', 'hostname', 'ipv4', 'ipv6', 'uuid',
    ]);
    const offenders: string[] = [];
    const walk = (node: any, path: string) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      if (typeof node.format === 'string' && !SUPPORTED_FORMATS.has(node.format)) {
        offenders.push(`${path}.format="${node.format}"`);
      }
      if (node.type === 'object') {
        if (node.additionalProperties !== false) {
          offenders.push(`${path}: additionalProperties must be false (dynamic-key map?)`);
        }
        const props = Object.keys(node.properties ?? {});
        const required = new Set(node.required ?? []);
        const missing = props.filter((p) => !required.has(p));
        if (missing.length) {
          offenders.push(`${path}: not in required: ${missing.join(',')}`);
        }
      }
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    };
    walk(responseFormat.json_schema.schema, 'schema');

    expect(offenders).toEqual([]);
  });

  // Live generation produced 20/20 "tweets" of 315-439 weighted chars — every
  // one unpublishable on X. Without this gate the plan would persist DRAFT
  // Posts doomed to fail at release time. _validateGeneratedPlan runs in the
  // shared generation step, so the preview (dryRun) path enforces it
  // synchronously — the deterministic way to assert the exact rejection message.
  it('trims generated content over the platform ceiling instead of failing the plan (X weighted)', async () => {
    const longTweet = 'a'.repeat(281);
    const { service } = createGenerationDependencies({
      contentItems: [
        {
          contentId: 'D01',
          utcDate: '2030-01-01T00:00:00.000Z',
          themeKey: 'k',
          themeTitle: 't',
          platforms: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              platform: 'x',
              content: longTweet,
              media: null,
            },
          ],
        },
      ],
      engagePolicies: [],
      warnings: [],
    });

    // Not rejected: the over-budget post is trimmed to fit rather than throwing
    // away the whole generation.
    const result = await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true });

    const trimmed = result.contentItems[0].platforms[0].content;
    // 281 plain-ASCII chars weigh 281 (> 280); trimmed to within the 280 ceiling
    // (twitter-text's valid cut point, ~279-280) and shorter than the original.
    expect(trimmed.length).toBeLessThanOrEqual(280);
    expect(trimmed.length).toBeGreaterThan(270);
    expect(trimmed.length).toBeLessThan(longTweet.length);
  });

  it('trims to a word boundary and never mid-word when over the ceiling', async () => {
    // 47 words of "lorem " = 282 chars incl. trailing space; over 280.
    const longTweet = ('lorem '.repeat(47)).trim();
    const { service } = createGenerationDependencies({
      contentItems: [
        {
          contentId: 'D01',
          utcDate: '2030-01-01T00:00:00.000Z',
          themeKey: 'k',
          themeTitle: 't',
          platforms: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              platform: 'x',
              content: longTweet,
              media: null,
            },
          ],
        },
      ],
      engagePolicies: [],
      warnings: [],
    });

    const result = await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true });

    const trimmed = result.contentItems[0].platforms[0].content;
    expect(trimmed.length).toBeLessThanOrEqual(280);
    // Ends on a complete word (no trailing partial token / whitespace).
    expect(trimmed).toBe(trimmed.trimEnd());
    expect(trimmed.endsWith('lorem')).toBe(true);
  });

  it('uses the LLM shrink (targeting the soft budget) when OPERATION_SHRINK_MODEL is set', async () => {
    vi.stubEnv('OPERATION_SHRINK_MODEL', 'anthropic/claude-haiku-4.5');
    try {
      const { openaiService, service } = createGenerationDependencies({
        contentItems: [
          {
            contentId: 'D01',
            utcDate: '2030-01-01T00:00:00.000Z',
            themeKey: 'k',
            themeTitle: 't',
            platforms: [
              { id: '11111111-1111-4111-8111-111111111111', platform: 'x', content: 'a'.repeat(300), media: null },
            ],
          },
        ],
        engagePolicies: [],
        warnings: [],
      });
      // Haiku returns a coherent, in-budget rewrite → used verbatim, no trim.
      const rewrite = 'Concise rewrite that fits the budget.';
      openaiService.shrinkToLimit.mockResolvedValue(rewrite);

      const result = await service.create('org-1', 'proj-1', {
        taskId: 'task-1',
        startAt: '2030-01-01T00:00:00.000Z',
        endAt: '2030-01-02T00:00:00.000Z',
        platforms: ['x'],
      }, { dryRun: true });

      expect(openaiService.shrinkToLimit).toHaveBeenCalledWith(
        'a'.repeat(300),
        240, // soft target for x
        expect.objectContaining({ model: 'anthropic/claude-haiku-4.5' })
      );
      expect(result.contentItems[0].platforms[0].content).toBe(rewrite);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reuses OPENROUTER_INTENT_MODEL for the shrink when no dedicated model is set', async () => {
    vi.stubEnv('OPERATION_SHRINK_MODEL', '');
    vi.stubEnv('OPENROUTER_INTENT_MODEL', 'anthropic/claude-haiku-4.5');
    try {
      const { openaiService, service } = createGenerationDependencies({
        contentItems: [
          {
            contentId: 'D01',
            utcDate: '2030-01-01T00:00:00.000Z',
            themeKey: 'k',
            themeTitle: 't',
            platforms: [
              { id: '11111111-1111-4111-8111-111111111111', platform: 'x', content: 'a'.repeat(300), media: null },
            ],
          },
        ],
        engagePolicies: [],
        warnings: [],
      });
      openaiService.shrinkToLimit.mockResolvedValue('Concise rewrite.');

      await service.create('org-1', 'proj-1', {
        taskId: 'task-1',
        startAt: '2030-01-01T00:00:00.000Z',
        endAt: '2030-01-02T00:00:00.000Z',
        platforms: ['x'],
      }, { dryRun: true });

      expect(openaiService.shrinkToLimit).toHaveBeenCalledWith(
        'a'.repeat(300),
        240,
        expect.objectContaining({ model: 'anthropic/claude-haiku-4.5' })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to the mechanical trim when the LLM shrink still exceeds the ceiling', async () => {
    vi.stubEnv('OPERATION_SHRINK_MODEL', 'anthropic/claude-haiku-4.5');
    try {
      const { openaiService, service } = createGenerationDependencies({
        contentItems: [
          {
            contentId: 'D01',
            utcDate: '2030-01-01T00:00:00.000Z',
            themeKey: 'k',
            themeTitle: 't',
            platforms: [
              { id: '11111111-1111-4111-8111-111111111111', platform: 'x', content: 'a'.repeat(300), media: null },
            ],
          },
        ],
        engagePolicies: [],
        warnings: [],
      });
      // Haiku overshoots (still 290 > 280) → mechanical trim guarantees the limit.
      openaiService.shrinkToLimit.mockResolvedValue('a'.repeat(290));

      const result = await service.create('org-1', 'proj-1', {
        taskId: 'task-1',
        startAt: '2030-01-01T00:00:00.000Z',
        endAt: '2030-01-02T00:00:00.000Z',
        platforms: ['x'],
      }, { dryRun: true });

      const content = result.contentItems[0].platforms[0].content;
      expect(openaiService.shrinkToLimit).toHaveBeenCalled();
      expect(content.length).toBeLessThanOrEqual(280);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('counts X content by twitter-text weighting, so a URL costs 23 not its real length', async () => {
    // 200 plain chars + a 120-char URL = 321 raw (would wrongly reject), but
    // weighted = 200 + 1 + 23 = 224, comfortably under X's 280.
    const url = `https://example.com/${'p'.repeat(100)}`;
    const content = `${'a'.repeat(200)} ${url}`;
    expect(content.length).toBeGreaterThan(280); // raw length would wrongly reject
    const { repo, service } = createGenerationDependencies({
      contentItems: [
        {
          contentId: 'D01',
          utcDate: '2030-01-01T00:00:00.000Z',
          themeKey: 'k',
          themeTitle: 't',
          platforms: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              platform: 'x',
              content,
              media: null,
            },
          ],
        },
      ],
      engagePolicies: [],
      warnings: [],
    });

    const { background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });
    await background;

    // Accepted: weighted length is under 280, so generation completed and the
    // row advanced to BILLING_PENDING rather than FAILED.
    expect(repo.completeGeneration).toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({ status: 'FAILED' })
    );
  });

  it('declares the X character budget (240, under the 280 ceiling) TWICE — at the top and the bottom of the prompt', async () => {
    const { openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    const systemPrompt: string = openaiService.generateStructuredText.mock.calls[0][0];

    // The budget we instruct with is 240 — deliberately under X's real 280
    // ceiling (which validation still allows, to tolerate small overshoot).
    const budgetMentions = systemPrompt.match(/x: max 240 characters/g) ?? [];
    expect(budgetMentions).toHaveLength(2);

    // ...and they bracket the prompt: one near the top, one at the very end.
    const first = systemPrompt.indexOf('x: max 240 characters');
    const last = systemPrompt.lastIndexOf('x: max 240 characters');
    expect(first).toBeLessThan(systemPrompt.length / 2);
    expect(last).toBeGreaterThan(systemPrompt.length / 2);
    expect(systemPrompt).toContain('CHARACTER LIMITS — THE #1 CONSTRAINT');
    expect(systemPrompt).toContain('FINAL REMINDER — CHARACTER LIMITS');

    expect(systemPrompt).toContain('WEIGHTED counting');
    expect(systemPrompt).toMatch(/PLAIN TEXT for X: no Markdown/);
  });

  // P2(9): a single scalar target could not express the reference plan's
  // "weekday 5 / weekend 3" rhythm. dailyTargets carries it, keyed by concrete
  // UTC date (no week abstraction — the week is derivable from the date).
  it('persists dailyTargets alongside the default targetRepliesPerDay', async () => {
    const { repo, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [
        {
          platform: 'x',
          themeTitle: 'GEO answers',
          targetRepliesPerDay: 6,
          dailyTargets: [{ date: '2030-01-02', target: 3 }],
          keywordTargets: [],
          enabled: true,
        },
      ],
      warnings: [],
    });

    const { background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });
    await background;

    // The generated payload is written on completeGeneration (the stub create()
    // persisted first carried empty payloads).
    const policy = repo.completeGeneration.mock.calls[0][1].planPayload.engagePolicies[0];
    expect(policy.targetRepliesPerDay).toBe(6); // default for un-overridden days
    expect(policy.dailyTargets).toEqual([{ date: '2030-01-02', target: 3 }]);
  });

  it('rejects a dailyTargets date outside the plan range', async () => {
    const { repo, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [
        {
          platform: 'x',
          themeTitle: 't',
          targetRepliesPerDay: 6,
          dailyTargets: [{ date: '2030-02-15', target: 3 }], // outside [01-01, 01-02]
          keywordTargets: [],
          enabled: true,
        },
      ],
      warnings: [],
    });

    // Validation is shared with the persist path; the preview enforces it
    // synchronously, which is the deterministic way to assert the message.
    await expect(service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true })).rejects.toThrow(/dailyTargets date 2030-02-15 outside the requested range/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a repeated dailyTargets date', async () => {
    const { service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [
        {
          platform: 'x',
          themeTitle: 't',
          targetRepliesPerDay: 6,
          dailyTargets: [
            { date: '2030-01-02', target: 3 },
            { date: '2030-01-02', target: 4 },
          ],
          keywordTargets: [],
          enabled: true,
        },
      ],
      warnings: [],
    });

    await expect(service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true })).rejects.toThrow(/repeats dailyTargets date 2030-01-02/);
  });

  it('tells the generator to express the weekday/weekend rhythm via dated dailyTargets', async () => {
    const { openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    const systemPrompt: string = openaiService.generateStructuredText.mock.calls[0][0];
    expect(systemPrompt).toContain('dailyTargets');
    expect(systemPrompt).toMatch(/UTC "YYYY-MM-DD"/);
  });

  // P0-2: an admin allowlist that can only NARROW the connected platform set.
  it('rejects a platform that is connected but not on the Settings allowlist', async () => {
    const { repo, settingsService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    settingsService.get.mockImplementation(async (key: string) =>
      key === 'operation_plan.allowed_platforms' ? ['linkedin'] : undefined
    );

    await expect(service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'], // connected (repo mock), but not allowlisted
    })).rejects.toMatchObject({
      response: { code: 'PLATFORM_NOT_ALLOWED', platforms: ['x'], allowed: ['linkedin'] },
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('treats an empty/absent allowlist as "no extra restriction"', async () => {
    const { repo, settingsService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    settingsService.get.mockImplementation(async (key: string) =>
      key === 'operation_plan.allowed_platforms' ? [] : undefined
    );

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });
    expect(repo.create).toHaveBeenCalled();
  });

  it('accepts a platform with no connected account (publishing is by platform, not OAuth)', async () => {
    const { repo, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    // 'reddit' is NOT in the getConnectedPlatforms mock (['x']). With the
    // connectivity gate removed it must still be accepted — the plugin publishes
    // by platform, and materialize creates the post with a null integrationId.
    const result = await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['reddit'],
    });
    expect(result.status).toBe('GENERATING');
    expect(repo.create).toHaveBeenCalled();
  });

  // P2-10: the configured playbook is an INPUT to generation.
  it('feeds the Settings platform cadence for the requested platforms into the prompt', async () => {
    const { openaiService, settingsService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    settingsService.get.mockImplementation(async (key: string) =>
      key === 'operation_plan.platform_cadence'
        ? {
            x: { cadence: '2 posts per weekday', citationWeight: 'high' },
            linkedin: { cadence: 'weekly' }, // not requested → must not be sent
          }
        : undefined
    );

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    const [systemPrompt, userPrompt] = openaiService.generateStructuredText.mock.calls[0];
    const payload = JSON.parse(userPrompt);
    expect(payload.platformPlaybook).toEqual({
      x: { cadence: '2 posts per weekday', citationWeight: 'high' },
    });
    expect(systemPrompt).toContain('platformPlaybook');
  });

  it('omits the playbook instruction when no requested platform has cadence configured', async () => {
    const { openaiService, settingsService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    settingsService.get.mockImplementation(async (key: string) =>
      key === 'operation_plan.platform_cadence' ? {} : undefined
    );

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    const [systemPrompt, userPrompt] = openaiService.generateStructuredText.mock.calls[0];
    expect(JSON.parse(userPrompt).platformPlaybook).toEqual({});
    expect(systemPrompt).not.toContain('platformPlaybook');
  });

  it('warns the generator that multi-word hashtags break on X', async () => {
    const { openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    const systemPrompt: string = openaiService.generateStructuredText.mock.calls[0][0];
    expect(systemPrompt).toMatch(/hashtag ENDS at the first space/);
  });

  it('feeds request keywords to the generator verbatim when provided', async () => {
    const { openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
      keywords: ['GEO', 'AI search'],
    });

    const userPrompt = JSON.parse(openaiService.generateStructuredText.mock.calls[0][1]);
    expect(userPrompt.keywords).toEqual(['GEO', 'AI search']);
  });

  it('prefers result.code_web_analyzer.keywords over product_snapshot.keywords when the request omits keywords', async () => {
    const { openaiService, aiseeClient, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    aiseeClient.getTaskDetail.mockResolvedValue({
      ok: true,
      task: {
        id: 'task-1',
        userId: 'owner-1',
        productId: 'proj-1',
        status: 'completed',
        result: {
          summary: 'usable',
          code_web_analyzer: { keywords: ['AI agent framework', 'cognitive interface'] },
        },
        productSnapshot: { name: 'Product', keywords: ['snapshot-kw-1', 'snapshot-kw-2'] },
        version: 'v1',
      },
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
      // no keywords
    });

    const userPrompt = JSON.parse(openaiService.generateStructuredText.mock.calls[0][1]);
    expect(userPrompt.keywords).toEqual(['AI agent framework', 'cognitive interface']);
  });

  it('falls back to product_snapshot.keywords when neither request keywords nor code_web_analyzer keywords exist', async () => {
    const { openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
      // no keywords; default task.result has no code_web_analyzer
    });

    const userPrompt = JSON.parse(openaiService.generateStructuredText.mock.calls[0][1]);
    expect(userPrompt.keywords).toEqual(['snapshot-kw-1', 'snapshot-kw-2']);
  });

  it('falls back to product_snapshot.keywords when the request keywords array is empty', async () => {
    const { openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
      keywords: [],
    });

    const userPrompt = JSON.parse(openaiService.generateStructuredText.mock.calls[0][1]);
    expect(userPrompt.keywords).toEqual(['snapshot-kw-1', 'snapshot-kw-2']);
  });

  it('maps engagePolicies keywordTargets from keyword TEXT to EngageKeyword.id on the persist path', async () => {
    const generatedPlan = {
      contentItems: [],
      engagePolicies: [
        {
          platform: 'x',
          themeTitle: 'GEO answers',
          targetRepliesPerDay: 5,
          keywordTargets: [
            { keyword: 'GEO', target: 3 },
            { keyword: 'AI search', target: 2 },
          ],
          enabled: true,
        },
      ],
      warnings: [],
    };
    const { repo, engageRepository, service } = createGenerationDependencies(generatedPlan);
    engageRepository.resolveOrCreateKeywordIds.mockResolvedValue({
      GEO: 'kw-1',
      'AI search': 'kw-2',
    });

    const { background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });
    await background;

    expect(engageRepository.resolveOrCreateKeywordIds).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      ['GEO', 'AI search']
    );
    // planPayload persisted to the DB (via completeGeneration) carries
    // EngageKeyword.id keys, not text.
    const persisted = repo.completeGeneration.mock.calls[0][1].planPayload;
    expect(persisted.engagePolicies[0].keywordTargets).toEqual({ 'kw-1': 3, 'kw-2': 2 });
  });

  it('persists a data goal from the LLM goal + source total_score (baseline rounded, targetScore clamped up to baseline)', async () => {
    const { repo, aiseeClient, service } = createGenerationDependencies({
      // targetScore below the baseline must be clamped UP to the baseline.
      goal: { title: 'GEO push', description: 'Attack the weakest gaps', targetScore: 30 },
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    aiseeClient.getTaskDetail.mockResolvedValue({
      ok: true,
      task: {
        id: 'task-1',
        userId: 'owner-1',
        productId: 'proj-1',
        status: 'completed',
        result: { result: { total_score: 48.031363636363636 } },
        productSnapshot: {},
        version: 'v1',
      },
    });

    const { background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });
    await background;

    expect(repo.completeGeneration.mock.calls[0][1].data).toEqual({
      title: 'GEO push',
      description: 'Attack the weakest gaps',
      baselineScore: 48.03, // rounded to 2dp
      targetScore: 48.03, // clamped up from 30
    });
  });

  it('clamps a targetScore above 100 down to 100', async () => {
    const { repo, service } = createGenerationDependencies({
      goal: { title: 'T', description: 'D', targetScore: 150 },
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    const { background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });
    await background;

    expect(repo.completeGeneration.mock.calls[0][1].data.targetScore).toBe(100);
  });

  it('dryRun returns the goal data (baselineScore null when the task has no total_score)', async () => {
    const { service } = createGenerationDependencies({
      goal: { title: 'T', description: 'D', targetScore: 65 },
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });

    const result = await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true });

    expect(result.data).toEqual({
      title: 'T',
      description: 'D',
      baselineScore: null,
      targetScore: 65,
    });
  });

  it('dryRun keeps keyword TEXT keys and never creates keywords', async () => {
    const generatedPlan = {
      contentItems: [],
      engagePolicies: [
        {
          platform: 'x',
          themeTitle: 'GEO answers',
          targetRepliesPerDay: 5,
          keywordTargets: [{ keyword: 'GEO', target: 3 }],
          enabled: true,
        },
      ],
      warnings: [],
    };
    const { engageRepository, service } = createGenerationDependencies(generatedPlan);

    const result = await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true });

    // Preview must not create/resolve keyword rows; targets stay text-keyed.
    expect(engageRepository.resolveOrCreateKeywordIds).not.toHaveBeenCalled();
    expect(result.engagePolicies[0].keywordTargets).toEqual({ GEO: 3 });
  });

  it('dryRun on an already-planned task returns the existing plan read-only (no generation/billing/materialization)', async () => {
    const { repo, creditService, openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    repo.findByTaskId.mockResolvedValue({
      id: 'plan-1',
      organizationId: 'org-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      campaignId: 'campaign-1',
      platforms: ['x'],
      generatorVersion: 'operation-plan-v1',
      status: 'READY',
      startsAt: new Date('2030-01-01T00:00:00.000Z'),
      endsAt: new Date('2030-01-02T00:00:00.000Z'),
      planPayload: { contentItems: [], engagePolicies: [], warnings: [] },
      sourceTaskVersion: null,
      billingTransactionId: 'txn-1',
      creditAmount: '1.250000',
      errorCode: null,
    });

    const result = await service.create('org-1', 'proj-1', {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    }, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.id).toBe('plan-1');
    // A preview must never regenerate, reconcile billing, or (re)materialize.
    expect(openaiService.generateStructuredText).not.toHaveBeenCalled();
    expect(repo.materializePlanPosts).not.toHaveBeenCalled();
    expect(creditService.deductUsageAndConfirm).not.toHaveBeenCalled();
  });

  it('short-circuits an already-planned task (same params): returns the existing plan, no second create/generation/billing', async () => {
    const { repo, creditService, openaiService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    repo.findByTaskId.mockResolvedValue({
      id: 'plan-1',
      organizationId: 'org-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      campaignId: 'campaign-1',
      platforms: ['x'],
      generatorVersion: 'operation-plan-v1',
      status: 'READY',
      startsAt: new Date('2030-01-01T00:00:00.000Z'),
      endsAt: new Date('2030-01-02T00:00:00.000Z'),
      planPayload: { contentItems: [], engagePolicies: [], warnings: [] },
      sourceTaskVersion: null,
      billingTransactionId: 'txn-1',
      creditAmount: '1.250000',
      errorCode: null,
    });

    const { result, background } = await createAndSettle(service, {
      taskId: 'task-1',
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-02T00:00:00.000Z',
      platforms: ['x'],
    });

    expect(result.id).toBe('plan-1');
    expect(background).toBeUndefined(); // no background job spawned
    expect(repo.create).not.toHaveBeenCalled();
    expect(openaiService.generateStructuredText).not.toHaveBeenCalled();
    expect(creditService.deductUsageAndConfirm).not.toHaveBeenCalled();
  });

  it('resumeStuckGenerations re-drives a stuck GENERATING row through generation + billing in place (no second create, same billing key)', async () => {
    const { repo, creditService, service } = createGenerationDependencies({
      contentItems: [],
      engagePolicies: [],
      warnings: [],
    });
    const stuck = {
      id: 'plan-1',
      organizationId: 'org-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      campaignId: 'campaign-1',
      generatorVersion: 'operation-plan-v1',
      platforms: ['x'],
      status: 'GENERATING',
      startsAt: new Date('2030-01-01T00:00:00.000Z'),
      endsAt: new Date('2030-01-02T00:00:00.000Z'),
      planPayload: {},
      data: {},
    };
    repo.findStuckGenerating.mockResolvedValue([stuck]);

    // resumeStuckGenerations awaits every row's generation+billing internally.
    await service.resumeStuckGenerations();

    expect(repo.findStuckGenerating).toHaveBeenCalled();
    // The stuck row is advanced in place — never a second create().
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.completeGeneration).toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({ status: 'BILLING_PENDING' })
    );
    // Same billing key (the plan id) as the original attempt, so remote billing
    // dedupes rather than double-charging.
    expect(creditService.deductUsageAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'operation_plan:plan-1', relatedId: 'plan-1' }),
      expect.anything()
    );
    expect(repo.updateStatus).toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({ status: 'READY' })
    );
    expect(repo.materializePlanPosts).toHaveBeenCalled();
  });
});
