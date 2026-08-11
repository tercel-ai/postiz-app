/**
 * Display names for the platform badges in the popup/panel lists.
 *
 * Shared by the publish queue and the reply history on purpose: the two lists
 * used to keep private copies of this map and drifted apart, so a queue row for
 * a newer platform rendered its raw lowercase id ("medium") next to a reply row
 * that said "Medium". One list per platform, one label.
 *
 * Keys are the platform ids as they arrive from the SW (`SessionPlatform` /
 * `ScanTaskPlatform`); the badge class name uses the same id, so every key here
 * needs a matching `.pz-badge.<id>` colour rule in index.css.
 */
export const PLATFORM_LABEL: Record<string, string> = {
  x: 'X',
  reddit: 'Reddit',
  linkedin: 'LinkedIn',
  devto: 'Dev.to',
  hackernews: 'HN',
  medium: 'Medium',
  quora: 'Quora',
};

/** Label for a platform id, falling back to the raw id for anything new. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}
