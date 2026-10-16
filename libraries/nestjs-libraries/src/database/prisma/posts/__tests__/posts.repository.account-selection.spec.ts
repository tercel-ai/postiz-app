import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';
async function save(integration?: { id: string }) {
  const upsert = vi.fn().mockResolvedValue({ id: 'root' });
  const repository = new PostsRepository(
    { model: { post: { upsert } } } as any,
    {} as any,
    {} as any,
    {} as any,
    { model: { tagsPosts: { deleteMany: vi.fn() } } } as any,
    {} as any
  );
  await repository.createOrUpdatePost(
    'draft',
    'org',
    new Date().toISOString(),
    {
      integration,
      providerIdentifier: 'x',
      settings: { __type: 'x' },
      value: [{ content: 'body', image: [], delay: 0 }],
    } as any,
    []
  );
  return upsert.mock.calls[0][0];
}
describe('draft account selection provenance', () => {
  it('records a caller-selected draft account as EXPLICIT', async () => {
    const saved = await save({ id: 'account' });
    expect(saved.create.accountSelectionMode).toBe('EXPLICIT');
    expect(saved.update.accountSelectionMode).toBe('EXPLICIT');
  });
  it('creates an accountless draft as INHERIT', async () => {
    expect((await save()).create.accountSelectionMode).toBe('INHERIT');
  });
  it('does not clear a previous explicit choice when an edit omits the account', async () => {
    expect((await save()).update).not.toHaveProperty('accountSelectionMode');
  });
});
