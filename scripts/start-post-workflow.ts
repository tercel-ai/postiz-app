/**
 * Manually start a post workflow for specific post IDs.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId> [postId2 ...]
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Connection, Client } from '@temporalio/client';
import { PrismaClient } from '@prisma/client';

async function main() {
  const postIds = process.argv.slice(2);
  if (!postIds.length) {
    console.error('Usage: npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId> [postId2 ...]');
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  const prisma = new PrismaClient();
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  for (const postId of postIds) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { integration: { select: { providerIdentifier: true } } },
    });

    if (!post) {
      console.log(`  [${postId}] Not found, skipping`);
      continue;
    }
    if (post.state !== 'QUEUE') {
      console.log(`  [${postId}] State is ${post.state}, skipping (must be QUEUE)`);
      continue;
    }

    const taskQueue = post.integration?.providerIdentifier?.split('-')[0]?.toLowerCase() || 'main';
    const workflowId = `post_${postId}`;

    try {
      await client.workflow.start('postWorkflowV101', {
        workflowId,
        taskQueue: 'main',
        args: [{
          taskQueue,
          postId,
          organizationId: post.organizationId,
        }],
      });
      console.log(`  [${postId}] Started workflow ${workflowId} (taskQueue: ${taskQueue})`);
    } catch (err: any) {
      if (err?.message?.includes('already started') || err?.message?.includes('already exists')) {
        console.log(`  [${postId}] Workflow already exists, skipping`);
      } else {
        console.log(`  [${postId}] Error: ${err?.message || err}`);
      }
    }
  }

  await prisma.$disconnect();
  await connection.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
