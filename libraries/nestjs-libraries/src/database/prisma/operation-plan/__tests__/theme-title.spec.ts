import { describe, it, expect } from 'vitest';
import {
  postTitleFromTheme,
  stripDuplicatedTitleFromContent,
} from '../theme-title';

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

describe('stripDuplicatedTitleFromContent', () => {
  const title = 'How we cut LLM costs by 60%';

  it('strips a verbatim repeated title line plus the blank line after it', () => {
    expect(
      stripDuplicatedTitleFromContent(
        title,
        'How we cut LLM costs by 60%\n\nWe started by profiling every call.'
      )
    ).toBe('We started by profiling every call.');
  });

  it('strips a markdown-heading restatement of the title', () => {
    expect(
      stripDuplicatedTitleFromContent(
        title,
        '## How we cut LLM costs by 60%\nWe started by profiling every call.'
      )
    ).toBe('We started by profiling every call.');
  });

  it('strips a bold restatement with trailing punctuation, case-insensitively', () => {
    expect(
      stripDuplicatedTitleFromContent(
        title,
        '**how we cut llm costs by 60%:**\n\nProfiling came first.'
      )
    ).toBe('Profiling came first.');
  });

  it('leaves content alone when the first line is not the title', () => {
    const content = 'Costs were killing us.\n\nHow we cut LLM costs by 60% is a longer story.';
    expect(stripDuplicatedTitleFromContent(title, content)).toBe(content);
  });

  it('leaves content alone when the first line merely starts with the title', () => {
    const content =
      'How we cut LLM costs by 60% without losing quality\nDetails below.';
    expect(stripDuplicatedTitleFromContent(title, content)).toBe(content);
  });

  it('keeps a title-only content non-empty rather than stripping to nothing', () => {
    expect(stripDuplicatedTitleFromContent(title, 'How we cut LLM costs by 60%')).toBe(
      'How we cut LLM costs by 60%'
    );
    expect(
      stripDuplicatedTitleFromContent(title, 'How we cut LLM costs by 60%\n\n  ')
    ).toBe('How we cut LLM costs by 60%\n\n  ');
  });

  it('is inert on an empty title', () => {
    const content = 'Anything at all.\nMore.';
    expect(stripDuplicatedTitleFromContent('', content)).toBe(content);
  });
});
