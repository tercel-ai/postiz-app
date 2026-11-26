import type { OperationPlan, Prisma } from '@prisma/client';

type PlanOrder = Pick<OperationPlan, 'id' | 'organizationId' | 'projectId' | 'createdAt'>;
type PlanStore = Pick<Prisma.TransactionClient, 'operationPlan' | 'post'>;

/** A newer plan wins once it has materialized content, including later-deleted posts. */
export async function hasMaterializedSuccessor(
  model: Pick<PlanStore, 'operationPlan'>,
  plan: PlanOrder
): Promise<boolean> {
  return Boolean(await model.operationPlan.findFirst({
    where: {
      id: { not: plan.id },
      organizationId: plan.organizationId,
      projectId: plan.projectId,
      createdAt: { gt: plan.createdAt },
      posts: { some: {} },
    },
    select: { id: true },
  }));
}

/** Production calls this in the same serializable transaction as plan materialization. */
export async function persistPlanDrafts(
  model: PlanStore,
  plan: PlanOrder,
  posts: Prisma.PostCreateManyInput[]
): Promise<Prisma.BatchPayload & { superseded?: true }> {
  if (await hasMaterializedSuccessor(model, plan)) return { count: 0, superseded: true };
  const result = posts.length
    ? await model.post.createMany({ data: posts, skipDuplicates: true })
    : { count: 0 };

  if (result.count || await model.post.count({
    where: { organizationId: plan.organizationId, operationPlanId: plan.id, deletedAt: null },
  })) {
    await model.post.updateMany({
      where: {
        organizationId: plan.organizationId,
        projectId: plan.projectId,
        state: 'DRAFT',
        deletedAt: null,
        operationPlan: { is: { createdAt: { lt: plan.createdAt } } },
      },
      data: { deletedAt: new Date(), parentPostId: null },
    });
  }
  return result;
}
