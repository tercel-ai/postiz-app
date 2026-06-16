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
 * scheduled, manual, error, or saved DRAFT — every row that has real content), and
 * TAGS each with its provenance so AI and hand-typed versions are distinguishable:
 *   - source='ai'     ← reply matched to an engage_reply charge (a real, paid AI
 *                        generation); takes length/cost/billingTaskId/time from it.
 *   - source='manual' ← reply with no matching charge (hand-typed / hand-saved);
 *                        cost 0, synthetic `backfill_<sentReplyId>` taskId.
 *   - content / strategy / brandStrength / mentions  ← EngageSentReply (+ inputData)
 * (Only generateDraft writes an engage_reply charge — save-draft and manual replies
 * never do — so "has a charge" is the reliable AI signal in legacy data.) Most
 * historical opportunities are 1 reply ↔ 1 charge, so the pairing is exact. Paid
 * generations whose content is unrecoverable (charges with no sent/saved reply) are
 * COUNTED and REPORTED, never fabricated.
 *
 * Entries are written oldest-first (the storage contract — the read reverses to
 * newest-first) and stamped `backfilled: true`. Re-runnable and self-protecting:
 * default mode fills empty rows AND re-backfills already-populated rows, but SKIPS
 * any row holding a LIVE ai entry (source='ai' without the backfill marker) — a
 * generated-but-unsent draft that lives only in generationHistory and would be lost
 * by an overwrite. Pure-backfill rows and rows that only added live MANUAL saves
 * (always reconstructible from EngageSentReply) are safely rebuilt. `--all` forces
 * an overwrite of every row, including ones with live ai entries.
 *
 * NOTE: rows written by an OLDER version of this script lack the `backfilled` marker,
 * so default mode treats them as live-ai and skips them — use `--all` once to
 * re-sync those into the current format.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-generation-history.ts --all --execute   # force overwrite (incl. live ai)
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
 * Build the oldest-first generationHistory for one opportunity. One entry per sent/
 * saved reply (the unit with real content). Each engage_reply charge (a real, paid
 * AI generation) is matched to its NEAREST-in-time reply (greedy, each charge claims
 * one reply): a matched reply is tagged source='ai' and enriched with the charge's
 * length/cost/taskId; an unmatched reply is hand-typed → source='manual' (cost 0,
 * synthetic taskId). Nearest-by-time beats index-zip when a manual reply is
 * interleaved with an AI one. Returns the entries plus how many charges claimed no
 * reply (paid generations whose content is unrecoverable — reported, never seeded).
 */
function buildEntries(
  replies: SentReplyRow[],
  billing: BillingRow[]
): { entries: GenerationHistoryEntry[]; unrecoverableCharges: number } {
  // Greedily assign each charge to its closest unclaimed reply by createdAt.
  const chargeForReply = new Map<number, BillingRow>();
  const claimed = new Set<number>();
  let matchedCharges = 0;
  for (const charge of billing) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < replies.length; i++) {
      if (claimed.has(i)) continue;
      const dist = Math.abs(replies[i].createdAt.getTime() - charge.createdAt.getTime());
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    if (best >= 0) { claimed.add(best); chargeForReply.set(best, charge); matchedCharges++; }
    // else: no reply left to attach → content unrecoverable (counted below).
  }

  const entries: GenerationHistoryEntry[] = replies.map((reply, i) => {
    const charge = chargeForReply.get(i);
    const { strategy, brandStrength, mentions } = readInputData(reply.inputData);
    return {
      source: charge ? 'ai' : 'manual',
      content: reply.post?.content ?? '',
      strategy,
      brandStrength,
      ...(mentions ? { mentions } : {}),
      // length/cost/billingTaskId are AI-only (charge-backed); manual entries have
      // no charge, so they carry none of them.
      ...(charge
        ? {
            length: readBillingLength(charge.data),
            cost: Math.max(0, Number(charge.amount) || 0),
            billingTaskId: charge.taskId,
          }
        : {}),
      createdAt: (charge?.createdAt ?? reply.post?.publishDate ?? reply.createdAt).toISOString(),
      // Mark as backfill-produced so a later default-mode re-run can safely
      // overwrite this row without clobbering any live-generated entry.
      backfilled: true,
    };
  });
  // Stored oldest-first (the read reverses to newest-first). 'ai' entries carry the
  // charge time, 'manual' the reply time, so re-sort to a single timeline.
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { entries, unrecoverableCharges: billing.length - matchedCharges };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill EngageOpportunityState.generationHistory ===\n');
  console.log(`Mode:  ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:   ${args.orgId ?? 'all'}`);
  console.log(`Scope: ${args.all ? 'all rows (force overwrite, incl. live ai)' : 'empty rows + pure-backfill/manual rows (skips rows with a live ai entry)'}\n`);

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
  let skippedLiveAi = 0;   // populated with a live (non-backfill) ai entry — protected
  let skippedNoState = 0;  // no EngageOpportunityState row to write onto
  let aiEntries = 0;       // entries tagged source='ai' (charge-backed)
  let manualEntries = 0;   // entries tagged source='manual' (hand-typed)
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
    // Default mode safely re-backfills a POPULATED row too — but only when it holds
    // no LIVE ai entry. A live 'ai' draft (source='ai' without the backfill marker)
    // exists ONLY here (generated, not yet sent → no EngageSentReply to rebuild it
    // from), so overwriting would lose it; such rows are skipped unless --all forces
    // it. Pure-backfill rows and rows that only added live MANUAL saves (always
    // reconstructible from EngageSentReply) are safe to rebuild.
    const existing = Array.isArray(state.generationHistory)
      ? (state.generationHistory as unknown as GenerationHistoryEntry[])
      : [];
    const hasLiveAi = existing.some((e) => e?.source === 'ai' && !e.backfilled);
    if (hasLiveAi && !args.all) {
      skippedLiveAi++;
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
    const ai = entries.filter((e) => e.source === 'ai').length;
    const manual = entries.length - ai;
    aiEntries += ai;
    manualEntries += manual;

    filled++;
    console.log(
      `  [${organizationId.slice(0, 8)}] opp=${opportunityId.slice(0, 8)}  ` +
      `-> ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${ai} ai, ${manual} manual)` +
      (unrecoverableCharges ? `  (+${unrecoverableCharges} charge(s) w/o recoverable content)` : '')
    );

    if (!args.dryRun) {
      await prisma.engageOpportunityState.update({
        where: { organizationId_opportunityId: { organizationId, opportunityId } },
        data: { generationHistory: entries as unknown as Prisma.InputJsonValue },
      });
    }
  }

  const entriesWritten = aiEntries + manualEntries;
  console.log(
    `\n${args.dryRun ? 'Would fill' : 'Filled'}: ${filled} opportunit${filled === 1 ? 'y' : 'ies'} ` +
    `(${entriesWritten} entr${entriesWritten === 1 ? 'y' : 'ies'}: ${aiEntries} ai, ${manualEntries} manual), ` +
    `skipped (live ai, protected): ${skippedLiveAi}, no-state-row: ${skippedNoState}.\n` +
    `Paid generations with unrecoverable content (reported, not seeded): ${unrecoverable}.` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : '')
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
