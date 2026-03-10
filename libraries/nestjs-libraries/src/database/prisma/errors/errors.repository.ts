import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class ErrorsRepository {
  constructor(private _errors: PrismaRepository<'errors'>) {}

  getById(id: string) {
    return this._errors.model.errors.findUnique({
      where: { id },
      select: {
        id: true,
        message: true,
        body: true,
        platform: true,
        postId: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
        organization: {
          select: { id: true, name: true },
        },
        post: {
          select: {
            id: true,
            content: true,
            state: true,
            publishDate: true,
            integration: {
              select: {
                id: true,
                providerIdentifier: true,
                name: true,
              },
            },
          },
        },
      },
    });
  }

  async paginate(options: {
    page: number;
    pageSize: number;
    keyword?: string;
    organizationId?: string;
    platform?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const { page, pageSize, keyword, organizationId, platform, sortBy = 'createdAt', sortOrder = 'desc' } = options;
    const where: Prisma.ErrorsWhereInput = {};

    if (keyword) {
      where.message = { contains: keyword, mode: 'insensitive' };
    }
    if (organizationId) where.organizationId = organizationId;
    if (platform) where.platform = platform;

    const [items, total] = await Promise.all([
      this._errors.model.errors.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          message: true,
          platform: true,
          postId: true,
          organizationId: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      this._errors.model.errors.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }
}
