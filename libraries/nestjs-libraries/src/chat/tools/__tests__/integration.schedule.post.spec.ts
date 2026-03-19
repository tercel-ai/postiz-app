import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntegrationSchedulePostTool } from '../integration.schedule.post';
import { RuntimeContext } from '@mastra/core/di';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockOrg = { id: 'org-test-001', name: 'TestOrg' };

function mockIntegration(
  id: string,
  provider: string,
  overrides: Record<string, any> = {}
) {
  return {
    id,
    name: `Test ${provider}`,
    providerIdentifier: provider,
    token: 'mock-token',
    internalId: `internal-${id}`,
    organizationId: mockOrg.id,
    ...overrides,
  };
}

const linkedinIntegration = mockIntegration('int-linkedin-001', 'linkedin');
const xIntegration = mockIntegration('int-x-001', 'x');

const mockPostsService = {
  createPost: vi.fn().mockResolvedValue([
    { postId: 'post-001', integration: 'int-linkedin-001' },
  ]),
};

const mockIntegrationService = {
  getIntegrationById: vi.fn().mockImplementation((_orgId: string, id: string) => {
    const map: Record<string, any> = {
      'int-linkedin-001': linkedinIntegration,
      'int-x-001': xIntegration,
    };
    return Promise.resolve(map[id] || null);
  }),
};

// Minimal mock of socialIntegrationList — patched at module level
vi.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  socialIntegrationList: [
    {
      identifier: 'linkedin',
      dto: null,
      maxLength: () => 3000,
    },
    {
      identifier: 'x',
      dto: null,
      maxLength: (isPremium: boolean) => (isPremium ? 25000 : 280),
    },
  ],
}));

vi.mock('@gitroom/nestjs-libraries/chat/auth.context', () => ({
  checkAuth: vi.fn(),
}));

vi.mock('@gitroom/helpers/utils/strip.html.validation', () => ({
  stripHtmlValidation: (_fmt: string, content: string) =>
    content.replace(/<[^>]+>/g, ''),
}));

