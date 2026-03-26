import { describe, it, expect } from 'vitest';
import { resolveIntegrationIds, SelectedIntegration } from '../resolve-integration';

const xIntegration: SelectedIntegration = {
  id: 'cmn2mcbn40002qmiwi2b9v1h0',
  identifier: 'x',
  providerIdentifier: 'x',
  name: 'aipartnerup-team',
};

const linkedinIntegration: SelectedIntegration = {
  id: 'abc123def456',
  identifier: 'linkedin',
  providerIdentifier: 'linkedin',
  name: 'my-company-page',
};

const fbIntegration: SelectedIntegration = {
  id: 'fb-integration-001',
  identifier: 'facebook',
  providerIdentifier: 'facebook',
  name: 'my-facebook-page',
};

describe('resolveIntegrationIds', () => {
  // =========================================================================
  // Rule 4: No channels selected
  // =========================================================================
  describe('Rule 4 — no channels selected', () => {
    it('returns error when selectedIntegrations is empty', () => {
      const result = resolveIntegrationIds([], undefined);
      expect(result.kind).toBe('error');
      expect((result as any).message).toContain('No channels selected');
    });

    it('returns error when selectedIntegrations is null/undefined', () => {
      const result = resolveIntegrationIds(null as any, undefined);
      expect(result.kind).toBe('error');
    });

    it('returns error even when LLM provides an integrationId', () => {
      const result = resolveIntegrationIds([], 'some-id');
      expect(result.kind).toBe('error');
    });
  });

  // =========================================================================
  // Rule 1a: Single channel, LLM omits or matches
  // =========================================================================
  describe('Rule 1a — single channel, auto-resolve', () => {
    it('auto-resolves when LLM omits integrationId', () => {
      const result = resolveIntegrationIds([xIntegration], undefined);
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('auto-resolves when LLM passes empty string', () => {
      const result = resolveIntegrationIds([xIntegration], '');
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('auto-resolves when LLM passes whitespace only', () => {
      const result = resolveIntegrationIds([xIntegration], '   ');
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('resolves when LLM passes exact ID', () => {
      const result = resolveIntegrationIds([xIntegration], xIntegration.id);
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('resolves when LLM passes identifier (platform)', () => {
      const result = resolveIntegrationIds([xIntegration], 'x');
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('resolves when LLM passes identifier case-insensitive', () => {
      const result = resolveIntegrationIds([xIntegration], 'X');
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('resolves when LLM passes name', () => {
      const result = resolveIntegrationIds([xIntegration], 'aipartnerup-team');
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('resolves when LLM passes name case-insensitive', () => {
      const result = resolveIntegrationIds([xIntegration], 'AIPARTNERUP-TEAM');
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('resolves when LLM passes providerIdentifier', () => {
      const result = resolveIntegrationIds([xIntegration], 'x');
      expect(result.kind).toBe('single');
    });
  });

  // =========================================================================
  // Rule 1b: Single channel, LLM specifies different
  // =========================================================================
  describe('Rule 1b — single channel, wrong platform', () => {
    it('returns error when LLM specifies non-matching platform', () => {
      const result = resolveIntegrationIds([xIntegration], 'facebook');
      expect(result.kind).toBe('error');
      expect((result as any).message).toContain('not selected');
      expect((result as any).message).toContain('facebook');
    });

    it('returns error when LLM specifies non-matching ID', () => {
      const result = resolveIntegrationIds([xIntegration], 'wrong-id-123');
      expect(result.kind).toBe('error');
    });

    it('error message includes the selected channel info', () => {
      const result = resolveIntegrationIds([xIntegration], 'linkedin');
      expect(result.kind).toBe('error');
      expect((result as any).message).toContain(xIntegration.id);
    });
  });

  // =========================================================================
  // Rule 2: Multiple channels, LLM specifies one in list
  // =========================================================================
  describe('Rule 2 — multiple channels, match one', () => {
    const selected = [xIntegration, linkedinIntegration];

    it('matches by exact ID', () => {
      const result = resolveIntegrationIds(selected, xIntegration.id);
      expect(result.kind).toBe('matched');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });

    it('matches by identifier', () => {
      const result = resolveIntegrationIds(selected, 'linkedin');
      expect(result.kind).toBe('matched');
      expect(result.integrationIds).toEqual([linkedinIntegration.id]);
    });

    it('matches by name case-insensitive', () => {
      const result = resolveIntegrationIds(selected, 'MY-COMPANY-PAGE');
      expect(result.kind).toBe('matched');
      expect(result.integrationIds).toEqual([linkedinIntegration.id]);
    });

    it('matches by identifier "x" even with multiple channels', () => {
      const result = resolveIntegrationIds(selected, 'X');
      expect(result.kind).toBe('matched');
      expect(result.integrationIds).toEqual([xIntegration.id]);
    });
  });

  // =========================================================================
  // Rule 3: Multiple channels, LLM doesn't specify → all
  // =========================================================================
  describe('Rule 3 — multiple channels, send to all', () => {
    const selected = [xIntegration, linkedinIntegration];

    it('returns all IDs when LLM omits integrationId', () => {
      const result = resolveIntegrationIds(selected, undefined);
      expect(result.kind).toBe('all');
      expect(result.integrationIds).toEqual([xIntegration.id, linkedinIntegration.id]);
    });

    it('returns all IDs when LLM passes empty string', () => {
      const result = resolveIntegrationIds(selected, '');
      expect(result.kind).toBe('all');
      expect(result.integrationIds).toHaveLength(2);
    });

    it('returns all 3 IDs with 3 channels', () => {
      const result = resolveIntegrationIds([xIntegration, linkedinIntegration, fbIntegration], undefined);
      expect(result.kind).toBe('all');
      expect(result.integrationIds).toHaveLength(3);
    });
  });

  // =========================================================================
  // Rule 5: Multiple channels, LLM specifies one NOT in list
  // =========================================================================
  describe('Rule 5 — multiple channels, wrong platform', () => {
    const selected = [xIntegration, linkedinIntegration];

    it('returns error when LLM specifies non-matching platform', () => {
      const result = resolveIntegrationIds(selected, 'tiktok');
      expect(result.kind).toBe('error');
      expect((result as any).message).toContain('tiktok');
      expect((result as any).message).toContain('not in your selected');
    });

    it('returns error when LLM specifies non-matching ID', () => {
      const result = resolveIntegrationIds(selected, 'nonexistent-id');
      expect(result.kind).toBe('error');
    });

    it('error message lists available channels', () => {
      const result = resolveIntegrationIds(selected, 'instagram');
      expect(result.kind).toBe('error');
      const msg = (result as any).message;
      expect(msg).toContain(xIntegration.id);
      expect(msg).toContain(linkedinIntegration.id);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('Edge cases', () => {
    it('handles integration with only id field (no name/identifier)', () => {
      const minimal: SelectedIntegration = { id: 'minimal-001' };
      const result = resolveIntegrationIds([minimal], undefined);
      expect(result.kind).toBe('single');
      expect(result.integrationIds).toEqual(['minimal-001']);
    });

    it('handles integration with platform field (from message context)', () => {
      const withPlatform: SelectedIntegration = {
        id: 'plat-001',
        platform: 'x',
      };
      const result = resolveIntegrationIds([withPlatform, linkedinIntegration], 'x');
      expect(result.kind).toBe('matched');
      expect(result.integrationIds).toEqual(['plat-001']);
    });

    it('exact ID match takes priority over name match in same entry', () => {
      // When searching for an ID, the exact si.id check runs first in the condition chain
      const selected = [xIntegration, linkedinIntegration];
      const result = resolveIntegrationIds(selected, linkedinIntegration.id);
      expect(result.kind).toBe('matched');
      expect(result.integrationIds).toEqual([linkedinIntegration.id]);
    });

    it('find returns first match when multiple could match by different fields', () => {
      // This documents the behavior: find() scans in array order.
      // If tricky.name equals linkedin's ID, tricky is found first.
      const tricky: SelectedIntegration = {
        id: 'real-id',
        name: linkedinIntegration.id,
      };
      const result = resolveIntegrationIds([tricky, linkedinIntegration], linkedinIntegration.id);
      // tricky matches by name before linkedin matches by exact ID (array order)
      expect(result.kind).toBe('matched');
      expect(result.integrationIds).toEqual(['real-id']);
    });
  });
});
