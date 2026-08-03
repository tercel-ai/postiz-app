import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePostDto } from '../../dtos/posts/create.post.dto';
import { validationExceptionFactory } from '../validation.exception.factory';

const contentItem = (id?: string) => ({
  ...(id ? { id } : {}),
  content: '<p>hello world</p>',
  image: [],
});

const validPost = {
  integration: { id: 'int-x' },
  value: [contentItem()],
  settings: { __type: 'x', who_can_reply_post: 'everyone' },
};

const basePayload = {
  type: 'schedule',
  shortLink: false,
  date: '2026-08-03T10:00:00.000Z',
  tags: [],
};

async function messagesFor(payload: object): Promise<string[]> {
  const dto = plainToInstance(CreatePostDto, payload);
  const errors = await validate(dto as object, {
    whitelist: false,
    forbidNonWhitelisted: false,
  });
  const response = validationExceptionFactory(errors).getResponse() as {
    message: string[];
  };
  return response.message;
}

describe('validationExceptionFactory posts[] labeling', () => {
  it('labels a failing posts element with post id and platform', async () => {
    const messages = await messagesFor({
      ...basePayload,
      posts: [
        validPost,
        validPost,
        {
          integration: { id: 'int-medium' },
          value: [contentItem('post-abc')],
          // title too short -> MinLength failure inside settings
          settings: { __type: 'medium', title: 'a' },
        },
      ],
    });

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).toContain(
        'posts[2] (id=post-abc, integration=int-medium, platform=medium)'
      );
    }
    expect(
      messages.some((m) => m.includes('title must be longer than or equal'))
    ).toBe(true);
  });

  it('falls back to the bare index when the element has no identifying fields', async () => {
    const messages = await messagesFor({
      ...basePayload,
      posts: [{ value: [contentItem()], settings: {} }],
    });

    expect(messages.some((m) => m.startsWith('posts[0].'))).toBe(true);
  });

  it('keeps default formatting for non-posts errors', async () => {
    const messages = await messagesFor({
      ...basePayload,
      type: 'bogus',
      posts: [validPost],
    });

    expect(
      messages.some((m) =>
        m.includes('type must be one of the following values')
      )
    ).toBe(true);
  });
});
