import { describe, it, expect } from 'vitest';
import {
  TITLE_LINE_PREFIX,
  parseTitledOutput,
  stripDuplicatedTitleFromContent,
} from '@gitroom/nestjs-libraries/integrations/title-body-split';

// The stripDuplicatedTitleFromContent cases below moved here VERBATIM from
// operation-plan/__tests__/theme-title.spec.ts along with the function itself
// — it is a rule about title-separated PLATFORMS, not about marketing plans,
// and engage's reference-post generation now needs the identical one. Keeping
// them unchanged is the proof the move changed no behaviour.

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

describe('parseTitledOutput', () => {
  it('splits the prompted "TITLE: …\\n\\nbody" shape', () => {
    expect(
      parseTitledOutput(
        'TITLE: How we cut LLM costs by 60%\n\nWe started by profiling every call.'
      )
    ).toEqual({
      title: 'How we cut LLM costs by 60%',
      body: 'We started by profiling every call.',
    });
  });

  it('accepts the decoration a model adds to its own heading', () => {
    for (const line of [
      'TITLE: A better way to cache',
      '**TITLE: A better way to cache**',
      '**TITLE:** A better way to cache',
      '## TITLE: A better way to cache',
      'Title: A better way to cache',
      'title:   A better way to cache',
      'TITLE：A better way to cache',
      'TITLE: "A better way to cache"',
    ]) {
      expect(parseTitledOutput(`${line}\n\nBody text.`)).toEqual({
        title: 'A better way to cache',
        body: 'Body text.',
      });
    }
  });

  it('keeps case and terminal punctuation the title actually needs', () => {
    expect(parseTitledOutput('TITLE: Why does Postgres do THAT?\n\nBody.').title).toBe(
      'Why does Postgres do THAT?'
    );
  });

  // The whole point: the body no longer opens with the headline the title
  // field already carries.
  it('drops a title the model repeated at the top of the body anyway', () => {
    expect(
      parseTitledOutput(
        'TITLE: A better way to cache\n\n## A better way to cache\n\nBody text.'
      )
    ).toEqual({ title: 'A better way to cache', body: 'Body text.' });
  });

  // Falling back is a LOGGING event for the caller, never an error: the
  // generation is already paid for.
  it('returns the response verbatim as the body when there is no TITLE line', () => {
    const raw = 'We started by profiling every call.\n\nThen we cached.';
    expect(parseTitledOutput(raw)).toEqual({ title: null, body: raw });
  });

  it('does not mistake a body sentence containing "title:" for the title line', () => {
    const raw = 'The trick is the page title: keep it short.\n\nMore.';
    expect(parseTitledOutput(raw)).toEqual({ title: null, body: raw });
  });

  it('falls back rather than returning an empty body for a title-only response', () => {
    const raw = 'TITLE: A better way to cache';
    expect(parseTitledOutput(raw)).toEqual({ title: null, body: raw });
    expect(parseTitledOutput('TITLE: A better way to cache\n\n   ')).toEqual({
      title: null,
      body: 'TITLE: A better way to cache\n\n   ',
    });
  });

  // Threads: the TITLE line belongs to the anchor and appears ONCE, so the
  // separators stay untouched in the body for the caller to split on.
  it('leaves thread separators in the body for the caller to split', () => {
    expect(
      parseTitledOutput('TITLE: A better way to cache\n\none\n[[PART]]\ntwo')
    ).toEqual({
      title: 'A better way to cache',
      body: 'one\n[[PART]]\ntwo',
    });
  });

  it('exports the exact prefix a prompt must ask for', () => {
    expect(TITLE_LINE_PREFIX).toBe('TITLE:');
  });
});
