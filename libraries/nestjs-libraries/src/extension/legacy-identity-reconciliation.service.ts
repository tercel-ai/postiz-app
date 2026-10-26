import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { IntegrationService } from '../database/prisma/integrations/integration.service';
import { SEND_MODE_ORGANIZATION_PREFIX } from './send-mode.service';
import {
  type LegacyIdentityCandidate,
  planLegacyIdentity,
} from './legacy-identity-reconciliation';

export { planLegacyIdentity } from './legacy-identity-reconciliation';

export const LEGACY_IDENTITY_RECONCILIATION_PREFIX =
  'sending.legacy_identity_reconciliation:';
const RETRY_BASE_MS = 15 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;

export interface LegacyIdentityReconciliationResult {
  organizationId: string;
  operatorUserId: string;
  inspected: number;
  fixed: number;
  waitingForSession: number;
  failed: number;
  results: Array<{
    integrationId: string;
    provider: string;
    status: 'FIXED' | 'WAIT_FOR_SESSION' | 'FAILED';
    code?: string;
  }>;
}

function errorCode(error: unknown): string {
  const response =
    error && typeof error === 'object' && 'getResponse' in error
      ? (error as { getResponse(): unknown }).getResponse()
      : null;
  if (typeof response === 'string') return response;
  if (
    response &&
    typeof response === 'object' &&
    typeof (response as { message?: unknown }).message === 'string'
  ) {
    return (response as { message: string }).message;
  }
  return error instanceof Error
    ? error.message
    : 'ACCOUNT_IDENTITY_VERIFICATION_FAILED';
}

@Injectable()
export class LegacyIdentityReconciliationService {
  private readonly logger = new Logger(
    LegacyIdentityReconciliationService.name
  );

  constructor(
    private readonly db: PrismaService,
    private readonly integrations: IntegrationService
  ) {}

  async candidates(organizationId: string): Promise<LegacyIdentityCandidate[]> {
    return this.db.integration.findMany({
      where: {
        organizationId,
        identityNamespace: 'legacy',
        deletedAt: null,
      },
      select: {
        id: true,
        organizationId: true,
        providerIdentifier: true,
        identityNamespace: true,
        internalId: true,
        token: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async reconcileOrganization(
    organizationId: string,
    operatorUserId: string,
    apply = true
  ): Promise<LegacyIdentityReconciliationResult> {
    const member = await this.db.userOrganization.findUnique({
      where: {
        userId_organizationId: {
          userId: operatorUserId,
          organizationId,
        },
      },
    });
    if (
      !member ||
      member.disabled ||
      !['ADMIN', 'SUPERADMIN'].includes(member.role)
    ) {
      throw new ForbiddenException('ACCOUNT_IDENTITY_ADMIN_REQUIRED');
    }

    const candidates = await this.candidates(organizationId);
    const result: LegacyIdentityReconciliationResult = {
      organizationId,
      operatorUserId,
      inspected: candidates.length,
      fixed: 0,
      waitingForSession: 0,
      failed: 0,
      results: [],
    };

    for (const candidate of candidates) {
      const plan = planLegacyIdentity(candidate);
      if (plan.action === 'WAIT_FOR_SESSION') {
        result.waitingForSession++;
        result.results.push({
          integrationId: candidate.id,
          provider: candidate.providerIdentifier,
          status: 'WAIT_FOR_SESSION',
          code: plan.reason,
        });
        continue;
      }
      if (!apply) {
        result.results.push({
          integrationId: candidate.id,
          provider: candidate.providerIdentifier,
          status: 'WAIT_FOR_SESSION',
          code: 'DRY_RUN_OAUTH_VERIFICATION_REQUIRED',
        });
        continue;
      }
      try {
        await this.integrations.verifyStableIdentity(
          organizationId,
          operatorUserId,
          candidate.id
        );
        result.fixed++;
        result.results.push({
          integrationId: candidate.id,
          provider: candidate.providerIdentifier,
          status: 'FIXED',
        });
      } catch (error) {
        result.failed++;
        result.results.push({
          integrationId: candidate.id,
          provider: candidate.providerIdentifier,
          status: 'FAILED',
          code: errorCode(error),
        });
      }
    }
    return result;
  }

  async reconcilePendingControlledOrganizations(): Promise<
    LegacyIdentityReconciliationResult[]
  > {
    const modeRows = await this.db.settings.findMany({
      where: { key: { startsWith: SEND_MODE_ORGANIZATION_PREFIX } },
      select: { key: true, value: true },
    });
    const completed: LegacyIdentityReconciliationResult[] = [];

    for (const row of modeRows) {
      const value = row.value as { mode?: unknown; revision?: unknown } | null;
      if (
        value?.mode !== 'CONTROLLED' ||
        !Number.isInteger(value.revision) ||
        (value.revision as number) < 1
      ) {
        continue;
      }
      const organizationId = row.key.slice(
        SEND_MODE_ORGANIZATION_PREFIX.length
      );
      const receiptKey = `${LEGACY_IDENTITY_RECONCILIATION_PREFIX}${organizationId}`;
      const receipt = await this.db.settings.findUnique({
        where: { key: receiptKey },
      });
      const receiptValue = receipt?.value as
        | {
            modeRevision?: unknown;
            status?: unknown;
            attempts?: unknown;
            nextAttemptAt?: unknown;
          }
        | null
        | undefined;
      const sameRevision = receiptValue?.modeRevision === value.revision;
      const retryAt =
        typeof receiptValue?.nextAttemptAt === 'string'
          ? Date.parse(receiptValue.nextAttemptAt)
          : NaN;
      if (
        sameRevision &&
        (receiptValue?.status === 'COMPLETED' ||
          (Number.isFinite(retryAt) && retryAt > Date.now()))
      ) {
        continue;
      }

      const operator = await this.db.userOrganization.findFirst({
        where: {
          organizationId,
          disabled: false,
          role: { in: ['ADMIN', 'SUPERADMIN'] },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!operator) {
        this.logger.error(
          `Legacy identity reconciliation skipped for organization ${organizationId}: ACCOUNT_IDENTITY_ADMIN_REQUIRED`
        );
        continue;
      }

      let result: LegacyIdentityReconciliationResult;
      try {
        result = await this.reconcileOrganization(
          organizationId,
          operator.userId,
          true
        );
      } catch (error) {
        this.logger.error(
          `Legacy identity reconciliation failed for organization ${organizationId}`,
          error instanceof Error ? error.stack : error
        );
        continue;
      }

      const attempts =
        sameRevision && Number.isInteger(receiptValue?.attempts)
          ? (receiptValue!.attempts as number) + 1
          : 1;
      const retryDelay = Math.min(
        RETRY_MAX_MS,
        RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1)
      );
      const reconciliationReceipt = {
        version: 1,
        modeRevision: value.revision,
        status: result.failed > 0 ? 'RETRY_PENDING' : 'COMPLETED',
        attempts,
        completedAt: new Date().toISOString(),
        ...(result.failed > 0
          ? { nextAttemptAt: new Date(Date.now() + retryDelay).toISOString() }
          : {}),
        result,
      };

      await this.db.settings.upsert({
        where: { key: receiptKey },
        create: {
          key: receiptKey,
          type: 'object',
          value: reconciliationReceipt as unknown as Prisma.InputJsonValue,
        },
        update: {
          value: reconciliationReceipt as unknown as Prisma.InputJsonValue,
        },
      });
      completed.push(result);
    }
    return completed;
  }
}
