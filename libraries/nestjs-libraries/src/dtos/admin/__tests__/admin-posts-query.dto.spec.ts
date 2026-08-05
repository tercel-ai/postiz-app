import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminPostsQueryDto } from '../admin-posts-query.dto';

async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(AdminPostsQueryDto, payload);
  const errors = await validate(dto as object, { whitelist: false });
  return { dto, errors };
}

describe('AdminPostsQueryDto', () => {
  it('accepts platform as an alias filter with the same channel vocabulary', async () => {
    const { dto, errors } = await parse({ platform: 'x,reddit' });
    expect(errors).toEqual([]);
    expect(dto.platform).toEqual(['x', 'reddit']);
  });

  it('rejects unknown platform values', async () => {
    const { errors } = await parse({ platform: 'myspace' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('normalizes publishMethod to the uppercase Prisma enum values', async () => {
    const { dto, errors } = await parse({ publishMethod: 'api,extension' });
    expect(errors).toEqual([]);
    expect(dto.publishMethod).toEqual(['API', 'EXTENSION']);
  });

  it('accepts a single uppercase publishMethod value', async () => {
    const { dto, errors } = await parse({ publishMethod: 'EXTENSION' });
    expect(errors).toEqual([]);
    expect(dto.publishMethod).toEqual(['EXTENSION']);
  });

  it('rejects publishMethod values outside the enum', async () => {
    const { errors } = await parse({ publishMethod: 'manual' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
