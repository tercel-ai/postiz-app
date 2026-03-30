export type AdditionalSetting = {
  title: string;
  description: string;
  type: string;
  value: any;
};

/**
 * Merge incoming settings into an existing additionalSettings JSON string.
 * Deduplicates by title (last-write-wins). Existing entries not present in
 * `incoming` are preserved unchanged.
 */
export function mergeAdditionalSettings(
  existing: string | null | undefined,
  incoming: AdditionalSetting[]
): string {
  const raw = parseAdditionalSettings(existing);
  const map = new Map(raw.map((s) => [s.title, s]));
  for (const entry of incoming) {
    map.set(entry.title, { ...map.get(entry.title), ...entry });
  }
  return JSON.stringify(Array.from(map.values()));
}

/**
 * Parse additionalSettings JSON into a typed array.
 * Returns [] on null / invalid JSON.
 */
export function parseAdditionalSettings(raw: string | null | undefined): AdditionalSetting[] {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}
