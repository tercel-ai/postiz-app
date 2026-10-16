import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma/prisma.service';
import { SEND_ACCOUNT_POLICY_KEY } from './send-policy.constants';
import {
  SaveSendPreferencesDto,
  SaveSystemSendPolicyDto,
} from './send-policy.dto';

export { SEND_ACCOUNT_POLICY_KEY } from './send-policy.constants';
export interface SendAccountPolicy {
  mode: 'REQUIRED' | 'OPTIONAL';
  revision: number;
  lastRequiredRevision: number;
}
export interface SendPolicySnapshot {
  policyRevision: number;
  requirePreselectedAccount: boolean;
}
const hash = (payload: unknown) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const validRevision = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 2147483647;

@Injectable()
export class SendPolicyService {
  constructor(private readonly db: PrismaService) {}

  private async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          attempt < 3 &&
          ['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')
        )
          continue;
        throw error;
      }
    }
  }

  private validateMutation(body: {
    expectedRevision: number;
    requestId: string;
  }) {
    if (
      !body ||
      !validRevision(body.expectedRevision) ||
      body.expectedRevision === 2147483647 ||
      typeof body.requestId !== 'string' ||
      !body.requestId.trim() ||
      body.requestId.length > 128
    )
      throw new BadRequestException('INVALID_SEND_POLICY_MUTATION');
  }

  async getSystem(
    tx: Pick<Prisma.TransactionClient, 'settings'> = this.db
  ): Promise<SendAccountPolicy> {
    const row = await tx.settings.findUnique({
      where: { key: SEND_ACCOUNT_POLICY_KEY },
    });
    return this.parseSystem(row?.value, !!row);
  }

  private parseSystem(raw: unknown, exists: boolean): SendAccountPolicy {
    if (!exists)
      return { mode: 'REQUIRED', revision: 0, lastRequiredRevision: 0 };
    const value = raw as SendAccountPolicy;
    if (
      !value ||
      !['REQUIRED', 'OPTIONAL'].includes(value.mode) ||
      !validRevision(value.revision) ||
      value.revision === 0 ||
      !validRevision(value.lastRequiredRevision) ||
      value.lastRequiredRevision > value.revision ||
      (value.mode === 'REQUIRED' &&
        value.lastRequiredRevision !== value.revision)
    )
      throw new ServiceUnavailableException('SEND_POLICY_INVALID');
    return {
      mode: value.mode,
      revision: value.revision,
      lastRequiredRevision: value.lastRequiredRevision,
    };
  }

  // Serialize first CURRENT_SESSION binding with policy writes, before intent rows.
  async lockSystemInTransaction(
    tx: Prisma.TransactionClient
  ): Promise<SendAccountPolicy> {
    const row = await tx.settings.findUnique({
      where: { key: SEND_ACCOUNT_POLICY_KEY },
    });
    const policy = this.parseSystem(row?.value, !!row);
    if (row) {
      const locked = await tx.settings.updateMany({
        where: {
          key: SEND_ACCOUNT_POLICY_KEY,
          value: { equals: row.value as Prisma.InputJsonValue },
        },
        data: {
          value: row.value as Prisma.InputJsonValue,
          updatedAt: row.updatedAt,
        },
      });
      if (locked.count !== 1)
        throw new ConflictException('SEND_POLICY_CHANGED');
    }
    // An absent key means REQUIRED; it cannot authorize an unbound current actor.
    return policy;
  }

  // A retained revision barrier also protects tasks missed by an asynchronous scan.
  requiresPreselection(
    snapshot: SendPolicySnapshot,
    current: SendAccountPolicy
  ): boolean {
    return (
      current.mode === 'REQUIRED' ||
      snapshot.requirePreselectedAccount !== false ||
      !validRevision(snapshot.policyRevision) ||
      snapshot.policyRevision < current.lastRequiredRevision ||
      snapshot.policyRevision > current.revision
    );
  }

  async saveSystem(userId: string, body: SaveSystemSendPolicyDto) {
    this.validateMutation(body);
    if (
      !body.value ||
      Object.keys(body.value).some((key) => key !== 'mode') ||
      !['REQUIRED', 'OPTIONAL'].includes(body.value.mode)
    )
      throw new BadRequestException('INVALID_SEND_POLICY_MUTATION');
    const fingerprint = hash({
      mode: body.value.mode,
      expectedRevision: body.expectedRevision,
    });
    return this.transaction(async (tx) => {
      if (
        !userId ||
        !(
          await tx.user.findUnique({
            where: { id: userId },
            select: { isSuperAdmin: true },
          })
        )?.isSuperAdmin
      )
        throw new ForbiddenException('PLATFORM_SUPERADMIN_REQUIRED');
      const key = { userId, requestId: body.requestId };
      const receipt = await tx.systemSendPolicyMutationReceipt.findUnique({
        where: { userId_requestId: key },
      });
      if (receipt) {
        if (receipt.requestHash !== fingerprint)
          throw new ConflictException('REQUEST_ID_CONFLICT');
        return receipt.result as unknown as {
          key: string;
          value: SendAccountPolicy;
        };
      }
      const previous = await this.getSystem(tx);
      if (previous.revision !== body.expectedRevision)
        throw new ConflictException('SEND_POLICY_REVISION_CONFLICT');
      const revision = previous.revision + 1;
      const value = {
        mode: body.value.mode,
        revision,
        lastRequiredRevision:
          body.value.mode === 'REQUIRED'
            ? revision
            : previous.lastRequiredRevision,
      };
      if (previous.revision === 0) {
        await tx.settings.create({
          data: { key: SEND_ACCOUNT_POLICY_KEY, type: 'object', value },
        });
      } else {
        const saved = await tx.settings.updateMany({
          where: {
            key: SEND_ACCOUNT_POLICY_KEY,
            value: { equals: previous as unknown as Prisma.InputJsonValue },
          },
          data: { value },
        });
        if (saved.count !== 1)
          throw new ConflictException('SEND_POLICY_REVISION_CONFLICT');
      }
      const result = { key: SEND_ACCOUNT_POLICY_KEY, value };
      await tx.systemSendPolicyMutationReceipt.create({
        data: { ...key, requestHash: fingerprint, result },
      });
      return result;
    });
  }

  async snapshotInTransaction(
    tx: Prisma.TransactionClient,
    ownerUserId?: string
  ) {
    const policy = await this.getSystem(tx);
    const preference = ownerUserId
      ? await tx.userSendPreference.findUnique({
          where: { userId: ownerUserId },
        })
      : null;
    return {
      policyRevision: policy.revision,
      requirePreselectedAccount:
        policy.mode === 'REQUIRED' ||
        preference?.requirePreselectedAccount === true,
      preferenceRevision: preference?.revision ?? 0,
      policyOwnerUserId: ownerUserId ?? null,
    };
  }

  async getPreferences(userId: string) {
    if (!userId) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
    return this.transaction(async (tx) => {
      const preference = await tx.userSendPreference.findUnique({
        where: { userId },
      });
      const policy = await this.getSystem(tx);
      return {
        requirePreselectedAccount:
          preference?.requirePreselectedAccount ?? null,
        revision: preference?.revision ?? 0,
        systemMode: policy.mode,
        effectiveRequirePreselectedAccount:
          policy.mode === 'REQUIRED' ||
          preference?.requirePreselectedAccount === true,
        policyRevision: policy.revision,
      };
    });
  }

  async savePreferences(
    org: string,
    userId: string,
    body: SaveSendPreferencesDto
  ) {
    this.validateMutation(body);
    if (
      body.requirePreselectedAccount !== null &&
      typeof body.requirePreselectedAccount !== 'boolean'
    )
      throw new BadRequestException('INVALID_SEND_PREFERENCE');
    const fingerprint = hash({
      requirePreselectedAccount: body.requirePreselectedAccount,
      expectedRevision: body.expectedRevision,
    });
    return this.transaction(async (tx) => {
      if (!userId) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
      const member = await tx.userOrganization.findUnique({
        where: { userId_organizationId: { userId, organizationId: org } },
      });
      if (!member || member.disabled)
        throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
      const key = {
        organizationId: org,
        userId,
        operation: 'send-preferences',
        requestId: body.requestId,
      };
      const receipt = await tx.sendMutationReceipt.findUnique({
        where: { organizationId_userId_operation_requestId: key },
      });
      if (receipt) {
        if (receipt.requestHash !== fingerprint)
          throw new ConflictException('REQUEST_ID_CONFLICT');
        return receipt.result as unknown as {
          requirePreselectedAccount: boolean | null;
          revision: number;
        };
      }
      const previous = await tx.userSendPreference.findUnique({
        where: { userId },
      });
      if ((previous?.revision ?? 0) !== body.expectedRevision)
        throw new ConflictException('SEND_PREFERENCE_REVISION_CONFLICT');
      if (previous) {
        const saved = await tx.userSendPreference.updateMany({
          where: { userId, revision: body.expectedRevision },
          data: {
            requirePreselectedAccount: body.requirePreselectedAccount,
            revision: { increment: 1 },
          },
        });
        if (saved.count !== 1)
          throw new ConflictException('SEND_PREFERENCE_REVISION_CONFLICT');
      } else {
        await tx.userSendPreference.create({
          data: {
            userId,
            requirePreselectedAccount: body.requirePreselectedAccount,
            revision: 1,
          },
        });
      }
      const result = {
        requirePreselectedAccount: body.requirePreselectedAccount,
        revision: body.expectedRevision + 1,
      };
      await tx.sendMutationReceipt.create({
        data: { ...key, requestHash: fingerprint, result },
      });
      return result;
    });
  }
}
