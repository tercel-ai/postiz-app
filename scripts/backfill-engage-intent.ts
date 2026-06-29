/**
 * Backfill EngageOpportunity.intentTags / primaryIntent / intentScore for rows
 * that were written when the intent classifier was broken (no valid API key).
 *
 * A broken-fallback row is identified by intentScore = 0 (or null) AND
 * primaryIntent = 'discussion'. The local NLI model always returns a non-zero
 * score; score = 0 only comes from the error-fallback path.
 *
 * The script calls the Anthropic / OpenRouter API directly (same logic as
 * EngageIntentClassifierService._claudeFallbackClassify) so it works without a
 * running NestJS server.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-intent.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-intent.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-intent.ts --platform reddit --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-intent.ts --all --execute  # also reclassify non-zero-score rows
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';
// Backfill uses the Cloud classifier only — skip the 44MB local model download.
process.env.ENGAGE_DISABLE_LOCAL_NLI = 'true';

import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { INTENT_LABELS } from '@gitroom/nestjs-libraries/engage/engage-intent.constants';

// ─── CLI args ─────────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  all: boolean;
  platform: string | null;
  batchSize: number;
  concurrency: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let dryRun = true;
  let all = false;
  let platform: string | null = null;
  let batchSize = 50;
  let concurrency = 4;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--execute':    dryRun = false; break;
      case '--dry-run':   dryRun = true;  break;
      case '--all':       all = true;     break;
      case '--platform':
        platform = args[++i] ?? null;
        if (!platform) { console.error('--platform requires a value'); process.exit(1); }
        break;
      case '--batch-size':
        batchSize = parseInt(args[++i] ?? '50', 10);
        if (isNaN(batchSize) || batchSize < 1) { console.error('--batch-size must be a positive integer'); process.exit(1); }
        break;
      case '--concurrency':
        concurrency = parseInt(args[++i] ?? '4', 10);
        if (isNaN(concurrency) || concurrency < 1) { console.error('--concurrency must be a positive integer'); process.exit(1); }
        break;
      case '--help':
        console.log(
          'Usage: backfill-engage-intent.ts [--platform x|reddit] [--all] [--batch-size N] [--concurrency N] [--dry-run|--execute]'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { dryRun, all, platform, batchSize, concurrency };
}

// ─── Classifier (mirrors EngageIntentClassifierService._claudeFallbackClassify) ─

type ClassifyResult = { intentTags: string[]; primaryIntent: string; intentScore: number };

const _useOpenRouter = !!(process.env.OPENROUTER_API_KEY);
const _openRouterClient: OpenAI | null = _useOpenRouter
  ? new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY!, baseURL: 'https://openrouter.ai/api/v1' })
  : null;
const _anthropicClient: Anthropic | null =
  !_useOpenRouter && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '' })
    : null;

if (!_openRouterClient && !_anthropicClient) {
  console.error(
    'No AI API key configured. Set ANTHROPIC_API_KEY, CLAUDE_API_KEY, or OPENROUTER_API_KEY in .env'
  );
  process.exit(1);
}

const VALID_LABELS = new Set<string>(INTENT_LABELS);

async function classifyOne(text: string): Promise<ClassifyResult> {
  const prompt = `Classify this post's intent. Labels: ${INTENT_LABELS.join(', ')}.\n\n"${text.slice(0, 400)}"`;

  try {
    let raw: { intentTags: string[]; primaryIntent: string; intentScore: number } | null = null;

    if (_useOpenRouter && _openRouterClient) {
      const model = process.env.OPENROUTER_INTENT_MODEL ?? 'anthropic/claude-haiku-4.5';
      const resp = await _openRouterClient.chat.completions.create(
        {
          model,
          max_tokens: 128,
          messages: [
            {
              role: 'system',
              content: `You are an intent classifier. Respond with JSON only: {"intentTags":["<label>",...],"primaryIntent":"<label>","intentScore":<0-1>}. Valid labels: ${INTENT_LABELS.join(', ')}.`,
            },
            { role: 'user', content: prompt },
          ],
        },
        { headers: { 'HTTP-Referer': 'https://postiz.com', 'X-Title': 'Postiz Engage Backfill' } }
      );
      const content = resp.choices[0]?.message?.content ?? '';
      const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      try { raw = JSON.parse(stripped); } catch { /* non-JSON — fall through */ }
    } else if (_anthropicClient) {
      const msg = await _anthropicClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 128,
        tools: [
          {
            name: 'set_intent',
            input_schema: {
              type: 'object' as const,
              properties: {
                intentTags:    { type: 'array', items: { type: 'string' } },
                primaryIntent: { type: 'string' },
                intentScore:   { type: 'number' },
              },
              required: ['intentTags', 'primaryIntent', 'intentScore'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'set_intent' },
        messages: [{ role: 'user', content: prompt }],
      });
      const toolUse = msg.content.find((b) => b.type === 'tool_use');
      if (toolUse && toolUse.type === 'tool_use') raw = toolUse.input as typeof raw;
    }

    if (raw) {
      const intentTags = (raw.intentTags ?? []).filter((t) => VALID_LABELS.has(t));
      const primaryIntent = VALID_LABELS.has(raw.primaryIntent)
        ? raw.primaryIntent
        : (intentTags[0] ?? 'discussion');
      return {
        intentTags: intentTags.length > 0 ? intentTags : [primaryIntent],
        primaryIntent,
        intentScore: Number.isFinite(raw.intentScore)
          ? Math.max(0, Math.min(1, raw.intentScore))
          : 0,
      };
    }
  } catch (err) {
    console.warn(`  classify error: ${(err as Error).message?.slice(0, 120)}`);
  }

  return { intentTags: ['discussion'], primaryIntent: 'discussion', intentScore: 0 };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill EngageOpportunity intent classification ===\n');
  console.log(`Mode:        ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`Platform:    ${args.platform ?? 'all'}`);
  console.log(`Scope:       ${args.all ? 'all rows (force reclassify)' : 'broken-fallback rows (intentScore=0 / null, primaryIntent=discussion)'}`);
  console.log(`Batch size:  ${args.batchSize}`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log(`AI backend:  ${_useOpenRouter ? 'OpenRouter' : 'Anthropic'}\n`);

  const prisma = new PrismaClient();

  // Find candidate rows: intentScore = 0 or null means broken-fallback.
  // --all overrides the filter to reclassify every row (forces re-run even on
  // rows that already have a non-zero score, in case labels have changed).
  const rows = await prisma.engageOpportunity.findMany({
    where: {
      deletedAt: null,
      ...(args.platform ? { platform: args.platform } : {}),
      ...(args.all
        ? {}
        : {
            primaryIntent: 'discussion',
            OR: [{ intentScore: 0 }, { intentScore: null }],
          }),
    },
    select: {
      id: true,
      platform: true,
      primaryIntent: true,
      intentScore: true,
      postContent: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${rows.length} row${rows.length === 1 ? '' : 's'} to process.\n`);
  if (!rows.length) {
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let skipped = 0;  // classified ok even under --all (score already non-zero, same result)
  let unchanged = 0;
  let errors = 0;

  // Process in batches, each batch runs `concurrency` classify calls concurrently.
  for (let i = 0; i < rows.length; i += args.batchSize) {
    const batch = rows.slice(i, i + args.batchSize);
    console.log(`Batch ${Math.floor(i / args.batchSize) + 1} / ${Math.ceil(rows.length / args.batchSize)} — ${batch.length} rows`);

    for (let j = 0; j < batch.length; j += args.concurrency) {
      const chunk = batch.slice(j, j + args.concurrency);
      const settled = await Promise.allSettled(
        chunk.map((row) => classifyOne(row.postContent).then((r) => ({ row, result: r })))
      );

      for (const s of settled) {
        if (s.status === 'rejected') {
          errors++;
          console.warn(`  ERROR: ${(s.reason as Error)?.message?.slice(0, 80)}`);
          continue;
        }
        const { row, result } = s.value;

        // Skip when the model still returns 'discussion' with score 0 — the
        // classifier gave up again (network error etc.); no point writing the
        // same broken value back.
        if (result.primaryIntent === 'discussion' && result.intentScore === 0) {
          unchanged++;
          continue;
        }

        // Under --all, skip rows that already match the new result (idempotent).
        if (
          args.all &&
          row.primaryIntent === result.primaryIntent &&
          row.intentScore === result.intentScore
        ) {
          skipped++;
          continue;
        }

        console.log(
          `  [${row.id.slice(0, 8)}] ${row.platform.padEnd(6)} ` +
          `${row.primaryIntent.padEnd(12)} -> ${result.primaryIntent.padEnd(12)} ` +
          `(score: ${(row.intentScore ?? 0).toFixed(2)} -> ${result.intentScore.toFixed(2)}) ` +
          `tags: [${result.intentTags.join(', ')}]`
        );

        if (!args.dryRun) {
          try {
            await prisma.engageOpportunity.update({
              where: { id: row.id },
              data: {
                intentTags:    result.intentTags,
                primaryIntent: result.primaryIntent,
                intentScore:   result.intentScore,
              },
            });
            updated++;
          } catch (err) {
            errors++;
            console.warn(`  UPDATE ERROR [${row.id.slice(0, 8)}]: ${(err as Error).message?.slice(0, 80)}`);
          }
        } else {
          updated++; // count as "would update" in dry-run
        }
      }
    }
  }

  console.log(
    `\n${args.dryRun ? '[DRY RUN] Would update' : 'Updated'}: ${updated}, ` +
    `unchanged (still discussion/0): ${unchanged}, ` +
    `skipped (already correct): ${skipped}, ` +
    `errors: ${errors}`
  );
  if (args.dryRun) {
    console.log('\n--- DRY RUN. Re-run with --execute to write. ---');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
