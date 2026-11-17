import { describe, expect, it } from 'vitest';
import { latestDraft, savedDraftInput } from '../engage-draft-working-copy';

describe('human draft save provenance', () => {
  it('advances only the server-owned save timestamp and preserves omitted settings', () => {
    const previous = { strategy: 'QUESTION_LED', mentions: ['brand'], brandStrength: 2, _draftSavedAt: 'old' };
    const now = new Date('2026-11-17T12:00:00Z');
    expect(savedDraftInput(previous, { strategy: undefined, brandStrength: 1, _draftSavedAt: 'spoofed' }, now)).toEqual({
      strategy: 'QUESTION_LED', mentions: ['brand'], brandStrength: 1, _draftSavedAt: now.toISOString(),
    });
    expect(previous._draftSavedAt).toBe('old');
  });

  it('selects a saved older original over a newer-created historical copy', () => {
    const original = { id: 'original', createdAt: new Date('2026-11-01'), inputData: savedDraftInput({}, {}, new Date('2026-11-17')) };
    const historical = { id: 'historical', createdAt: new Date('2026-11-16'), inputData: {} };
    expect(latestDraft([historical, original])).toBe(original);
  });

  it('never infers a legacy content save from background metadata timestamps', () => {
    const original = { id: 'old', createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-18'), post: { updatedAt: new Date('2026-11-18') } };
    const latest = { id: 'new', createdAt: new Date('2026-11-17') };
    expect(latestDraft([original, latest])).toBe(latest);
  });

  it('uses the same creation and identity tie breaks independently of result order', () => {
    const a = { id: 'a', createdAt: new Date('2026-11-16'), inputData: { _draftSavedAt: '2026-11-17T12:00:00Z' } };
    const b = { ...a, id: 'b' };
    const older = { ...b, id: 'z', createdAt: new Date('2026-11-15') };
    expect(latestDraft([older, a, b])).toBe(b);
    expect(latestDraft([b, a, older])).toBe(b);
  });

  it('handles absent or malformed legacy JSON without falling back to metadata clocks', () => {
    for (const inputData of [null, [], 'text', { _draftSavedAt: 'invalid' }]) {
      const legacy = { id: 'old', createdAt: new Date('2026-11-01'), inputData };
      const latest = { id: 'new', createdAt: new Date('2026-11-17') };
      expect(latestDraft([legacy, latest])).toBe(latest);
    }
    expect(latestDraft([])).toBeNull();
  });
});
