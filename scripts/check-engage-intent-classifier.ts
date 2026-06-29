/**
 * Diagnostic script for the EngageIntentClassifierService.
 * Checks three things in order:
 *   1. Local NLI model (@xenova/transformers) — loads + classifies test posts
 *   2. Anthropic API (claude-haiku) — tool-call round-trip
 *   3. OpenRouter API — chat completion round-trip (if OPENROUTER_API_KEY set)
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/check-engage-intent-classifier.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.TZ = 'UTC';

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { INTENT_LABELS } from '@gitroom/nestjs-libraries/engage/engage-intent.constants';

// ─── Test posts (one per expected label) ──────────────────────────────────────

const TEST_POSTS: Array<{ text: string; expected: string }> = [
  {
    text: 'How do I migrate my Postgres database to a new server? Anyone done this before?',
    expected: 'help_seeking',
  },
  {
    text: "I'm so tired of dealing with this broken CI pipeline. It fails every single time for no reason!",
    expected: 'rant',
  },
  {
    text: 'What do you all think about the future of TypeScript? Share your thoughts.',
    expected: 'discussion',
  },
  {
    text: 'Hot take: monorepos are overrated and most teams would be better off without them.',
    expected: 'opinion',
  },
  {
    text: 'Bun vs Node.js — which is actually faster for production workloads?',
    expected: 'comparison',
  },
  {
    text: 'Our team shipped 47% faster after switching to trunk-based development. Here are the numbers.',
    expected: 'data_share',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(msg: string)   { console.log(`  ✓  ${msg}`); }
function fail(msg: string) { console.log(`  ✗  ${msg}`); }
function info(msg: string) { console.log(`     ${msg}`); }

function printResult(
  text: string,
  expected: string,
  primary: string,
  score: number,
  tags: string[]
) {
  const correct = primary === expected;
  const marker = correct ? '✓' : '~';
  console.log(
    `  [${marker}] expected=${expected.padEnd(12)} got=${primary.padEnd(12)} ` +
    `score=${score.toFixed(3)}  tags=[${tags.join(', ')}]`
  );
  info(`    "${text.slice(0, 70)}${text.length > 70 ? '…' : ''}"`);
}

// ─── 1. Local NLI model ───────────────────────────────────────────────────────

async function checkLocalModel(): Promise<boolean> {
  console.log('\n── 1. Local NLI model (@xenova/transformers) ──────────────────────────\n');
  try {
    const { pipeline } = await import('@xenova/transformers');
    info('Package loaded, downloading/initialising model (first run may take ~30s)…');

    type ZeroShotPipeline = (
      text: string, labels: string[], opts?: { multi_label?: boolean }
    ) => Promise<{ labels: string[]; scores: number[] }>;

    const classifier = await pipeline(
      'zero-shot-classification',
      'Xenova/nli-deberta-v3-small',
      { quantized: true }
    ) as unknown as ZeroShotPipeline;

    ok('Model loaded: Xenova/nli-deberta-v3-small');
    console.log();

    let correct = 0;
    for (const { text, expected } of TEST_POSTS) {
      const result = await classifier(text.slice(0, 512), [...INTENT_LABELS], { multi_label: true });
      const primary = result.labels[0] as string;
      const score   = result.scores[0] as number;
      const tags    = (result.labels as string[]).filter((_, i) => (result.scores as number[])[i] > 0.4);
      printResult(text, expected, primary, score, tags.length > 0 ? tags : [primary]);
      if (primary === expected) correct++;
    }

    console.log(`\n  Accuracy: ${correct}/${TEST_POSTS.length} labels matched expected.`);
    console.log('  (Mismatches are not errors — zero-shot is probabilistic.)');
    return true;
  } catch (err) {
    fail(`Local model unavailable: ${(err as Error).message}`);
    info('All classifications will fall back to the Claude/OpenRouter API.');
    return false;
  }
}

// ─── 2. Anthropic API ─────────────────────────────────────────────────────────

async function checkAnthropic(): Promise<boolean> {
  console.log('\n── 2. Anthropic API (claude-haiku) ────────────────────────────────────\n');

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
  if (!apiKey) {
    fail('ANTHROPIC_API_KEY and CLAUDE_API_KEY are both unset or empty — skipping.');
    return false;
  }
  info(`Key source: ${process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'CLAUDE_API_KEY'}`);

  const client = new Anthropic({ apiKey });
  const sample = TEST_POSTS[0];

  try {
    const msg = await client.messages.create({
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
      messages: [
        {
          role: 'user',
          content: `Classify this post's intent. Labels: ${INTENT_LABELS.join(', ')}.\n\n"${sample.text.slice(0, 400)}"`,
        },
      ],
    });

    const toolUse = msg.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      fail('No tool_use block in response.');
      return false;
    }

    const raw = toolUse.input as { intentTags: string[]; primaryIntent: string; intentScore: number };
    ok(`API reachable. primaryIntent=${raw.primaryIntent}  intentScore=${raw.intentScore}`);
    printResult(sample.text, sample.expected, raw.primaryIntent, raw.intentScore ?? 0, raw.intentTags ?? []);
    return true;
  } catch (err) {
    fail(`API call failed: ${(err as Error).message?.slice(0, 120)}`);
    return false;
  }
}

// ─── 3. OpenRouter API ────────────────────────────────────────────────────────

async function checkOpenRouter(): Promise<boolean> {
  console.log('\n── 3. OpenRouter API ──────────────────────────────────────────────────\n');

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) {
    info('OPENROUTER_API_KEY not set — skipped.');
    return false;
  }

  const model = process.env.OPENROUTER_INTENT_MODEL ?? 'anthropic/claude-haiku-4.5';
  info(`Model: ${model}`);

  const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });
  const sample = TEST_POSTS[2];

  try {
    const resp = await client.chat.completions.create(
      {
        model,
        max_tokens: 128,
        messages: [
          {
            role: 'system',
            content: `You are an intent classifier. Respond with JSON only: {"intentTags":["<label>",...],"primaryIntent":"<label>","intentScore":<0-1>}. Valid labels: ${INTENT_LABELS.join(', ')}.`,
          },
          {
            role: 'user',
            content: `Classify this post's intent. Labels: ${INTENT_LABELS.join(', ')}.\n\n"${sample.text.slice(0, 400)}"`,
          },
        ],
      },
      { headers: { 'HTTP-Referer': 'https://postiz.com', 'X-Title': 'Postiz Engage Check' } }
    );

    const content = resp.choices[0]?.message?.content ?? '';
    let raw: { intentTags: string[]; primaryIntent: string; intentScore: number } | null = null;
    const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try { raw = JSON.parse(stripped); } catch { /* fall through */ }

    if (!raw) {
      fail(`Non-JSON response: ${content.slice(0, 100)}`);
      return false;
    }

    ok(`API reachable. primaryIntent=${raw.primaryIntent}  intentScore=${raw.intentScore}`);
    printResult(sample.text, sample.expected, raw.primaryIntent, raw.intentScore ?? 0, raw.intentTags ?? []);
    return true;
  } catch (err) {
    fail(`API call failed: ${(err as Error).message?.slice(0, 120)}`);
    return false;
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== EngageIntentClassifier diagnostics ===');

  const localOk     = await checkLocalModel();
  const anthropicOk = await checkAnthropic();
  const openrouterOk = await checkOpenRouter();

  console.log('\n── Summary ────────────────────────────────────────────────────────────\n');
  console.log(`  Local NLI model : ${localOk      ? '✓ working' : '✗ unavailable'}`);
  console.log(`  Anthropic API   : ${anthropicOk  ? '✓ working' : '✗ unavailable / not configured'}`);
  console.log(`  OpenRouter API  : ${openrouterOk ? '✓ working' : '✗ unavailable / not configured'}`);

  const anyCloudOk = anthropicOk || openrouterOk;
  console.log();

  if (localOk && anyCloudOk) {
    console.log('  Status: OPTIMAL — local model classifies; cloud handles low-confidence posts.');
  } else if (localOk) {
    console.log('  Status: LOCAL ONLY — all posts classified by local model.');
    console.log('  Low-confidence posts (<0.45) will fall back to "discussion" (no cloud API).');
    console.log('  → Configure ANTHROPIC_API_KEY or OPENROUTER_API_KEY for full coverage.');
  } else if (anyCloudOk) {
    console.log('  Status: CLOUD ONLY — local model unavailable, all posts go to cloud API.');
    console.log('  → Install @xenova/transformers or wait for model download to avoid extra API cost.');
  } else {
    console.log('  Status: ✗ BROKEN — neither local nor cloud classifier is working.');
    console.log('  All posts will default to primaryIntent="discussion" with intentScore=0.');
    console.log('  → Check model download and/or set ANTHROPIC_API_KEY / OPENROUTER_API_KEY.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
