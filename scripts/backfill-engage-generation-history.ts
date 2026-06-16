/**
 * Backfill EngageOpportunityState.generationHistory for replies generated before
 * the column existed (legacy rows are SQL NULL).
 *
 * IMPORTANT — what can and cannot be recovered:
 *   Before this feature, AI-generated reply text was streamed over SSE and NEVER
 *   persisted unless the user sent or saved it. So the only recoverable content
 *   lives on EngageSentReply.post.content (+ inputData). The engage_reply
 *   BillingRecords are the true per-generation ledger (count / time / length /
 *   cost / taskId) but carry NO content.
 *
 * This script therefore seeds one history entry per EngageSentReply (sent,
 * scheduled, manual, error, or saved DRAFT — every row that has real content),
 * enriching each with a matching engage_reply BillingRecord:
 *   - content / strategy / brandStrength / mentions  ← EngageSentReply (+ inputData)
 *   - length / cost / billingTaskId / createdAt       ← matched BillingRecord
 * Most historical opportunities are 1 reply ↔ 1 charge, so the pairing is exact.
 * When a reply has no matching charge, the entry still keeps the real content
 * (cost 0, a synthetic `backfill_<sentReplyId>` taskId). Paid generations whose
 * content is unrecoverable (charges with no sent/saved reply) are COUNTED and
 * REPORTED, never fabricated.
 *
 * Entries are written oldest-first (the storage contract — the read reverses to
 * newest-first). Idempotent: only fills rows whose generationHistory is NULL/empty
 * (so replies captured after the feature shipped are untouched). `--all` overwrites.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --all --execute   # overwrite non-empty rows
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { Prisma, PrismaClient } from '@prisma/client';
import { AiseeBusinessType } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { GenerationHistoryEntry } from '@gitroom/nestjs-libraries/engage/engage.repository';

// Reply rows whose billing was uncounted (failed/aborted generation) — excluded
// so the backfill mirrors the live path, which records history only on success.
const RELEASED_STATUS = 'released';
const DEFAULT_STRATEGY = 'EXPERT_ANSWER';
const DEFAULT_LENGTH: GenerationHistoryEntry['length'] = 'medium';

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
  all: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let dryRun = true;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--all': all = true; break;
      case '--help':
        console.log('Usage: backfill-engage-generation-history.ts [--org <id>] [--all] [--dry-run|--execute]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, dryRun, all };
}

type SentReplyRow = {
  id: string;
  organizationId: string;
  opportunityId: string;
  inputData: Prisma.JsonValue;
  createdAt: Date;
  post: { content: string; publishDate: Date | null } | null;
};

type BillingRow = {
  taskId: string;
  amount: string;
  data: Prisma.JsonValue;
  createdAt: Date;
};

/** Pull {strategy, brandStrength, mentions} out of EngageSentReply.inputData. */
function readInputData(input: Prisma.JsonValue): {
  strategy: string;
  brandStrength: number;
  mentions?: string[];
} {
  const obj = (input && typeof input === 'object' && !Array.isArray(input))
    ? (input as Record<string, unknown>)
    : {};
  const strategy = typeof obj.strategy === 'string' ? obj.strategy : DEFAULT_STRATEGY;
  const brandStrength = typeof obj.brandStrength === 'number' ? obj.brandStrength : 0;
  const mentions = Array.isArray(obj.mentions)
    ? (obj.mentions.filter((m) => typeof m === 'string') as string[])
    : undefined;
  return { strategy, brandStrength, ...(mentions && mentions.length ? { mentions } : {}) };
}

/** Read the `length` tier a BillingRecord was charged at (data.length). */
function readBillingLength(data: Prisma.JsonValue): GenerationHistoryEntry['length'] {
  const obj = (data && typeof data === 'object' && !Array.isArray(data))
    ? (data as Record<string, unknown>)
    : {};
  return obj.length === 'short' || obj.length === 'long' ? obj.length : DEFAULT_LENGTH;
}

/**
 * Build the oldest-first generationHistory for one opportunity by zipping its
 * (time-sorted) sent replies against its (time-sorted) engage_reply charges. One
 * entry per reply (the unit with content); the i-th reply pairs with the i-th
 * charge when present. Returns the entries plus how many charges were left
 * unpaired (paid generations whose content is unrecoverable).
 */
