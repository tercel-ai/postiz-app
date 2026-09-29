import { describe, expect, it } from 'vitest';
import { AiseeCostItem, deriveTokenColumns } from './aisee.client';

// deriveTokenColumns is the single source of truth every BillingRecord write path
// uses, and the backfill migration reimplements it in SQL. Its parity with that
// SQL is covered in billing-records.query.sql.spec.ts, which needs a database;
// these cases pin the rule itself and run everywhere.

const item = (over: Partial<AiseeCostItem> = {}): AiseeCostItem => ({
  type: 'text',
  amount: '0.100000',
  model: 'gpt-4.1',
  billing_mode: 'per_token',
  quantity: 1000,
  ...over,
});

describe('deriveTokenColumns', () => {
  it('sums the split across every per_token item', () => {
    expect(
      deriveTokenColumns([
        item({ quantity: 1500, prompt_tokens: 1200, completion_tokens: 300 }),
        item({ quantity: 500, prompt_tokens: 400, completion_tokens: 100 }),
      ])
    ).toEqual({
      totalTokens: 2000,
      promptTokens: 1600,
      completionTokens: 400,
      cachedPromptTokens: 0,
    });
  });

  // The accrual window that spans the change: one item predates the split. Summing
  // only the items that have it would produce prompt+completion = 900 against a
  // total of 1400 — precise-looking and wrong.
  it('drops the split when a single per_token item lacks one', () => {
    expect(
      deriveTokenColumns([
        item({ quantity: 900, prompt_tokens: 700, completion_tokens: 200 }),
        item({ quantity: 500 }),
      ])
    ).toEqual({
      totalTokens: 1400,
      promptTokens: null,
      completionTokens: null,
      cachedPromptTokens: null,
    });
  });

  it('reports total only for a historical row', () => {
    expect(deriveTokenColumns([item({ quantity: 1500 })])).toEqual({
      totalTokens: 1500,
      promptTokens: null,
      completionTokens: null,
      cachedPromptTokens: null,
    });
  });

  it('treats half a split as no split', () => {
    expect(
      deriveTokenColumns([item({ quantity: 900, completion_tokens: 200 })])
    ).toEqual({
      totalTokens: 900,
      promptTokens: null,
      completionTokens: null,
      cachedPromptTokens: null,
    });
  });

  // `quantity` is an image COUNT on a per_image item — a different unit, so
  // counting it as tokens would inflate the figure by something unrelated.
  it('excludes per_image items from the token total', () => {
    expect(
      deriveTokenColumns([
        item({ quantity: 900, prompt_tokens: 700, completion_tokens: 200 }),
        item({
          type: 'image',
          model: 'dall-e-3',
          billing_mode: 'per_image',
          quantity: 3,
        }),
      ])
    ).toEqual({
      totalTokens: 900,
      promptTokens: 700,
      completionTokens: 200,
      cachedPromptTokens: 0,
    });
  });

  it('sums cached prompt tokens when the split is known', () => {
    expect(
      deriveTokenColumns([
        item({ quantity: 1500, prompt_tokens: 1200, completion_tokens: 300, cached_prompt_tokens: 900 }),
        item({ quantity: 500, prompt_tokens: 400, completion_tokens: 100 }),
      ])
    ).toMatchObject({ cachedPromptTokens: 900 });
  });

  // post_overage / engage_reply / post_analytics: 0 is accurate, not unknown —
  // those charges genuinely burned no LLM tokens.
  it('reads a flat-rate charge as zero tokens, not unknown', () => {
    expect(
      deriveTokenColumns([item({ model: 'post_send', quantity: 0, amount: '25.000000' })])
    ).toEqual({
      totalTokens: 0,
      promptTokens: null,
      completionTokens: null,
      cachedPromptTokens: null,
    });
  });

  it('handles an empty breakdown and a per_image-only row', () => {
    const none = {
      totalTokens: 0,
      promptTokens: null,
      completionTokens: null,
      cachedPromptTokens: null,
    };
    expect(deriveTokenColumns([])).toEqual(none);
    expect(
      deriveTokenColumns([
        item({ type: 'image', billing_mode: 'per_image', quantity: 2 }),
      ])
    ).toEqual(none);
  });
});
