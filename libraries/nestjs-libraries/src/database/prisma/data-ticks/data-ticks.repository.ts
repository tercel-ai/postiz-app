import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Prisma } from '@prisma/client';

export type TimeUnit = 'hour' | 'day' | 'week' | 'month';

@Injectable()
export class DataTicksRepository {
  constructor(
    private _dataTicks: PrismaRepository<'dataTicks'>,
    private _integration: PrismaRepository<'integration'>,
    private _tx: PrismaTransaction
  ) {}

  async upsertMany(
    records: Array<{
      organizationId: string;
      integrationId: string;
      platform: string;
      userId?: string;
      type: string;
      timeUnit: TimeUnit;
      statisticsTime: Date;
      value: bigint;
      postsAnalyzed: number;
    }>
  ) {
    if (!records.length) return [];
    const ops = records.map((data) =>
      this._dataTicks.model.dataTicks.upsert({
        where: {
          organizationId_integrationId_type_timeUnit_statisticsTime: {
            organizationId: data.organizationId,
            integrationId: data.integrationId,
            type: data.type,
            timeUnit: data.timeUnit,
            statisticsTime: data.statisticsTime,
          },
        },
        update: {
          value: data.value,
          postsAnalyzed: data.postsAnalyzed,
          platform: data.platform,
          userId: data.userId,
        },
        create: data,
      })
    );
    return this._tx.model.$transaction(ops);
  }

  async query(params: {
    organizationId: string;
    type: string;
    timeUnit: TimeUnit;
    startTime: Date;
    endTime: Date;
    platform?: string;
    integrationId?: string[];
  }) {
    const where: Prisma.DataTicksWhereInput = {
      organizationId: params.organizationId,
      type: params.type,
      timeUnit: params.timeUnit,
      statisticsTime: {
        gte: params.startTime,
        lte: params.endTime,
      },
      ...(params.platform && { platform: params.platform }),
      ...(params.integrationId?.length && {
        integrationId: { in: params.integrationId },
      }),
    };

    return this._dataTicks.model.dataTicks.findMany({
      where,
      orderBy: { statisticsTime: 'asc' },
    });
  }

  async getAllActiveIntegrationsByOrg() {
    const integrations = await this._integration.model.integration.findMany({
      where: {
        deletedAt: null,
        disabled: false,
        type: 'social',
      },
      select: {
        id: true,
        organizationId: true,
        providerIdentifier: true,
      },
    });

    const byOrg = new Map<
      string,
      Array<{ id: string; platform: string }>
    >();
    for (const int of integrations) {
      if (!byOrg.has(int.organizationId)) {
        byOrg.set(int.organizationId, []);
      }
      byOrg.get(int.organizationId)!.push({
        id: int.id,
        platform: int.providerIdentifier,
      });
    }
    return byOrg;
  }
}
