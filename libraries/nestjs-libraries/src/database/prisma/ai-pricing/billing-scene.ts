import { AiseeBusinessSubType, AiseeBusinessType } from './aisee.client';

/**
 * A billing SCENE is the product action that burned the credits — the axis
 * operations actually asks about ("what did the editor autosuggestions cost us
 * last week?"), and the one no single BillingRecord column carries on its own.
 *
 * `businessType` alone is too coarse: ai_copywriting covers the editor popup,
 * the agent chat, calendar post generation AND Engage reference posts, four
 * flows with nothing in common operationally. `subType` splits some of them and
 * the rest of the split lives in the free-form `data` JSON (`surface`,
 * `source`). A scene is the declarative AND of all three, which is why it is
 * defined as data here instead of being hand-written per call site: the same
 * definition both LABELS a row (resolveBillingSceneId) and compiles into a SQL
 * predicate the admin list/stats endpoints filter on.
 *
 * Adding a billing call site means adding its scene here. A row matching no
 * scene is reported as BILLING_SCENE_OTHER rather than being hidden, so a
 * missing definition shows up as an unclassified bucket instead of silently
 * disappearing from the per-business totals.
 */
export interface BillingSceneDef {
  /** Stable key used by the API and by the aisee-manage filter. */
  id: string;
  /** Short operator-facing name. */
  label: string;
  /** What spend this scene represents, and where it is triggered from. */
  description: string;
  businessType: string;
  /** Omitted when the scene does not discriminate on subType. */
  subType?: string;
  /**
   * Matchers over the `data` JSON, ANDed together. A `null` in the value list
   * matches a row whose key is ABSENT — that is how legacy rows written before
   * the key existed keep landing in the scene they belong to instead of in
   * BILLING_SCENE_OTHER.
   */
  data?: Record<string, (string | null)[]>;
}

/** Bucket for rows no definition claims — an unbilled scene, not a hidden one. */
export const BILLING_SCENE_OTHER = 'other';

export const BILLING_SCENES: readonly BillingSceneDef[] = [
  {
    id: 'copilot_editor',
    label: 'Editor copilot',
    description:
      'Editor popup + CopilotTextarea autosuggestions (/copilot/chat). Accrued into one row per window instead of charged per request, so a row here covers many keystroke pauses.',
    businessType: AiseeBusinessType.AI_COPYWRITING,
    subType: AiseeBusinessSubType.CHAT,
    data: { surface: ['copilot_chat'] },
  },
  {
    id: 'agent_chat',
    label: 'Agent chat',
    description:
      'One deliberate /copilot/agent turn, charged per request. Rows without a `surface` predate the copilot/agent split and belong here.',
    businessType: AiseeBusinessType.AI_COPYWRITING,
    subType: AiseeBusinessSubType.CHAT,
    data: { surface: ['agent_chat', null] },
  },
  {
    id: 'post_generation',
    label: 'Post generation',
    description:
      'Calendar agent generating a post (text, plus its image when requested).',
    businessType: AiseeBusinessType.AI_COPYWRITING,
    subType: AiseeBusinessSubType.POST_GEN,
  },
  {
    id: 'engage_reference_post',
    label: 'Reference-post generation',
    description:
      'Post generated from a user-picked Engage opportunity used as inspiration.',
    businessType: AiseeBusinessType.AI_COPYWRITING,
    subType: AiseeBusinessSubType.POST_GEN_REFERENCE,
  },
  {
    id: 'image_generation_calendar',
    label: 'Image generation (calendar)',
    description:
      'Image generated from the calendar editor. Rows without a `source` predate the calendar/chat split and belong here (it was the only path).',
    businessType: AiseeBusinessType.IMAGE_GEN,
    subType: AiseeBusinessSubType.IMAGE,
    data: { source: ['calendar', null] },
  },
  {
    id: 'image_generation_chat',
    label: 'Image generation (chat)',
    description: 'Image generated from a chat / agent conversation.',
    businessType: AiseeBusinessType.IMAGE_GEN,
    subType: AiseeBusinessSubType.IMAGE,
    data: { source: ['chat'] },
  },
  {
    id: 'video_generation',
    label: 'Video generation',
    description:
      'Video generation. Not charged yet — KieAI cost integration is still open, so this scene is expected to be empty.',
    businessType: AiseeBusinessType.VIDEO_GEN,
  },
  {
    id: 'engage_reply',
    label: 'Engage reply draft',
    description:
      'Engage reply draft, priced by output length rather than by tokens. Counts against the monthly reply cap.',
    businessType: AiseeBusinessType.ENGAGE_REPLY,
  },
  {
    id: 'post_overage_engage',
    label: 'Post overage (Engage)',
    description:
      'A send beyond the plan limit that originated in Engage. Attributed to the engage channel in the aisee-core ledger.',
    businessType: AiseeBusinessType.POST_OVERAGE,
    data: { source: ['engage'] },
  },
  {
    id: 'post_overage_post',
    label: 'Post overage (calendar / chat)',
    description:
      'A send beyond the plan limit that originated in the calendar or chat. Attributed to the postiz channel.',
    businessType: AiseeBusinessType.POST_OVERAGE,
    data: { source: ['calendar', 'chat', null] },
  },
  {
    id: 'post_analytics',
    label: 'Post analytics sync',
    description:
      'One analytics-monitoring run for one integration, priced per platform.',
    businessType: AiseeBusinessType.POST_ANALYTICS,
  },
  {
    id: 'operation_plan',
    label: 'Operation plan generation',
    description:
      "A project's operation plan: the main generation plus every shrink call, billed as one multi-item transaction.",
    businessType: AiseeBusinessType.OPERATION_PLAN,
  },
];

