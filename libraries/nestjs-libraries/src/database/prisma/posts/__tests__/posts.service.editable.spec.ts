import { describe, it, expect, vi } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { PostsService } from '../posts.service';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';

// `editable` is the read shape converted to something POST /posts accepts. The
// conversion is easy to get subtly wrong in ways that do not fail loudly — above
// all dropping `value[].id`, which silently creates a SECOND chain instead of
// updating the existing one. These lock the parts that matter.

function row(over: Record<string, any> = {}) {
  return {
    id: 'row-1',
    state: 'DRAFT',
    content: 'anchor',
    image: [],
    publishDate: new Date('2026-09-03T07:36:00.000Z'),
    settings: '{"__type":"x"}',
    integrationId: null,
    providerIdentifier: 'x',
    publishMethod: null,
    projectId: null,
    source: 'calendar',
    intervalInDays: null,
    tags: [],
    ...over,
  };
}

function build() {
  const svc = new PostsService(
    {} as any, {} as any, {} as any, {} as any,
    { convertTextToShortLinks: vi.fn() } as any,
    {} as any, {} as any, {} as any, {} as any, {} as any
  );
  return (rows: any[], settings: any) =>
    (svc as any).toEditablePayload(rows, settings);
}

describe('PostsService.toEditablePayload', () => {
  it('carries every row id into value[], in chain order', async () => {
    const editable = build()(
      [row(), row({ id: 'row-2', content: 'follow-up' })],
      { __type: 'x' }
    );

    // Without these ids createOrUpdatePost upserts on uuidv4() and builds a
    // whole second chain — a 2-part thread edited once becomes 4 rows.
    expect(editable.posts[0].value).toEqual([
      { id: 'row-1', content: 'anchor', image: [] },
      { id: 'row-2', content: 'follow-up', image: [] },
    ]);
  });

  it('sends settings as an OBJECT, not the stored JSON string', () => {
    const editable = build()([row()], { __type: 'x', foo: 1 });
    expect(editable.posts[0].settings).toEqual({ __type: 'x', foo: 1 });
  });

  it('omits integration entirely for an account-less post', () => {
    const editable = build()([row()], { __type: 'x' });
    expect(editable.posts[0]).not.toHaveProperty('integration');
    expect(editable.posts[0].providerIdentifier).toBe('x');
  });

  it('wraps a bound account as { id }, not the bare id string', () => {
    const editable = build()([row({ integrationId: 'int-1' })], { __type: 'x' });
    expect(editable.posts[0].integration).toEqual({ id: 'int-1' });
  });

  it('lowercases publishMethod to what the DTO accepts', () => {
    const editable = build()([row({ publishMethod: 'EXTENSION' })], { __type: 'x' });
    expect(editable.posts[0].publishMethod).toBe('extension');
  });

  it('derives type from state', () => {
    expect(build()([row({ state: 'DRAFT' })], {}).type).toBe('draft');
    expect(build()([row({ state: 'QUEUE' })], {}).type).toBe('schedule');
  });

  it('never re-shortens already-shortened content', () => {
    expect(build()([row()], {}).shortLink).toBe(false);
  });

  it('maps tags to {value,label} and dedupes across the chain', () => {
    const tag = { tag: { id: 't1', name: 'launch' } };
    const editable = build()(
      [row({ tags: [tag] }), row({ id: 'row-2', tags: [tag] })],
      {}
    );
    expect(editable.tags).toEqual([{ value: 't1', label: 'launch' }]);
  });

  // `editable` is an additive convenience on a READ endpoint whose actual job is
  // to return the post. A row it cannot be derived from must cost the caller
  // that one field, never the whole response.
  it('degrades to undefined rather than throwing on an underivable row', () => {
    expect(build()([row({ publishDate: undefined })], {})).toBeUndefined();
    expect(build()([row({ publishDate: 'not-a-date' })], {})).toBeUndefined();
  });

  // The whole point: what comes out must be accepted by the endpoint it is
  // meant for. This is the assertion that catches a future DTO change.
  it('passes CreatePostDto validation as-is', async () => {
    const editable = build()(
      [row(), row({ id: 'row-2', content: 'follow-up' })],
      { __type: 'x' }
    );

    const pipe = new ValidationPipe({
      skipMissingProperties: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    });

    await expect(
      pipe.transform(editable as any, { type: 'body', metatype: CreatePostDto } as any)
    ).resolves.toBeDefined();
  });
});
