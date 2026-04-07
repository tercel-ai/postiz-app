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

  /**
   * For each (integrationId, type) in the inputs, return the most recent
   * row at or before `upTo`. Used to carry forward cumulative values when
   * a daily fetch fails for an integration that previously had data.
   *
   * The caller is responsible for inspecting the returned `statisticsTime`:
   * if it already equals the target day, the caller should NOT write a
   * carry-forward (a row already exists for that day and overwriting it
   * with a synthetic copy would degrade either real data or another prior
   * carry-forward).
   */
  async findLatestUpTo(params: {
    organizationId: string;
    integrationIds: string[];
    types: string[];
    upTo: Date;
  }) {
    if (!params.integrationIds.length || !params.types.length) return [];
    const rows = await this._dataTicks.model.dataTicks.findMany({
      where: {
        organizationId: params.organizationId,
        integrationId: { in: params.integrationIds },
        type: { in: params.types },
        timeUnit: 'day',
        statisticsTime: { lte: params.upTo },
      },
      orderBy: { statisticsTime: 'desc' },
      select: {
        organizationId: true,
        integrationId: true,
        platform: true,
        userId: true,
        type: true,
        statisticsTime: true,
        value: true,
        postsAnalyzed: true,
      },
    });
    const seen = new Set<string>();
    const result: typeof rows = [];
    for (const r of rows) {
      const key = `${r.integrationId}|${r.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(r);
    }
    return result;
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
