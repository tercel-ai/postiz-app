import { describe, it, expect } from 'vitest';
import { checkReferenceSimilarity } from '../reference-similarity';

describe('checkReferenceSimilarity', () => {
  it('flags an identical copy as too similar', () => {
    const text =
      'The market for handmade ceramics has quietly tripled in the last two years, and most sellers still price like it is 2019.';
    const result = checkReferenceSimilarity(text, text);
    expect(result.tooSimilar).toBe(true);
    expect(result.hasLongVerbatimRun).toBe(true);
    expect(result.overlapRatio).toBeGreaterThan(0.9);
  });

  it('flags a draft that embeds a long verbatim run from the reference', () => {
    const reference =
      'Our small team shipped a completely rebuilt onboarding flow last week after users kept dropping off at the third screen every single time without fail.';
    const candidate =
      'Here is a fresh take: after users kept dropping off at the third screen every single time without fail, we knew something structural was wrong.';
    const result = checkReferenceSimilarity(candidate, reference);
    expect(result.hasLongVerbatimRun).toBe(true);
    expect(result.tooSimilar).toBe(true);
  });

  it('does not flag an original post on the same topic with different wording', () => {
    const reference =
      'The market for handmade ceramics has quietly tripled in the last two years, and most sellers still price like it is 2019.';
    const candidate =
      'Something interesting is happening with artisan pottery: demand keeps climbing, yet a lot of makers have not touched their prices in ages.';
    const result = checkReferenceSimilarity(candidate, reference);
    expect(result.tooSimilar).toBe(false);
    expect(result.hasLongVerbatimRun).toBe(false);
  });

  it('does not flag two unrelated short posts', () => {
    const result = checkReferenceSimilarity(
      'Coffee prices are up again this quarter.',
      'My cat knocked a plant off the windowsill this morning.'
    );
    expect(result.tooSimilar).toBe(false);
  });

  it('handles empty/short strings without throwing', () => {
    expect(() => checkReferenceSimilarity('', '')).not.toThrow();
    expect(checkReferenceSimilarity('hi', 'hi there').tooSimilar).toBe(false);
  });

  it('flags an identical CJK (Chinese) copy as too similar', () => {
    const text =
      '手工陶瓷市场在过去两年里悄悄地扩大了三倍，但大多数卖家的定价方式还停留在二零一九年,完全没有跟上市场的变化。';
    const result = checkReferenceSimilarity(text, text);
    expect(result.tooSimilar).toBe(true);
  });

  it('does not flag two unrelated CJK posts', () => {
    const result = checkReferenceSimilarity(
      '今天天气很好，适合出去散步，路边的樱花也开了。',
      '公司决定下个季度上线一款全新的记账软件，团队正在加班加点地开发。'
    );
    expect(result.tooSimilar).toBe(false);
  });

  it('flags a CJK draft with a long verbatim run copied from the reference', () => {
    const reference =
      '我们团队上周重新设计了整个新用户引导流程，因为发现很多用户总是在第三个页面就直接放弃了继续操作。';
    const candidate =
      '说个新鲜事：因为发现很多用户总是在第三个页面就直接放弃了继续操作，我们才意识到问题出在结构设计上。';
    const result = checkReferenceSimilarity(candidate, reference);
    expect(result.hasLongVerbatimRun).toBe(true);
    expect(result.tooSimilar).toBe(true);
  });
});