vi.mock('@gitroom/helpers/utils/count.length', () => ({
  weightedLength: (text: string) => text.length,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRuntimeContext() {
  const ctx = new RuntimeContext();
  ctx.set('organization' as never, JSON.stringify(mockOrg) as never);
  ctx.set('ui' as never, 'true' as never);
  return ctx;
}

function buildArgs(socialPost: any[]) {
  return {
    context: { socialPost },
    runtimeContext: buildRuntimeContext(),
  };
}

function htmlP(text: string) {
  return `<p>${text}</p>`;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('IntegrationSchedulePostTool', () => {
  let tool: ReturnType<IntegrationSchedulePostTool['run']>;

  beforeEach(() => {
    vi.clearAllMocks();
    const instance = new IntegrationSchedulePostTool(
      mockPostsService as any,
      mockIntegrationService as any
    );
    tool = instance.run();
  });

  // ── Group A: Direct Schedule Requests ──────────────────────────────

  describe('A: Direct Schedule Requests', () => {
    it('A1: schedule — explicit future time on LinkedIn', async () => {
      const tomorrow10am = new Date();
      tomorrow10am.setDate(tomorrow10am.getDate() + 1);
      tomorrow10am.setHours(10, 0, 0, 0);
      const dateStr = tomorrow10am.toISOString();

      const result = await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: dateStr,
            shortLink: false,
            type: 'schedule',
            postsAndComments: [
              {
                content: htmlP(
                  "AI isn't replacing developers — it's empowering every developer to become a 10x engineer. What do you think?"
                ),
                attachments: [],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      expect(mockIntegrationService.getIntegrationById).toHaveBeenCalledWith(
        mockOrg.id,
        'int-linkedin-001'
      );
      expect(mockPostsService.createPost).toHaveBeenCalledTimes(1);

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.type).toBe('schedule');
      expect(callArg.date).toBe(dateStr);
      expect(callArg.posts[0].integration).toBe(linkedinIntegration);
      expect(result).toHaveProperty('output');
    });

    it('A2: post now — immediate publish on X', async () => {
      const nowStr = new Date().toISOString();

      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-x-001',
            isPremium: false,
            date: nowStr,
            shortLink: false,
            type: 'now',
            postsAndComments: [
              {
                content: htmlP(
                  'Just cut build time from 3min to 18s. Tree shaking FTW! #DevOps'
                ),
                attachments: [],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.type).toBe('now');
    });

    it('A3: draft — save without publishing', async () => {
      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'draft',
            postsAndComments: [
              {
                content: htmlP(
                  '3 years of remote work: async communication beats synchronous meetings by 10x.'
                ),
                attachments: [],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.type).toBe('draft');
    });
  });

  // ── Group C: Multi-Channel / Multi-Post ────────────────────────────

  describe('C: Multi-Channel / Multi-Post', () => {
    it('C1: same content to LinkedIn + X simultaneously', async () => {
      mockPostsService.createPost
        .mockResolvedValueOnce([{ postId: 'p1', integration: 'int-linkedin-001' }])
        .mockResolvedValueOnce([{ postId: 'p2', integration: 'int-x-001' }]);

      const content = htmlP(
        'Free doesn\'t mean no cost. Maintaining open-source requires time, community management, and docs.'
      );

      const result = await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'now',
            postsAndComments: [{ content, attachments: [] }],
            settings: [],
          },
          {
            integrationId: 'int-x-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'now',
            postsAndComments: [{ content, attachments: [] }],
            settings: [],
          },
        ]),
        {} as any
      );

      expect(mockPostsService.createPost).toHaveBeenCalledTimes(2);
      expect(result.output).toHaveLength(2);
    });

    it('C2: X thread — 3 posts in postsAndComments array', async () => {
      mockPostsService.createPost.mockResolvedValueOnce([
        { postId: 'thread-001', integration: 'int-x-001' },
      ]);

      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-x-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'now',
            postsAndComments: [
              {
                content: htmlP("Don't use PostgreSQL for everything."),
                attachments: [],
              },
              {
                content: htmlP('ClickHouse excels at time-series data.'),
                attachments: [],
              },
              {
                content: htmlP('Neo4j solves graph data problems elegantly.'),
                attachments: [],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      expect(mockPostsService.createPost).toHaveBeenCalledTimes(1);
      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.posts[0].value).toHaveLength(3);
    });

    it('C3: batch schedule — 5 posts across weekdays', async () => {
      const topics = [
        'Methods for quantifying technical debt',
        'How to promote ADR within teams',
        '5 prerequisites for monolith to microservices',
        'Backward compatibility in API design',
        'Production incident post-mortem best practices',
      ];

      for (let i = 0; i < 5; i++) {
        mockPostsService.createPost.mockResolvedValueOnce([
          { postId: `batch-${i}`, integration: 'int-linkedin-001' },
        ]);
      }

      const baseDate = new Date();
      const posts = topics.map((topic, i) => {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i + 1);
        d.setHours(9, 0, 0, 0);
        return {
          integrationId: 'int-linkedin-001',
          isPremium: false,
          date: d.toISOString(),
          shortLink: false,
          type: 'schedule' as const,
          postsAndComments: [{ content: htmlP(topic), attachments: [] }],
          settings: [],
        };
      });

      const result = await tool.execute!(buildArgs(posts), {} as any);

      expect(mockPostsService.createPost).toHaveBeenCalledTimes(5);
      expect(result.output).toHaveLength(5);

      // Verify each has type=schedule and different dates
      for (let i = 0; i < 5; i++) {
        const callArg = mockPostsService.createPost.mock.calls[i][1];
        expect(callArg.type).toBe('schedule');
      }
    });
  });

  // ── Group D: With Attachments ──────────────────────────────────────

  describe('D: With Attachments', () => {
    it('D1: schedule with image attachment', async () => {
      const imageUrl = 'https://cdn.example.com/devops-culture.png';

      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'schedule',
            postsAndComments: [
              {
                content: htmlP(
                  'DevOps is not a role — it\'s a culture of shared ownership between dev and ops.'
                ),
                attachments: [imageUrl],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      const images = callArg.posts[0].value[0].image;
      expect(images).toHaveLength(1);
      expect(images[0].path).toBe(imageUrl);
    });

    it('D2: post with user-provided image — no generation', async () => {
      const userImageUrl = 'https://example.com/my-diagram.png';

      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'now',
            postsAndComments: [
              {
                content: htmlP('Here is our architecture diagram for the new system.'),
                attachments: [userImageUrl],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.posts[0].value[0].image[0].path).toBe(userImageUrl);
    });
  });

  // ── Group E: Edge Cases ────────────────────────────────────────────

  describe('E: Edge Cases', () => {
    it('E1: integration not found — returns error', async () => {
      mockIntegrationService.getIntegrationById.mockResolvedValueOnce(null);

      const result = await tool.execute!(
        buildArgs([
          {
            integrationId: 'non-existent-id',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'now',
            postsAndComments: [
              { content: htmlP('Test'), attachments: [] },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      expect(result).toHaveProperty('errors');
      expect(result.errors).toContain('non-existent-id');
      expect(mockPostsService.createPost).not.toHaveBeenCalled();
    });

    it('E2: empty socialPost array — no createPost calls', async () => {
      const result = await tool.execute!(buildArgs([]), {} as any);

      expect(mockPostsService.createPost).not.toHaveBeenCalled();
      expect(result.output).toHaveLength(0);
    });

    it('E3: multiple attachments on a single post', async () => {
      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'now',
            postsAndComments: [
              {
                content: htmlP('Product launch gallery'),
                attachments: [
                  'https://cdn.example.com/img1.png',
                  'https://cdn.example.com/img2.png',
                  'https://cdn.example.com/img3.png',
                ],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.posts[0].value[0].image).toHaveLength(3);
    });

    it('E4: post with settings (key-value pairs)', async () => {
      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'schedule',
            postsAndComments: [
              { content: htmlP('Post with custom settings'), attachments: [] },
            ],
            settings: [
              { key: 'visibility', value: 'PUBLIC' },
              { key: 'feedDistribution', value: 'MAIN_FEED' },
            ],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      const settings = callArg.posts[0].settings;
      expect(settings.visibility).toBe('PUBLIC');
      expect(settings.feedDistribution).toBe('MAIN_FEED');
      expect(settings.__type).toBe('linkedin');
    });

    it('E5: shortLink flag is passed through', async () => {
      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: true,
            type: 'now',
            postsAndComments: [
              {
                content: htmlP(
                  'Check out our blog: https://example.com/very-long-url/with/many/segments'
                ),
                attachments: [],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.shortLink).toBe(true);
    });
  });

  // ── Group F: Real-World Discussion Topics ──────────────────────────

  describe('F: Real-World Discussion Topics', () => {
    it('F1: tech opinion — AI and programming (LinkedIn + X)', async () => {
      mockPostsService.createPost
        .mockResolvedValueOnce([{ postId: 'f1-li', integration: 'int-linkedin-001' }])
        .mockResolvedValueOnce([{ postId: 'f1-x', integration: 'int-x-001' }]);

      const tomorrow9am = new Date();
      tomorrow9am.setDate(tomorrow9am.getDate() + 1);
      tomorrow9am.setHours(9, 0, 0, 0);

      const linkedinContent = htmlP(
        "AI isn't changing programming itself — it's changing the barrier to entry. " +
        '10 years ago learning a framework took 3 months. With AI it might take 3 days. ' +
        "But deep thinking, architecture design, product judgment — AI can't do those yet."
      );

      // X version — shorter
      const xContent = htmlP(
        "AI changes the speed of programming, not programming itself. " +
        "Deep thinking and architecture design still require humans. " +
        "#AI #SoftwareEngineering"
      );

      const result = await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: tomorrow9am.toISOString(),
            shortLink: false,
            type: 'schedule',
            postsAndComments: [{ content: linkedinContent, attachments: [] }],
            settings: [],
          },
          {
            integrationId: 'int-x-001',
            isPremium: false,
            date: tomorrow9am.toISOString(),
            shortLink: false,
            type: 'schedule',
            postsAndComments: [{ content: xContent, attachments: [] }],
            settings: [],
          },
        ]),
        {} as any
      );

      expect(mockPostsService.createPost).toHaveBeenCalledTimes(2);
      expect(result.output).toHaveLength(2);
    });

    it('F2: product launch announcement with image', async () => {
      const nextWed = new Date();
      nextWed.setDate(nextWed.getDate() + ((3 + 7 - nextWed.getDay()) % 7 || 7));
      nextWed.setHours(10, 0, 0, 0);

      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-linkedin-001',
            isPremium: false,
            date: nextWed.toISOString(),
            shortLink: false,
            type: 'schedule',
            postsAndComments: [
              {
                content:
                  '<p><strong>Announcing v2.0!</strong></p>' +
                  '<ul><li>Brand new dashboard</li>' +
                  '<li>20+ social platforms</li>' +
                  '<li>AI-powered scheduling</li></ul>' +
                  '<p>Try it today!</p>',
                attachments: ['https://cdn.example.com/v2-screenshot.png'],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.type).toBe('schedule');
      expect(callArg.posts[0].value[0].image).toHaveLength(1);
    });

    it('F3: quick tweet — minimal input', async () => {
      await tool.execute!(
        buildArgs([
          {
            integrationId: 'int-x-001',
            isPremium: false,
            date: new Date().toISOString(),
            shortLink: false,
            type: 'now',
            postsAndComments: [
              {
                content: htmlP('Ship fast, learn faster. 🚀'),
                attachments: [],
              },
            ],
            settings: [],
          },
        ]),
        {} as any
      );

      const callArg = mockPostsService.createPost.mock.calls[0][1];
      expect(callArg.type).toBe('now');
      expect(callArg.posts[0].value[0].content).toContain('Ship fast');
    });
  });
});
