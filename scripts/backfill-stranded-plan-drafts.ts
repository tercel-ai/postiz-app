/**
 * Commit operation-plan posts that were materialized as DRAFT while a
 * project's Automation was ALREADY on, and so were never picked up by the
 * OFF->ON commit edge in AutomationService.savePublishing/saveEnabled.
 *
 * Root cause (fixed going forward in operation-plan.service.ts
 * _materializePlanPosts, which now calls PostsService.schedulePlanPosts right
 * after every materialization): before that fix, DRAFT -> QUEUE only happened
 * on an explicit commit or an OFF->ON transition of the Automation switches.
 * A project that regenerated its plan while Automation was already on had no
 * such transition, so its fresh DRAFTs sat stranded — invisible to the
 * extension's publish-due queue (state=QUEUE only) forever.
 *
 * This script re-runs PostsService.schedulePlanPosts (the SAME method the
 * live commit paths use — see AutomationService._commitPlanPosts) for every
 * project that currently has at least one Post with
 * `state = DRAFT AND operationPlanId IS NOT NULL AND deletedAt IS NULL`.
 * Scope is enforced twice: once here (to build the project worklist) and
 * again inside schedulePlanPosts itself (getPlanPostRootsForProject filters
 * `operationPlanId: { not: null }` and only ever touches rows still in
 * DRAFT) — a hand-authored post (operationPlanId null) can never be reached
 * by either pass, no matter what this script does.
 *
 * schedulePlanPosts is otherwise a no-op for a project whose Automation is
 * NOT active (it checks isPublishingActive itself and returns an empty
 * batch), so running this against every affected project is safe — it only
 * ever commits posts for projects where Automation is genuinely on right now.
 *
 * Idempotent: rows already moved to QUEUE by a previous run (or by the code
 * fix, going forward) are simply not DRAFT any more and are skipped.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-stranded-plan-drafts.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-stranded-plan-drafts.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-stranded-plan-drafts.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-stranded-plan-drafts.ts --project <projectId> --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import {
  ProjectPublishingService,
  isPublishingActive,
} from '@gitroom/nestjs-libraries/automation/project-publishing.service';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  orgId: string | null;
  projectId: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let projectId: string | null = null;
  let dryRun = true;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--project':
        projectId = args[++i] ?? null;
        if (!projectId) { console.error('--project requires a value'); process.exit(1); }
        break;
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--help':
        console.log(
          'Usage: backfill-stranded-plan-drafts.ts [--org <id>] [--project <id>] [--dry-run|--execute]'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, projectId, dryRun };
}

interface ProjectWorkItem {
  organizationId: string;
  projectId: string;
  strandedDrafts: number;
}

/**
 * One row per (organizationId, projectId) that currently has at least one
 * stranded plan draft — the exact scope the fix and this backfill both share.
 */
async function findAffectedProjects(
  prisma: PrismaClient,
  orgId: string | null,
  projectId: string | null
): Promise<ProjectWorkItem[]> {
  const rows = await prisma.post.groupBy({
    by: ['organizationId', 'projectId'],
    where: {
      state: 'DRAFT',
      operationPlanId: { not: null },
      deletedAt: null,
      projectId: projectId ? projectId : { not: null },
      ...(orgId ? { organizationId: orgId } : {}),
    },
    _count: { _all: true },
  });

  return rows
    .filter((r): r is typeof r & { projectId: string } => !!r.projectId)
    .map((r) => ({
      organizationId: r.organizationId,
      projectId: r.projectId,
      strandedDrafts: r._count._all,
    }));
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill stranded operation-plan DRAFT posts ===\n');
  console.log(`Mode:    ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:     ${args.orgId ?? 'all'}`);
  console.log(`Project: ${args.projectId ?? 'all'}\n`);

  const prisma = new PrismaClient();
  const projects = await findAffectedProjects(prisma, args.orgId, args.projectId);

  console.log(
    `Found ${projects.length} project${projects.length === 1 ? '' : 's'} with ` +
    `DRAFT posts still carrying an operationPlanId.\n`
  );

  if (projects.length === 0) {
    await prisma.$disconnect();
    return;
  }

  if (args.dryRun) {
    // Dry-run predicts the outcome by resolving each project's publishing
    // state directly — schedulePlanPosts applies this exact same gate
    // (isPublishingActive) before touching anything, so this is a preview of
    // its early-return, not a separate guess.
    const app = await NestFactory.createApplicationContext(ScriptModule, {
      logger: ['error', 'warn'],
    });
    const publishing = app.get(ProjectPublishingService);

    for (const p of projects) {
      const resolved = await publishing.resolve(p.organizationId, p.projectId);
      const willCommit = isPublishingActive(resolved);
      console.log(
        `  [${willCommit ? 'would-commit' : 'skip:automation-off'}] ` +
        `org=${p.organizationId} project=${p.projectId} strandedDrafts=${p.strandedDrafts}`
      );
    }
    console.log('\n--- DRY RUN. Re-run with --execute to commit. ---');
    await app.close();
    await prisma.$disconnect();
    return;
  }

  console.log('Bootstrapping NestJS context...\n');
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });
  const postsService = app.get(PostsService);
  const publishing = app.get(ProjectPublishingService);

  let totalScheduled = 0;
  let totalFailed = 0;
  let totalSkippedAutomationOff = 0;
  let totalErrors = 0;

  for (const p of projects) {
    process.stdout.write(
      `  org=${p.organizationId} project=${p.projectId} (${p.strandedDrafts} stranded) ... `
    );
    try {
      // Checked explicitly (rather than inferred from an empty result) so a
      // project with Automation on but every platform toggled off — which also
      // returns total=0 — is not misreported as "automation off".
      const resolved = await publishing.resolve(p.organizationId, p.projectId);
      if (!isPublishingActive(resolved)) {
        console.log('skip (automation off)');
        totalSkippedAutomationOff++;
        continue;
      }
      // planId=null -> project-scoped: every live plan post still in DRAFT for
      // this project, not just its currently-active plan.
      const result = await postsService.schedulePlanPosts(
        p.organizationId,
        null,
        p.projectId
      );
      console.log(
        `OK: ${result.scheduled.length} committed, ${result.failed.length} failed, ` +
        `${result.alreadyScheduled} already queued`
      );
      totalScheduled += result.scheduled.length;
      totalFailed += result.failed.length;
    } catch (err: any) {
      console.log(`ERROR: ${err?.message || err}`);
      totalErrors++;
    }
  }

  console.log(
    `\nDone: ${totalScheduled} post(s) committed to QUEUE, ${totalFailed} failed, ` +
    `${totalSkippedAutomationOff} project(s) skipped (automation off), ` +
    `${totalErrors} project(s) errored.`
  );

  await app.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
