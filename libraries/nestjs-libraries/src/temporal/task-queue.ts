/**
 * Resolve the Temporal task queue for a social workflow.
 *
 * Modes (selected via TEMPORAL_WORKER_MODE):
 *   - 'merged' (default): all providers share a single 'social-activities' worker.
 *     Lower process overhead; platform-level rate limiting must be enforced
 *     elsewhere (e.g., in-activity semaphore) if needed.
 *   - 'per-provider': legacy mode — each provider runs on its own task queue,
 *     so maxConcurrentJob is enforced at the worker level per platform.
 */
export const SOCIAL_MERGED_TASK_QUEUE = 'social-activities';

export type TemporalWorkerMode = 'merged' | 'per-provider';

export function getTemporalWorkerMode(): TemporalWorkerMode {
  return process.env.TEMPORAL_WORKER_MODE === 'per-provider'
    ? 'per-provider'
    : 'merged';
}

export function getSocialTaskQueue(providerIdentifier: string): string {
  if (getTemporalWorkerMode() === 'per-provider') {
    return providerIdentifier.split('-')[0].toLowerCase();
  }
  return SOCIAL_MERGED_TASK_QUEUE;
}

/**
 * Parse ENABLED_PROVIDERS env var (comma-separated identifiers).
 * Empty/unset = no allowlist (all providers enabled — backward compatible).
 * Match is case-insensitive and accepts either full identifier ('linkedin-page')
 * or root identifier ('linkedin', which matches 'linkedin' and 'linkedin-page').
 */
export function getEnabledProviderAllowlist(): Set<string> | null {
  const raw = (process.env.ENABLED_PROVIDERS || '').trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isProviderEnabled(
  providerIdentifier: string,
  allowlist: Set<string> | null
): boolean {
  if (!allowlist) return true;
  const id = providerIdentifier.toLowerCase();
  const root = id.split('-')[0];
  return allowlist.has(id) || allowlist.has(root);
}

export interface RootWorkerSpec {
  maxConcurrentJob?: number;
}

/**
 * Derive per-root worker specs from an enabled-providers list. In per-provider
 * mode, one worker per root identifier is spawned — even when only sub-variants
 * are in the allowlist. Sub-variants route their activities to the root queue
 * (see getSocialTaskQueue), so the root worker must exist regardless of whether
 * the root itself is listed.
 *
 * When multiple variants map to the same root, the strictest (smallest)
 * maxConcurrentJob wins, which preserves the tightest rate limit.
 */
export function computeRootWorkerSpecs<
  P extends { identifier: string; maxConcurrentJob?: number }
>(enabledProviders: P[]): Map<string, RootWorkerSpec> {
  const specs = new Map<string, RootWorkerSpec>();
  for (const p of enabledProviders) {
    const root = p.identifier.split('-')[0].toLowerCase();
    const existing = specs.get(root);
    const candidate = p.maxConcurrentJob;
    if (!existing) {
      specs.set(root, { maxConcurrentJob: candidate });
      continue;
    }
    if (
      candidate !== undefined &&
      (existing.maxConcurrentJob === undefined ||
        candidate < existing.maxConcurrentJob)
    ) {
      specs.set(root, { maxConcurrentJob: candidate });
    }
  }
  return specs;
}
