import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionsService } from '../permissions.service';
import { AuthorizationActions, Sections } from '../permission.exception.class';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMocks() {
  return {
    subscriptionService: {
      getSubscriptionByOrganizationId: vi.fn().mockResolvedValue(null),
      getSubscription: vi.fn().mockResolvedValue(null),
    },
    postsService: {
      countPostsFromDay: vi.fn().mockResolvedValue(0),
    },
    integrationService: {
      getIntegrationsList: vi.fn().mockResolvedValue([]),
    },
    webhooksService: {
      getTotal: vi.fn().mockResolvedValue(0),
    },
    usersService: {
      getUserLimits: vi.fn().mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 100,
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
      }),
    },
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  return new PermissionsService(
    mocks.subscriptionService as any,
    mocks.postsService as any,
    mocks.integrationService as any,
    mocks.webhooksService as any,
    mocks.usersService as any,
  );
}

/** Helper: check if an ability allows the given action+section */
function isAllowed(
  ability: any,
  action: AuthorizationActions,
  section: Sections,
): boolean {
  return ability.can(action, section);
}

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const CREATED_AT = new Date('2026-01-01');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionsService.check', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PermissionsService;
  const originalStripeKey = process.env.STRIPE_PUBLISHABLE_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  afterEach(() => {
    // Restore env
    if (originalStripeKey !== undefined) {
      process.env.STRIPE_PUBLISHABLE_KEY = originalStripeKey;
    } else {
      delete process.env.STRIPE_PUBLISHABLE_KEY;
    }
  });

  // =========================================================================
  // A. No-Stripe path (self-hosted / Aisee-only)
  // =========================================================================

  describe('without Stripe (Aisee user limits only)', () => {
    beforeEach(() => {
      delete process.env.STRIPE_PUBLISHABLE_KEY;
    });

    // -----------------------------------------------------------------------
    // CHANNEL limits
    // -----------------------------------------------------------------------

    it('allows adding channel when current channels < postChannelLimit', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 100,
      });
      // 2 existing channels, none need refresh
      mocks.integrationService.getIntegrationsList.mockResolvedValue([
        { id: '1', refreshNeeded: false },
        { id: '2', refreshNeeded: false },
      ]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
    });

    it('blocks adding channel when current channels >= postChannelLimit', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 3,
        postSendLimit: 100,
      });
      mocks.integrationService.getIntegrationsList.mockResolvedValue([
        { id: '1', refreshNeeded: false },
        { id: '2', refreshNeeded: false },
        { id: '3', refreshNeeded: false },
      ]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(false);
    });

    it('excludes refreshNeeded integrations from channel count', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 3,
        postSendLimit: 100,
      });
      // 3 integrations, but 1 needs refresh → effective count=2 < limit=3
      mocks.integrationService.getIntegrationsList.mockResolvedValue([
        { id: '1', refreshNeeded: false },
        { id: '2', refreshNeeded: false },
        { id: '3', refreshNeeded: true },
      ]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
    });

    it('blocks channel when postChannelLimit is 0', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 0,
        postSendLimit: 100,
      });
      mocks.integrationService.getIntegrationsList.mockResolvedValue([]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      // 0 channels, but limit is 0 → 0 < 0 is false → blocked
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // POSTS_PER_MONTH limits
    // -----------------------------------------------------------------------

    it('allows posting when postSendLimit > 0', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 100,
      });

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(true);
    });

    it('blocks posting when postSendLimit is 0 (no subscription)', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 0,
        postSendLimit: 0,
      });

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(false);
    });

    it('allows posting even when over limit (overage deducted post-creation)', async () => {
      // postSendLimit=10 but user has published 100 — still allowed
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 10,
      });

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]],
        USER_ID,
      );

      // Permission check doesn't count posts — it only checks postSendLimit > 0
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Combined checks
    // -----------------------------------------------------------------------

    it('checks both CHANNEL and POSTS_PER_MONTH in a single call', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 50,
      });
      mocks.integrationService.getIntegrationsList.mockResolvedValue([
        { id: '1', refreshNeeded: false },
      ]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [
          [AuthorizationActions.Create, Sections.CHANNEL],
          [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
        ],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(true);
    });

    it('allows channel but blocks posts when postSendLimit=0', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 0,
      });
      mocks.integrationService.getIntegrationsList.mockResolvedValue([]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [
          [AuthorizationActions.Create, Sections.CHANNEL],
          [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
        ],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // No userId — all permissions allowed (no user limits enforced)
    // -----------------------------------------------------------------------

    it('allows everything when no userId is provided', async () => {
      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [
          [AuthorizationActions.Create, Sections.CHANNEL],
          [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
        ],
        // no userId
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(true);
      expect(mocks.usersService.getUserLimits).not.toHaveBeenCalled();
    });

    it('allows non-channel/post sections without calling getUserLimits', async () => {
      const ability = await service.check(
        ORG_ID, CREATED_AT, 'ADMIN',
        [[AuthorizationActions.Create, Sections.ADMIN]],
        USER_ID,
      );

      // ADMIN section doesn't need user limits
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.ADMIN)).toBe(true);
      expect(mocks.usersService.getUserLimits).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // B. With Stripe — Aisee user limits take priority over subscription tier
  // =========================================================================

  describe('with Stripe (Aisee limits override subscription tier)', () => {
    beforeEach(() => {
      process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
    });

    // -----------------------------------------------------------------------
    // CHANNEL: Aisee limit takes priority
    // -----------------------------------------------------------------------

    it('uses Aisee postChannelLimit over subscription tier channel limit', async () => {
      // Subscription tier (STANDARD) allows 5 channels
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'STANDARD',
        totalChannels: 5,
      });
      // But Aisee says limit is 3
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 3,
        postSendLimit: 100,
      });
      // User already has 3 channels → at limit
      mocks.integrationService.getIntegrationsList.mockResolvedValue([
        { id: '1', refreshNeeded: false },
        { id: '2', refreshNeeded: false },
        { id: '3', refreshNeeded: false },
      ]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      // Aisee limit (3) wins over Stripe tier (5) → blocked at 3
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(false);
    });

    it('allows channel when under Aisee limit even if over Stripe tier', async () => {
      // Subscription tier (STANDARD) allows 5 channels
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'STANDARD',
        totalChannels: 5,
      });
      // Aisee says limit is 10
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 10,
        postSendLimit: 100,
      });
      // User has 7 channels (over STANDARD's 5, but under Aisee's 10)
      mocks.integrationService.getIntegrationsList.mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, refreshNeeded: false })),
      );

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      // Aisee limit (10) wins → 7 < 10 → allowed
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // CHANNEL: fallback to subscription tier when no Aisee limits
    // -----------------------------------------------------------------------

    it('falls back to subscription tier when Aisee postChannelLimit is null', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: null,
        postSendLimit: null,
      });
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'STANDARD',
        totalChannels: 5,
      });
      // 4 channels, STANDARD allows 5
      mocks.integrationService.getIntegrationsList.mockResolvedValue(
        Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, refreshNeeded: false })),
      );

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
    });

    it('blocks channel by subscription tier when at limit and no Aisee limits', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: null,
        postSendLimit: null,
      });
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'STANDARD',
        totalChannels: 5,
      });
      // 5 channels = at STANDARD limit
      mocks.integrationService.getIntegrationsList.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, refreshNeeded: false })),
      );

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // POSTS_PER_MONTH: Aisee limit takes priority
    // -----------------------------------------------------------------------

    it('allows posting when Aisee postSendLimit > 0 regardless of tier count', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 10,
      });
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'FREE',
      });
      // FREE tier has posts_per_month=0, but Aisee says 10 → allowed
      mocks.postsService.countPostsFromDay.mockResolvedValue(999);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(true);
    });

    it('blocks posting when Aisee postSendLimit is 0 even with paid tier', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 0,
      });
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'PRO',
      });

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]],
        USER_ID,
      );

      // Aisee says 0 → blocked, even though PRO tier would normally allow
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // POSTS_PER_MONTH: fallback to subscription tier
    // -----------------------------------------------------------------------

    it('falls back to subscription tier post count when Aisee postSendLimit is null', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: null,
        postSendLimit: null,
      });
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'STANDARD',
      });
      mocks.subscriptionService.getSubscription.mockResolvedValue({
        createdAt: new Date('2026-01-01'),
      });
      // STANDARD allows 400 posts/month, user has 399
      mocks.postsService.countPostsFromDay.mockResolvedValue(399);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(true);
    });

    it('blocks by subscription tier when at post limit and no Aisee limits', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: null,
        postSendLimit: null,
      });
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'STANDARD',
      });
      mocks.subscriptionService.getSubscription.mockResolvedValue({
        createdAt: new Date('2026-01-01'),
      });
      // STANDARD allows 400, user has 400
      mocks.postsService.countPostsFromDay.mockResolvedValue(400);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]],
        USER_ID,
      );

      expect(isAllowed(ability, AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // No userId with Stripe → no Aisee limits fetched, uses tier only
    // -----------------------------------------------------------------------

    it('does not fetch user limits when no userId provided', async () => {
      mocks.subscriptionService.getSubscriptionByOrganizationId.mockResolvedValue({
        subscriptionTier: 'STANDARD',
        totalChannels: 5,
      });
      mocks.integrationService.getIntegrationsList.mockResolvedValue([
        { id: '1', refreshNeeded: false },
      ]);

      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        // no userId
      );

      expect(mocks.usersService.getUserLimits).not.toHaveBeenCalled();
      expect(isAllowed(ability, AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
    });
  });

  // =========================================================================
  // C. Edge cases
  // =========================================================================

  describe('edge cases', () => {
    beforeEach(() => {
      delete process.env.STRIPE_PUBLISHABLE_KEY;
    });

    it('allows all when requestedPermission is empty', async () => {
      const ability = await service.check(
        ORG_ID, CREATED_AT, 'USER', [], USER_ID,
      );

      // Empty permissions → build with no rules → default deny in CASL
      // But the code grants all when requestedPermission.length === 0
      expect(mocks.usersService.getUserLimits).not.toHaveBeenCalled();
    });

    it('getUserLimits is called only once for multiple sections', async () => {
      mocks.usersService.getUserLimits.mockResolvedValue({
        postChannelLimit: 5,
        postSendLimit: 50,
      });
      mocks.integrationService.getIntegrationsList.mockResolvedValue([]);

      await service.check(
        ORG_ID, CREATED_AT, 'USER',
        [
          [AuthorizationActions.Create, Sections.CHANNEL],
          [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
        ],
        USER_ID,
      );

      expect(mocks.usersService.getUserLimits).toHaveBeenCalledTimes(1);
      expect(mocks.usersService.getUserLimits).toHaveBeenCalledWith(USER_ID);
    });
  });
});
