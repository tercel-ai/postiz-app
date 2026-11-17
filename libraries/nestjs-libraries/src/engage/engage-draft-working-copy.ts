/** Server-owned provenance of a human draft save, separate from metadata updates. */
const DRAFT_SAVED_AT = '_draftSavedAt';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function savedDraftInput(previous: unknown, patch: unknown, now = new Date()) {
  const values = Object.fromEntries(Object.entries(object(patch)).filter(([, value]) => value !== undefined));
  return { ...object(previous), ...values, [DRAFT_SAVED_AT]: now.toISOString() };
}

type DraftIdentity = { id: string; createdAt?: Date; inputData?: unknown };

function createdAt(draft: DraftIdentity) {
  return draft.createdAt?.getTime() ?? 0;
}

function savedAt(draft: DraftIdentity) {
  const value = object(draft.inputData)[DRAFT_SAVED_AT];
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  // Legacy copies have no save provenance. Metadata timestamps cannot recover it.
  return Number.isFinite(time) ? time : createdAt(draft);
}

export function latestDraft<T extends DraftIdentity>(drafts: readonly T[]): T | null {
  return drafts.reduce<T | null>((best, draft) => {
    if (!best) return draft;
    const order = savedAt(draft) - savedAt(best) || createdAt(draft) - createdAt(best) || draft.id.localeCompare(best.id);
    return order > 0 ? draft : best;
  }, null);
}
