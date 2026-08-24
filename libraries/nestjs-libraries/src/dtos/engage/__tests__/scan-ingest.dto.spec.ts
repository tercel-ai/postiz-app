import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  EngageScanIngestDto,
  ScanUnitSelectorDto,
  scanIngestPostToRawPost,
} from '../scan-ingest.dto';

async function errorsFor(payload: unknown): Promise<string[]> {
  const dto = plainToInstance(EngageScanIngestDto, payload);
  const errors = await validate(dto as object, { whitelist: false });
  // flatten nested (posts[]) constraint keys for easy assertions
  const collect = (es: any[]): string[] =>
    es.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}),
      ...collect(e.children ?? []),
    ]);
  return collect(errors);
}

const validPost = {
  platform: 'reddit',
  externalPostId: 't3_abc',
  externalPostUrl: 'https://reddit.com/r/x/comments/abc',
  authorUsername: 'someone',
  postContent: 'hello world',
  postPublishedAt: '2026-06-17T10:00:00.000Z',
  metricScore: -3, // Reddit score may be negative — allowed
  metricComments: 5,
};

describe('EngageScanIngestDto', () => {
  it('accepts a minimal valid payload', async () => {
    expect(
      await errorsFor({ taskId: 'cur1', posts: [validPost] })
    ).toEqual([]);
  });

  it('requires taskId and the post identity/content fields', async () => {
    const errs = await errorsFor({ posts: [{ platform: 'x' }] });
    expect(errs).toContain('isString'); // missing taskId + required post fields
    expect(errs.length).toBeGreaterThan(0);
  });

  it('accepts an optional title and carries it into the RawPost', async () => {
    expect(
      await errorsFor({
        taskId: 'cur1',
        posts: [{ ...validPost, title: 'GPT-5 is out' }],
      })
    ).toEqual([]);
    expect(
      scanIngestPostToRawPost({ ...validPost, title: 'GPT-5 is out' } as any).title
    ).toBe('GPT-5 is out');
  });

  it('still accepts a post with no title — older extension builds send none', async () => {
    expect(await errorsFor({ taskId: 'cur1', posts: [validPost] })).toEqual([]);
    expect(scanIngestPostToRawPost(validPost as any).title).toBeUndefined();
  });

  it('rejects a non-ISO publish date', async () => {
    const errs = await errorsFor({
      taskId: 'c',
      posts: [{ ...validPost, postPublishedAt: 'yesterday' }],
    });
    expect(errs).toContain('isDateString');
  });

  it('rejects negative non-score metrics (Min 0)', async () => {
    const errs = await errorsFor({
      taskId: 'c',
      posts: [{ ...validPost, metricLikes: -1 }],
    });
    expect(errs).toContain('min');
  });

  it('accepts rawData.mediaUrls and carries it into the RawPost', async () => {
    // X's body only ever carried a t.co placeholder for an attachment, which
    // postContent strips; the real URLs are archived on rawData instead.
    const post = {
      ...validPost,
      platform: 'x',
      rawData: { mediaUrls: ['https://pbs.twimg.com/media/A.jpg'] },
    };
    expect(await errorsFor({ taskId: 'c', posts: [post] })).toEqual([]);
    expect(scanIngestPostToRawPost(post as any).rawData).toEqual({
      mediaUrls: ['https://pbs.twimg.com/media/A.jpg'],
    });
  });

  it('rejects more mediaUrls than a tweet can carry', async () => {
    const errs = await errorsFor({
      taskId: 'c',
      posts: [{ ...validPost, rawData: { mediaUrls: ['a', 'b', 'c', 'd', 'e'] } }],
    });
    expect(errs).toContain('arrayMaxSize');
  });

  it('rejects non-string mediaUrls', async () => {
    const errs = await errorsFor({
      taskId: 'c',
      posts: [{ ...validPost, rawData: { mediaUrls: [42] } }],
    });
    expect(errs).toContain('isString');
  });

  it('DROPS unknown rawData keys — the pipe does not whitelist, so the mapper must', async () => {
    // Without this, any caller could write arbitrary JSON into the rawData column.
    const post = {
      ...validPost,
      rawData: { mediaUrls: ['https://pbs.twimg.com/media/A.jpg'], injected: { junk: 'x' } },
    };
    expect(scanIngestPostToRawPost(post as any).rawData).toEqual({
      mediaUrls: ['https://pbs.twimg.com/media/A.jpg'],
    });
  });

  it('leaves rawData undefined when there is nothing to archive', async () => {
    expect(scanIngestPostToRawPost(validPost as any).rawData).toBeUndefined();
    expect(
      scanIngestPostToRawPost({ ...validPost, rawData: { mediaUrls: [] } } as any).rawData
    ).toBeUndefined();
    expect(
      scanIngestPostToRawPost({ ...validPost, rawData: { mediaUrls: ['  '] } } as any).rawData
    ).toBeUndefined();
  });

  it('validates the optional nextCursor', async () => {
    expect(
      await errorsFor({
        taskId: 'c',
        posts: [validPost],
        nextCursor: { lastSeenExternalId: 't3_abc', lastSeenAt: '2026-06-17T10:00:00.000Z' },
        exhausted: true,
      })
    ).toEqual([]);
  });
});

describe('ScanUnitSelectorDto', () => {
  const selectorErrorsFor = async (payload: unknown): Promise<string[]> => {
    const dto = plainToInstance(ScanUnitSelectorDto, payload);
    const errors = await validate(dto as object, { whitelist: false });
    return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
  };

  it('accepts every platform the scan system serves', async () => {
    for (const platform of ['x', 'reddit', 'linkedin', 'devto', 'hackernews', 'medium', 'quora']) {
      expect(
        await selectorErrorsFor({ platform, scanType: 'keyword', scanKey: 'ai search' })
      ).toEqual([]);
    }
  });

  it('rejects an unknown platform', async () => {
    const errs = await selectorErrorsFor({ platform: 'facebook', scanType: 'keyword', scanKey: 'x' });
    expect(errs).toContain('isIn');
  });

  it('rejects an invalid scanType', async () => {
    const errs = await selectorErrorsFor({ platform: 'quora', scanType: 'author', scanKey: 'x' });
    expect(errs).toContain('isIn');
  });

  it('requires scanKey', async () => {
    const errs = await selectorErrorsFor({ platform: 'quora', scanType: 'keyword' });
    expect(errs).toContain('isString');
  });
});