/**
 * BillingRecord.status, with the operator-facing reading of each value. Mirrors
 * the schema comment on the column; `actionRequired` marks the ones a human has
 * to chase (a stuck charge or a delivered-but-unpaid reply), as opposed to the
 * healthy steady states (`accruing`, `reserved`) that merely look unfinished.
 */
export interface BillingStatusDef {
  id: string;
  label: string;
  description: string;
  actionRequired: boolean;
}

export const BILLING_STATUSES: readonly BillingStatusDef[] = [
  {
    id: 'success',
    label: 'Charged',
    description: 'Aisee deduction confirmed.',
    actionRequired: false,
  },
  {
    id: 'pending',
    label: 'Charging',
    description:
      'Row created, the Aisee call has not completed. A row stuck here is an unfinished charge.',
    actionRequired: true,
  },
  {
    id: 'failed',
    label: 'Charge failed',
    description:
      'Aisee deduction failed or was refunded. Retry from this list.',
    actionRequired: true,
  },
  {
    id: 'unbilled',
    label: 'Delivered, unpaid',
    description:
      'The reply went out but the Aisee charge failed. Still counts toward the cap so a billing outage cannot lift it.',
    actionRequired: true,
  },
  {
    id: 'accruing',
    label: 'Accruing',
    description:
      'Still accumulating cost in its window, not charged yet. A healthy steady state, NOT a stuck charge.',
    actionRequired: false,
  },
  {
    id: 'reserved',
    label: 'Reserved',
    description:
      'Engage reply draft reserved against the monthly cap, awaiting settle or release.',
    actionRequired: false,
  },
  {
    id: 'released',
    label: 'Released',
    description:
      'Reservation released because generation failed or was aborted. Uncounted.',
    actionRequired: false,
  },
  {
    id: 'skipped',
    label: 'Skipped',
    description: 'Aisee not configured (self-hosted) — nothing was charged.',
    actionRequired: false,
  },
  {
    id: 'internal',
    label: 'Internal',
    description:
      'BILL_TYPE=internal: covered by the subscription, no Aisee call.',
    actionRequired: false,
  },
];

/** Every `data` key any scene discriminates on — the grouping keys stats needs. */
export function billingSceneDataKeys(): string[] {
  const keys = new Set<string>();
  for (const scene of BILLING_SCENES) {
    for (const key of Object.keys(scene.data ?? {})) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

export function findBillingScene(id: string): BillingSceneDef | undefined {
  return BILLING_SCENES.find((scene) => scene.id === id);
}

function matchesSceneData(
  def: BillingSceneDef,
  data: Record<string, unknown> | null | undefined
): boolean {
  for (const [key, values] of Object.entries(def.data ?? {})) {
    const raw = data?.[key];
    const actual = raw === undefined || raw === null ? null : String(raw);
    if (!values.includes(actual)) {
      return false;
    }
  }
  return true;
}

/**
 * Label one record. Kept deliberately tolerant of partial rows: the stats
 * endpoint resolves scenes from a grouped projection that carries only
 * businessType, subType and the scene data keys.
 */
export function resolveBillingSceneId(record: {
  businessType: string;
  subType?: string | null;
  data?: unknown;
}): string {
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;

  const scene = BILLING_SCENES.find(
    (def) =>
      def.businessType === record.businessType &&
      (def.subType === undefined || def.subType === (record.subType ?? null)) &&
      matchesSceneData(def, data)
  );

  return scene?.id ?? BILLING_SCENE_OTHER;
}
