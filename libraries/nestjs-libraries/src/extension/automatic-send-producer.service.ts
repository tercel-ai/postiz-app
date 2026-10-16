import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma/prisma.service';
import { PostsService } from '../database/prisma/posts/posts.service';
import { SendCoordinatorService } from './send-coordinator.service';
import { sendTransaction } from './send-coordination.utils';
import { getSocialTaskQueue } from '../temporal/task-queue';
@Injectable()
export class AutomaticSendProducerService {
  constructor(private readonly db: PrismaService, private readonly sends: SendCoordinatorService, private readonly posts: PostsService) {}
  async assertOwnerAvailable(org: string, user: string) {
    const member = user && await this.db.userOrganization.findUnique({ where: { userId_organizationId: { userId: user, organizationId: org } } });
    if (!member || member.disabled) throw new ForbiddenException('SEND_POLICY_OWNER_UNAVAILABLE');
  }
  async saveOwner(org: string, project: string, action: 'POST' | 'REPLY', user: string) {
    if (!user) throw new ForbiddenException('SEND_POLICY_OWNER_UNAVAILABLE');
    return sendTransaction(this.db, async tx => {
      const member = await tx.userOrganization.findUnique({ where: { userId_organizationId: { userId: user, organizationId: org } } });
      if (!member || member.disabled) throw new ForbiddenException('SEND_POLICY_OWNER_UNAVAILABLE');
      return tx.projectSendOwner.upsert({ where: { organizationId_projectId_action: { organizationId: org, projectId: project, action } }, create: { organizationId: org, projectId: project, action, userId: user }, update: { userId: user, revision: { increment: 1 } } });
    });
  }
  async owner(org: string, project: string, action: 'POST' | 'REPLY') {
    const row = await this.db.projectSendOwner.findUnique({ where: { organizationId_projectId_action: { organizationId: org, projectId: project, action } } });
    if (!row) throw new ForbiddenException('AUTOMATION_POLICY_OWNER_REQUIRED');
    const member = await this.db.userOrganization.findUnique({ where: { userId_organizationId: { userId: row.userId, organizationId: org } } });
    if (!member || member.disabled) throw new ForbiddenException('SEND_POLICY_OWNER_UNAVAILABLE');
    return row.userId;
  }
  async enqueue(org: string, project: string, rootId: string, action: 'POST' | 'REPLY', publishMethod: 'API' | 'EXTENSION' = 'EXTENSION') {
    const userId = await this.owner(org, project, action);
    const root = await this.db.post.findFirst({ where: { id: rootId, organizationId: org } });
    if (root && root.projectId !== project) throw new ForbiddenException('AUTOMATION_PROJECT_MISMATCH');
    const queued = await this.sends.enqueue(org, rootId, { userId, origin: 'AUTOMATION', action, publishMethod });
    if (queued.publishMethod === 'API') await this.posts.startWorkflow(getSocialTaskQueue(queued.providerIdentifier!), queued.id, org);
    return queued;
  }
  async adoptPendingReplies(org: string, project: string, platform: string) {
    await this.owner(org, project, 'REPLY');
    const rows = await this.db.engageSentReply.findMany({ where: { organizationId: org, projectId: project, opportunity: { platform }, post: { sendIntentId: null, state: 'DRAFT', executionProtocol: 'ACCOUNT_BOUND_V1', sendOrigin: 'AUTOMATION', releaseId: null, claimedAt: null } }, select: { postId: true }, take: 10 });
    for (const row of rows) {
      try { await this.enqueue(org, project, row.postId, 'REPLY'); } catch { /* A saved automatic draft remains recoverable when its route is unavailable. */ }
    }
    return rows.length;
  }
}
