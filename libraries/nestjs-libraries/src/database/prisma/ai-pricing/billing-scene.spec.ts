import { describe, expect, it } from 'vitest';
import {
  AiseeBusinessSubType,
  AiseeBusinessType,
} from './aisee.client';
import {
  BILLING_SCENES,
  BILLING_SCENE_OTHER,
  BILLING_STATUSES,
  billingSceneDataKeys,
  resolveBillingSceneId,
} from './billing-scene';

// Each case mirrors what a real billing call site writes, so a call site that
// changes its subType or its `data` markers breaks the scene it belongs to here
// instead of quietly re-labelling months of spend in the admin view.
describe('resolveBillingSceneId', () => {
  it('separates the editor copilot from the agent chat on `surface` alone', () => {
    const shared = {
      businessType: AiseeBusinessType.AI_COPYWRITING,
      subType: AiseeBusinessSubType.CHAT,
    };

    expect(
      resolveBillingSceneId({ ...shared, data: { surface: 'copilot_chat' } })
    ).toBe('copilot_editor');
    expect(
      resolveBillingSceneId({ ...shared, data: { surface: 'agent_chat' } })
    ).toBe('agent_chat');
  });

  // The two chat surfaces only became distinguishable when `surface` was added.
  // Rows written before that are agent turns — the editor path did not exist.
  it('reads a chat row with no `surface` as the agent chat it predates', () => {
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.AI_COPYWRITING,
        subType: AiseeBusinessSubType.CHAT,
        data: {},
      })
    ).toBe('agent_chat');
  });

  it('splits post generation from reference-post generation', () => {
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.AI_COPYWRITING,
        subType: AiseeBusinessSubType.POST_GEN,
        data: { source: 'calendar' },
      })
    ).toBe('post_generation');
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.AI_COPYWRITING,
        subType: AiseeBusinessSubType.POST_GEN_REFERENCE,
        data: { platform: 'x' },
      })
    ).toBe('engage_reference_post');
  });

  it('splits image generation by where it was invoked', () => {
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.IMAGE_GEN,
        subType: AiseeBusinessSubType.IMAGE,
        data: { source: 'chat' },
      })
    ).toBe('image_generation_chat');
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.IMAGE_GEN,
        subType: AiseeBusinessSubType.IMAGE,
        data: { source: 'calendar' },
      })
    ).toBe('image_generation_calendar');
  });

  // The same split the ledger makes with Transaction.channel: an overage charged
  // for an Engage send belongs to Engage's cost, not the calendar's.
  it('attributes a post overage to Engage or to the calendar by `source`', () => {
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.POST_OVERAGE,
        data: { source: 'engage' },
      })
    ).toBe('post_overage_engage');
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.POST_OVERAGE,
        data: { source: 'chat' },
      })
    ).toBe('post_overage_post');
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.POST_OVERAGE,
        data: null,
      })
    ).toBe('post_overage_post');
  });

  it('resolves the scenes that need no marker at all', () => {
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.ENGAGE_REPLY,
        data: { length: 'short' },
      })
    ).toBe('engage_reply');
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.POST_ANALYTICS,
        data: { platform: 'reddit', integrationId: 'int-1' },
      })
    ).toBe('post_analytics');
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.OPERATION_PLAN,
        data: { bizType: 'operation_plan', projectId: 'proj-1' },
      })
    ).toBe('operation_plan');
  });

  // Unclassified must be a visible bucket, not a silent drop: it is how a new
  // billing call site with no scene definition announces itself.
  it('buckets a row no definition claims instead of guessing', () => {
    expect(
      resolveBillingSceneId({ businessType: 'brand_new_business', data: {} })
    ).toBe(BILLING_SCENE_OTHER);

    // ai_copywriting with no subType is genuinely ambiguous (chat? post_gen?),
    // so it must land in `other` rather than be assigned to either.
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.AI_COPYWRITING,
        subType: null,
        data: { surface: 'agent_chat' },
      })
    ).toBe(BILLING_SCENE_OTHER);
  });

  it('tolerates a non-object `data` column', () => {
    expect(
      resolveBillingSceneId({
        businessType: AiseeBusinessType.ENGAGE_REPLY,
        data: 'not-an-object',
      })
    ).toBe('engage_reply');
  });
});

describe('billing scene registry', () => {
  it('has unique ids that never collide with the unclassified bucket', () => {
    const ids = BILLING_SCENES.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(BILLING_SCENE_OTHER);
  });

  // A new AiseeBusinessType with no scene would land every one of its charges in
  // `other`, which is the one bucket operations cannot act on.
  it('covers every AiseeBusinessType', () => {
    const covered = new Set(BILLING_SCENES.map((scene) => scene.businessType));
    for (const businessType of Object.values(AiseeBusinessType)) {
      expect(covered).toContain(businessType);
    }
  });

  it('exposes every `data` key a scene discriminates on', () => {
    const keys = billingSceneDataKeys();
    const declared = new Set(
      BILLING_SCENES.flatMap((scene) => Object.keys(scene.data ?? {}))
    );
    expect(new Set(keys)).toEqual(declared);
    expect(keys).toEqual([...keys].sort());
  });

  it('flags only the statuses a human has to chase', () => {
    const actionRequired = BILLING_STATUSES.filter(
      (status) => status.actionRequired
    ).map((status) => status.id);

    expect(actionRequired.sort()).toEqual(
      ['failed', 'pending', 'unbilled'].sort()
    );
    // `accruing` and `reserved` look unfinished but are healthy steady states.
    expect(actionRequired).not.toContain('accruing');
    expect(actionRequired).not.toContain('reserved');
  });
});
