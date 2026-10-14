export const OPERATION_PLAN_PLATFORM_CADENCE_KEY = 'operation_plan.platform_cadence';

export type PlatformCadence = {
  cadence?: string;
  citationWeight?: string;
  notes?: string;
};

// Editorial guidance shared by generation and the admin settings response.
export const DEFAULT_PLATFORM_CADENCE: Record<string, PlatformCadence> = {
  x: {
    cadence: '1 post per weekday, lighter on weekends; 1-2 threads per week',
    citationWeight: 'medium — Grok reads X directly; threads split into data points are more quotable',
  },
  linkedin: {
    cadence: '3-4 posts per week',
    citationWeight: 'medium — B2B authority signal',
  },
  instagram: {
    cadence: '3-5 posts per week',
    citationWeight: 'low — rarely cited as a text source',
  },
  reddit: {
    cadence: '2-3 self-posts per week across relevant subreddits',
    citationWeight: 'high — Reddit threads are a top retrieval source for AI search engines',
  },
  medium: {
    cadence: '1-2 articles per week',
    citationWeight: 'medium — long-form articles get indexed and quoted',
  },
  devto: {
    cadence: '1-2 articles per week',
    citationWeight: 'medium — strong reach for developer topics via tag feeds',
  },
  hackernews: {
    cadence: '1-2 submissions per week',
    citationWeight: 'medium — high visibility when a submission lands; lead with substance, overt promotion is punished',
  },
  quora: {
    cadence: '2-3 answers per week',
    citationWeight: 'medium — Q&A format maps directly onto AI answer retrieval',
  },
};

const GENERIC_PLATFORM_CADENCE: PlatformCadence = { cadence: '2-3 posts per week' };
const GUIDANCE_FIELDS = ['cadence', 'citationWeight', 'notes'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Personal profiles and company pages share one generation slot.
export function canonicalOperationPlanPlatform(platform: string): string {
  return platform === 'linkedin-page' ? 'linkedin' : platform;
}

function configuredGuidance(config: Record<string, unknown>, platform: string): PlatformCadence | undefined {
  const entry = Object.prototype.hasOwnProperty.call(config, platform)
    ? config[platform]
    : undefined;
  if (!isObject(entry)) return undefined;
  const guidance: PlatformCadence = {};
  for (const field of GUIDANCE_FIELDS) {
    const value = entry[field];
    if (typeof value === 'string' && value.trim()) guidance[field] = value;
  }
  return Object.keys(guidance).length ? guidance : undefined;
}

/** Resolve configured entries before built-in and generic publishing guidance. */
export function resolvePlatformCadence(
  platforms: readonly string[],
  configured: unknown
): Record<string, PlatformCadence> {
  const config = isObject(configured) ? configured : {};
  const canonicalPlatforms = [...new Set(platforms.map(canonicalOperationPlanPlatform))];
  return Object.fromEntries(canonicalPlatforms.map((platform) => {
    const guidance = configuredGuidance(config, platform)
      ?? (platform === 'linkedin' ? configuredGuidance(config, 'linkedin-page') : undefined);
    const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_PLATFORM_CADENCE, platform)
      ? DEFAULT_PLATFORM_CADENCE[platform]
      : GENERIC_PLATFORM_CADENCE;
    // A configured entry replaces the whole entry; fields are not merged.
    return [platform, guidance ?? { ...fallback }];
  }));
}
