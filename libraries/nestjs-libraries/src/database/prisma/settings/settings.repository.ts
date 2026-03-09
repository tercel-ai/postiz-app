import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class SettingsRepository {
  constructor(private _settings: PrismaRepository<'settings'>) {}

  async get(key: string) {
    return this._settings.model.settings.findUnique({ where: { key } });
  }

  async getValue<T = unknown>(key: string): Promise<T | null> {
    const record = await this.get(key);
    if (!record) return null;
    return (record.value ?? record.default) as T;
  }

  async set(
    key: string,
    value: unknown,
    options?: {
      type?: string;
      required?: boolean;
      description?: string;
      defaultValue?: unknown;
    }
  ) {
    return this._settings.model.settings.upsert({
      where: { key },
      create: {
        key,
        value: value as any,
        type: options?.type || 'object',
        required: options?.required ?? false,
        description: options?.description,
        default: options?.defaultValue as any,
      },
      update: {
        value: value as any,
        ...(options?.type ? { type: options.type } : {}),
        ...(options?.description !== undefined
          ? { description: options.description }
          : {}),
        ...(options?.defaultValue !== undefined
          ? { default: options.defaultValue as any }
          : {}),
      },
    });
  }

  async delete(key: string) {
    const result = await this._settings.model.settings.deleteMany({ where: { key } });
    return result.count > 0;
  }

  async listByPrefix(prefix: string) {
    return this._settings.model.settings.findMany({
      where: { key: { startsWith: prefix } },
      orderBy: { key: 'asc' },
    });
  }

  async paginate(options: {
    page: number;
    pageSize: number;
    keyword?: string;
    type?: string;
  }) {
    const { page, pageSize, keyword, type } = options;
    const where: Prisma.SettingsWhereInput = {};
    if (keyword) {
      where.OR = [
        { key: { contains: keyword, mode: 'insensitive' } },
        { description: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    if (type) {
      where.type = type;
    }

    const [items, total] = await Promise.all([
      this._settings.model.settings.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this._settings.model.settings.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }
}
