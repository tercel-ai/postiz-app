import { describe, it, expect } from 'vitest';
import { postTitleFromTheme } from '../theme-title';

describe('postTitleFromTheme', () => {
  it('strips the canonical "W1 - " week label from the prompt', () => {
    expect(postTitleFromTheme('W1 - Foundations: Establish canonical pages')).toBe(
      'Foundations: Establish canonical pages'
    );
  });

  it('strips multi-digit week numbers', () => {
    expect(postTitleFromTheme('W12 - Consolidation: wrap-up')).toBe(
      'Consolidation: wrap-up'
    );
  });

  it('strips the "Week N" long form and en/em dashes', () => {
    expect(postTitleFromTheme('Week 2 – Distribution: seed forums')).toBe(
      'Distribution: seed forums'
    );
    expect(postTitleFromTheme('W3 — Density: daily replies')).toBe(
      'Density: daily replies'
    );
  });

  it('strips a colon-delimited week label', () => {
    expect(postTitleFromTheme('W1: Launch the beta')).toBe('Launch the beta');
  });

  it('leaves a title without a week prefix untouched (aside from trim)', () => {
    expect(postTitleFromTheme('React positioning replies')).toBe(
      'React positioning replies'
    );
    expect(postTitleFromTheme('  Helpful GEO answers  ')).toBe('Helpful GEO answers');
  });

  it('does not strip a "W" that is not a week token', () => {
    expect(postTitleFromTheme('Windows 11 - setup guide')).toBe(
      'Windows 11 - setup guide'
    );
  });

  it('falls back to the original when stripping would empty the title', () => {
    expect(postTitleFromTheme('W1 -')).toBe('W1 -');
  });
});
