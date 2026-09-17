import { describe, expect, it } from 'vitest';
import { isLiveScanUnit } from '../engage.repository';

// The single definition of "this cursor still corresponds to a unit". The
// diagnostic REPORTS rows by it and the housekeeping sweep DELETES rows by it,
// so a split definition would have them acting on different sets — and the
// failure that produces is not a missed row, it is a live unit deleted.

const live = {
    keywords: new Set(['ai visibility']),
    targets: new Set(['reddit:ui_design']),
};

describe('isLiveScanUnit', () => {
    it('matches a keyword unit on the normalized key alone', () => {
        expect(
            isLiveScanUnit({ platform: 'reddit', scanType: 'keyword', scanKey: 'ai visibility' }, live)
        ).toBe(true);
        expect(
            isLiveScanUnit({ platform: 'reddit', scanType: 'keyword', scanKey: 'gone' }, live)
        ).toBe(false);
    });

    // A keyword is enumerated for EVERY allowed platform, so the same text on a
    // different platform is still the same live keyword.
    it('ignores the platform for a keyword unit', () => {
        expect(
            isLiveScanUnit({ platform: 'medium', scanType: 'keyword', scanKey: 'ai visibility' }, live)
        ).toBe(true);
    });

    // A channel/tracked unit is platform-scoped: the same handle on two
    // platforms is two different units.
    it('requires platform AND key for a target unit', () => {
        expect(
            isLiveScanUnit({ platform: 'reddit', scanType: 'channel', scanKey: 'ui_design' }, live)
        ).toBe(true);
        expect(
            isLiveScanUnit({ platform: 'x', scanType: 'channel', scanKey: 'ui_design' }, live)
        ).toBe(false);
    });

    // Normalized through the same helper the enumerator writes with, so a
    // legacy row spelled differently is not mistaken for a dead unit.
    it('normalizes a padded or upper-cased platform', () => {
        expect(
            isLiveScanUnit({ platform: ' Reddit ', scanType: 'channel', scanKey: 'ui_design' }, live)
        ).toBe(true);
    });

    it('treats the scan type case-insensitively', () => {
        expect(
            isLiveScanUnit({ platform: 'reddit', scanType: 'KEYWORD', scanKey: 'ai visibility' }, live)
        ).toBe(true);
    });

    it('reads a null platform as no platform rather than throwing', () => {
        expect(
            isLiveScanUnit({ platform: null, scanType: 'tracked', scanKey: 'someone' }, live)
        ).toBe(false);
    });
});
