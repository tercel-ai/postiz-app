import type { SettingsService } from '../database/prisma/settings/settings.service';

export const USER_PROVIDER_ALLOWLIST_KEY = 'providers.user_allowed_platforms';
export const LEGACY_PROVIDER_ALLOWLIST_KEY = 'operation_plan.allowed_platforms';

export type UserProviderPolicySource = 'global' | 'legacy' | 'default';

export async function resolveUserProviderPolicy(
  settings: Pick<SettingsService, 'get'>,
  registered: readonly string[],
): Promise<{ source: UserProviderPolicySource; allowedProviderIds: string[] }> {
  const configured = await settings.get(USER_PROVIDER_ALLOWLIST_KEY);
  if (configured !== null && configured !== undefined) {
    if (!Array.isArray(configured)) throw new Error('INVALID_USER_PROVIDER_ALLOWLIST');
    return {
      source: 'global',
      allowedProviderIds: registered.filter(id => configured.includes(id)),
    };
  }

  const legacy = await settings.get(LEGACY_PROVIDER_ALLOWLIST_KEY);
  const values = Array.isArray(legacy) ? legacy : typeof legacy === 'string' ? legacy.split(',') : [];
  const allowed = new Set(values.filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase()).filter(Boolean));
  if (allowed.size) {
    return { source: 'legacy', allowedProviderIds: registered.filter(id => allowed.has(id)) };
  }
  // Preserve the catalog when neither setting restricts existing providers.
  return { source: 'default', allowedProviderIds: [...registered] };
}