function buildEntries(
  replies: SentReplyRow[],
  billing: BillingRow[]
): { entries: GenerationHistoryEntry[]; unrecoverableCharges: number } {
  const entries: GenerationHistoryEntry[] = replies.map((reply, i) => {
    const charge = billing[i]; // undefined when there are fewer charges than replies
    const { strategy, brandStrength, mentions } = readInputData(reply.inputData);
    return {
      content: reply.post?.content ?? '',
      length: charge ? readBillingLength(charge.data) : DEFAULT_LENGTH,
      cost: charge ? Math.max(0, Number(charge.amount) || 0) : 0,
      strategy,
      brandStrength,
      ...(mentions ? { mentions } : {}),
      billingTaskId: charge ? charge.taskId : `backfill_${reply.id}`,
      createdAt: (charge?.createdAt ?? reply.post?.publishDate ?? reply.createdAt).toISOString(),
    };
  });
  const unrecoverableCharges = Math.max(0, billing.length - replies.length);
  return { entries, unrecoverableCharges };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill EngageOpportunityState.generationHistory ===\n');
  console.log(`Mode:  ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:   ${args.orgId ?? 'all'}`);
  console.log(`Scope: ${args.all ? 'all rows (overwrite)' : 'rows with empty/NULL generationHistory'}\n`);

  const prisma = new PrismaClient();

  // Every EngageSentReply (any state — sent/scheduled/manual/error/DRAFT) carries
  // content, so all of them seed history. Ordered by (org, opp, createdAt) so the
  // per-opportunity grouping below is already oldest-first.
  const replies = (await prisma.engageSentReply.findMany({
    where: { ...(args.orgId ? { organizationId: args.orgId } : {}) },
    select: {
      id: true,
      organizationId: true,
      opportunityId: true,
      inputData: true,
      createdAt: true,
      post: { select: { content: true, publishDate: true } },
    },
    orderBy: [{ organizationId: 'asc' }, { opportunityId: 'asc' }, { createdAt: 'asc' }],
  })) as SentReplyRow[];

  // Group replies by (org, opportunity).
  const groups = new Map<string, SentReplyRow[]>();
  for (const r of replies) {
    const key = `${r.organizationId}::${r.opportunityId}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(r);
  }

  console.log(
    `Found ${replies.length} sent/saved repl${replies.length === 1 ? 'y' : 'ies'} across ` +
    `${groups.size} opportunit${groups.size === 1 ? 'y' : 'ies'}.\n`
  );

  let filled = 0;       // state rows we (would) write
  let skippedNonEmpty = 0; // already has history (and not --all)
  let skippedNoState = 0;  // no EngageOpportunityState row to write onto
  let entriesWritten = 0;  // total history entries seeded
  let unrecoverable = 0;   // paid generations with no recoverable content

  for (const groupReplies of groups.values()) {
    const { organizationId, opportunityId } = groupReplies[0];

    const state = await prisma.engageOpportunityState.findUnique({
      where: { organizationId_opportunityId: { organizationId, opportunityId } },
      select: { generationHistory: true },
    });
    if (!state) {
      // No per-org state row → nowhere to store the history. Rare (an actionable
      // opportunity always has one); report rather than silently drop.
      skippedNoState++;
      continue;
    }
    const existing = state.generationHistory;
    const hasHistory = Array.isArray(existing) && existing.length > 0;
    if (hasHistory && !args.all) {
      skippedNonEmpty++;
      continue;
    }

    // engage_reply charges for this opportunity (relatedId = opportunityId),
    // excluding uncounted (released) generations, oldest-first.
    const billing = (await prisma.billingRecord.findMany({
      where: {
        organizationId,
        businessType: AiseeBusinessType.ENGAGE_REPLY,
        relatedId: opportunityId,
        status: { not: RELEASED_STATUS },
      },
      select: { taskId: true, amount: true, data: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })) as BillingRow[];

    const { entries, unrecoverableCharges } = buildEntries(groupReplies, billing);
    unrecoverable += unrecoverableCharges;

    filled++;
    entriesWritten += entries.length;
    console.log(
      `  [${organizationId.slice(0, 8)}] opp=${opportunityId.slice(0, 8)}  ` +
      `-> ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` +
      (unrecoverableCharges ? `  (+${unrecoverableCharges} charge(s) w/o recoverable content)` : '')
    );

    if (!args.dryRun) {
      await prisma.engageOpportunityState.update({
        where: { organizationId_opportunityId: { organizationId, opportunityId } },
        data: { generationHistory: entries as unknown as Prisma.InputJsonValue },
      });
    }
  }

  console.log(
    `\n${args.dryRun ? 'Would fill' : 'Filled'}: ${filled} opportunit${filled === 1 ? 'y' : 'ies'} ` +
    `(${entriesWritten} entr${entriesWritten === 1 ? 'y' : 'ies'}), ` +
    `already-populated: ${skippedNonEmpty}, no-state-row: ${skippedNoState}.\n` +
    `Paid generations with unrecoverable content (reported, not seeded): ${unrecoverable}.` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : '')
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
