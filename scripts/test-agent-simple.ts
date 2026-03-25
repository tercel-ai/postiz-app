import 'dotenv/config';
import axios from 'axios';
import pkg from 'jsonwebtoken';
const { sign } = pkg;

/**
 * E2E TEST FOR CHAT AGENT (CopilotKit GraphQL protocol)
 *
 * Usage:
 *   USER_ID="uuid" ORG_ID="uuid" pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 * Options (env vars):
 *   INTEGRATION   - filter by integration ID or name
 *   SCENARIO      - run a specific scenario by number (e.g. SCENARIO=1), or "all" (default)
 *   INTERVAL      - seconds between scenarios (default: 15)
 *   BACKEND_INTERNAL_URL - backend base URL (default: http://localhost:3000)
 *
 * Examples:
 *   # Run all scenarios
 *   USER_ID=xxx ORG_ID=yyy INTEGRATION=cmn2mc... pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 *   # Run only scenario 3
 *   USER_ID=xxx ORG_ID=yyy SCENARIO=3 INTEGRATION=cmn2mc... pnpm dlx ts-node scripts/test-agent-simple.ts
 */

const {
  USER_ID,
  ORG_ID,
  JWT_SECRET,
  BACKEND_INTERNAL_URL = 'http://localhost:3000',
  INTEGRATION,
  SCENARIO: SCENARIO_STR = 'all',
  INTERVAL: INTERVAL_STR = '15',
} = process.env;

const INTERVAL = Math.max(0, parseInt(INTERVAL_STR, 10) || 15);

if (!USER_ID || !JWT_SECRET) {
  console.error('ERROR: USER_ID is required. JWT_SECRET must be set in .env.');
  process.exit(1);
}

const token = sign({ id: USER_ID, activated: true }, JWT_SECRET);

const client = axios.create({
  baseURL: BACKEND_INTERNAL_URL,
  headers: {
    Authorization: `Bearer ${token}`,
    showorg: ORG_ID || '',
    'Content-Type': 'application/json',
  },
});

function sleep(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// ---------------------------------------------------------------------------
// CopilotKit GraphQL mutation
// ---------------------------------------------------------------------------

const GENERATE_MUTATION = `
mutation generateCopilotResponse($data: GenerateCopilotResponseInput!, $properties: JSONObject) {
  generateCopilotResponse(data: $data, properties: $properties) {
    threadId
    runId
    messages {
      ... on TextMessageOutput {
        id
        role
        content
      }
    }
    status {
      ... on SuccessResponseStatus { code }
      ... on FailedResponseStatus { code reason }
      ... on PendingResponseStatus { code }
    }
  }
}`;

function buildVariables(
  threadId: string,
  messages: { id: string; role: string; content: string }[],
  integrations: Record<string, unknown>[],
) {
  return {
    data: {
      threadId,
      runId: `run-${Date.now()}`,
      metadata: {
        requestType: 'Chat',
      },
      agentSession: {
        agentName: 'postiz',
      },
      messages: messages.map((m) => ({
        id: m.id,
        createdAt: new Date().toISOString(),
        textMessage: {
          role: m.role,
          content: m.content,
        },
      })),
      frontend: {
        actions: [] as Record<string, unknown>[],
        url: 'http://localhost:4200',
      },
    },
    properties: {
      integrations: integrations.map((i: Record<string, unknown>) => ({
        id: i.id,
        name: i.name,
        providerIdentifier: i.identifier || i.providerIdentifier,
        picture: i.picture,
        profile: i.display || i.profile,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Send one message and get agent response
// ---------------------------------------------------------------------------

async function sendMessage(
  threadId: string,
  messages: { id: string; role: string; content: string }[],
  integrations: Record<string, unknown>[],
): Promise<{ agentText: string; status: string } | null> {
  const { data } = await client.post('/copilot/agent', {
    query: GENERATE_MUTATION,
    variables: buildVariables(threadId, messages, integrations),
  });

  if (data.errors) {
    console.error('GraphQL errors:', JSON.stringify(data.errors, null, 2));
    return null;
  }

  const resp = data.data?.generateCopilotResponse;
  const textMessages = (resp?.messages || []).filter(
    (m: Record<string, unknown>) => m.role === 'assistant' && m.content,
  );
  const lastMsg = textMessages[textMessages.length - 1];
  const agentText = Array.isArray(lastMsg?.content)
    ? lastMsg.content.join('')
    : String(lastMsg?.content || '(no text)');
  const status = resp?.status?.code || 'unknown';
  return { agentText, status };
}

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  description: string;
  // Each step is a user message. Steps run sequentially, each seeing prior conversation.
  steps: ((ctx: ScenarioContext) => string)[];
}

interface ScenarioContext {
  channelInfo: string; // e.g. "aipartnerup-team (platform: x, id: cmn2mc...)"
  channelName: string;
  channelPlatform: string;
  channelId: string;
  agentReplies: string[]; // agent replies from prior steps
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

function buildScenarios(): Scenario[] {
  return [
    // 1. Simple one-shot: English text post, schedule now
    {
      name: 'EN text post - schedule now',
      description: 'Single-turn: English text post, immediate schedule',
      steps: [
        (ctx) =>
          `Create a short professional tech tip post and schedule it right away to: ${ctx.channelInfo}. Text only, no images, UTC timezone. Do not ask me any questions, just schedule it now.`,
        (ctx) =>
          `Yes, confirmed. Schedule it right away, no modal needed. This is an automated test.`,
      ],
    },

    // 2. Chinese text post, schedule now
    {
      name: 'CN text post - schedule now',
      description: 'Single-turn: Chinese text post, immediate schedule',
      steps: [
        (ctx) =>
          `用中文写一条关于AI编程效率提升的短帖子，立即发送到: ${ctx.channelInfo}。纯文本，不需要图片，UTC时区。不要问我任何问题，直接发送。`,
        (ctx) =>
          `确认，立即发送，不需要弹窗预览。这是自动化测试。`,
      ],
    },

    // 3. Multi-turn: user asks agent to draft, then revises, then confirms
    {
      name: 'Multi-turn: draft → revise → send',
      description: '3-turn conversation: draft, revise content, then confirm send',
      steps: [
        (ctx) =>
          `Help me write a post about remote work productivity tips for: ${ctx.channelInfo}. Just draft it first, don't schedule yet.`,
        (ctx) =>
          `Make it shorter, under 200 characters. Also add a call to action at the end.`,
        (ctx) =>
          `Looks good. Schedule it right away, no modal needed. UTC timezone. This is an automated test.`,
      ],
    },

    // 4. Multi-turn Chinese: ask, modify tone, send
    {
      name: 'Multi-turn CN: draft → modify tone → send',
      description: '3-turn Chinese: draft, adjust tone, confirm send',
      steps: [
        (ctx) =>
          `帮我写一条关于开源社区协作的帖子，发送到: ${ctx.channelInfo}。先草拟，不要立即发送。`,
        (ctx) =>
          `语气改轻松一些，更口语化，加个emoji。`,
        (ctx) =>
          `可以了，立即发送，不需要弹窗。UTC时区。这是自动化测试。`,
      ],
    },

    // 5. Post with image generation
    {
      name: 'Text + generated image',
      description: 'Generate an image and schedule post with it',
      steps: [
        (ctx) =>
          `Create a post about the future of AI in healthcare for: ${ctx.channelInfo}. Generate a relevant image to go with it. Schedule it right away, UTC timezone. Do not ask me any questions.`,
        (ctx) =>
          `Yes, confirmed. Schedule it right away with the image, no modal needed. This is an automated test.`,
      ],
    },

    // 6. Schedule for future time
    {
      name: 'Schedule for future time',
      description: 'Schedule a post for a specific future time',
      steps: [
        (ctx) =>
          `Write a motivational Monday post for: ${ctx.channelInfo}. Schedule it for next Monday at 9:00 AM UTC. Text only, no images. Do not ask me any questions.`,
        (ctx) =>
          `Confirmed, schedule it for that time, no modal needed. This is an automated test.`,
      ],
    },

    // 7. Draft mode (don't send)
    {
      name: 'Save as draft',
      description: 'Create a post and save as draft, not send',
      steps: [
        (ctx) =>
          `Write a post about JavaScript best practices for: ${ctx.channelInfo}. Save it as a draft, do NOT schedule or send it. Text only, UTC timezone.`,
        (ctx) =>
          `Yes, save as draft. Do not schedule. No modal needed. This is an automated test.`,
      ],
    },

    // 8. Long-form thread (X thread with multiple parts)
    {
      name: 'X thread (multi-part)',
      description: 'Create a thread with multiple tweets',
      steps: [
        (ctx) =>
          `Create a 3-part thread about "why startups should invest in developer experience" for: ${ctx.channelInfo}. Schedule it now, UTC timezone. Do not ask me any questions, just schedule it.`,
        (ctx) =>
          `Yes, confirmed. Schedule the thread right away, no modal needed. This is an automated test.`,
      ],
    },

    // 9. Multi-turn: vague request → agent asks → user clarifies → send
    {
      name: 'Multi-turn: vague → clarify → send',
      description: 'Start vague, let agent ask questions, then provide details',
      steps: [
        (ctx) =>
          `I want to post something about our new product launch.`,
        (ctx) =>
          `It's a SaaS tool for team collaboration. Post it to ${ctx.channelInfo}. Keep it professional and concise.`,
        (ctx) =>
          `Schedule it right away, no modal needed. UTC timezone. This is an automated test.`,
      ],
    },

    // 10. Mixed language: English prompt, ask for Chinese output
    {
      name: 'EN prompt → CN content',
      description: 'User prompts in English but wants Chinese post content',
      steps: [
        (ctx) =>
          `Write a post in Chinese about cloud-native architecture trends in 2026 for: ${ctx.channelInfo}. Schedule it now, text only, UTC timezone. Do not ask any questions.`,
        (ctx) =>
          `确认发送。不需要弹窗。这是自动化测试。`,
      ],
    },

    // 11. Post with link
    {
      name: 'Post with link',
      description: 'Text post containing a URL, no short link',
      steps: [
        (ctx) =>
          `Create a post sharing this article: https://example.com/best-practices-2026 — write a brief intro about it for: ${ctx.channelInfo}. Schedule now, UTC timezone, no short link, no images. Do not ask questions.`,
        (ctx) =>
          `Confirmed. Schedule right away, no modal. This is an automated test.`,
      ],
    },

    // 12. Multi-turn: ask for analytics then schedule
    {
      name: 'Multi-turn: check analytics → write post → send',
      description: 'User asks about analytics first, then creates a post based on insights',
      steps: [
        (ctx) =>
          `Show me analytics for my social media channels.`,
        (ctx) =>
          `Based on what's working well, write a new post in a similar style for: ${ctx.channelInfo}. Text only.`,
        (ctx) =>
          `Schedule it right away, no modal needed. UTC timezone. This is an automated test.`,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Scenario runner (multi-turn)
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: Scenario,
  integrations: Record<string, unknown>[],
): Promise<boolean> {
  console.log(`\n--- [${scenario.name}]`);
  console.log(`    ${scenario.description}`);

  const threadId = `e2e-${Date.now()}`;
  const conversationHistory: { id: string; role: string; content: string }[] = [];

  const firstIntegration = integrations[0] || {};
  const ctx: ScenarioContext = {
    channelInfo: integrations
      .map((i) => `${i.name} (platform: ${i.identifier}, id: ${i.id})`)
      .join(', '),
    channelName: String(firstIntegration.name || ''),
    channelPlatform: String(firstIntegration.identifier || ''),
    channelId: String(firstIntegration.id || ''),
    agentReplies: [],
  };

  try {
    for (let step = 0; step < scenario.steps.length; step++) {
      const userMessage = scenario.steps[step](ctx);
      const msgId = String(conversationHistory.length + 1);
      conversationHistory.push({ id: msgId, role: 'user', content: userMessage });

      console.log(`  [Step ${step + 1}/${scenario.steps.length}] User: ${userMessage.slice(0, 120)}${userMessage.length > 120 ? '...' : ''}`);

      const result = await sendMessage(threadId, conversationHistory, integrations);
      if (!result) {
        console.error(`  FAIL: No response at step ${step + 1}`);
        return false;
      }

      const { agentText, status } = result;
      ctx.agentReplies.push(agentText);
      const assistantMsgId = String(conversationHistory.length + 1);
      conversationHistory.push({ id: assistantMsgId, role: 'assistant', content: agentText });

      console.log(`  Agent: ${agentText.slice(0, 200)}${agentText.length > 200 ? '...' : ''}`);

      if (status === 'failed') {
        console.error(`  FAIL: Status=${status} at step ${step + 1}`);
        return false;
      }
    }

    console.log(`  PASS`);
    return true;
  } catch (err: unknown) {
    const e = err as { response?: { data?: unknown }; message?: string };
    console.error('  Error:', e.response?.data || e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    console.log(`Connecting to ${BACKEND_INTERNAL_URL}...`);

    const { data } = await client.get('/integrations/list');
    const allIntegrations: Record<string, unknown>[] =
      data.integrations || data || [];
    console.log(`Auth successful. Found ${allIntegrations.length} integrations.`);

    if (allIntegrations.length === 0) {
      console.error('No integrations found.');
      process.exit(1);
    }

    let integrations = allIntegrations;
    if (INTEGRATION) {
      integrations = allIntegrations.filter(
        (i) => i.id === INTEGRATION || i.name === INTEGRATION,
      );
      if (integrations.length === 0) {
        console.error(`No integration matching "${INTEGRATION}". Available:`);
        for (const i of allIntegrations) {
          console.log(`  - ${i.name} (${i.identifier}) id=${i.id}`);
        }
        process.exit(1);
      }
    }
    console.log(
      `Using: ${integrations.map((i) => `${i.name} (${i.identifier})`).join(', ')}`,
    );

    const allScenarios = buildScenarios();
    let scenariosToRun: Scenario[];

    if (SCENARIO_STR === 'all') {
      scenariosToRun = allScenarios;
    } else {
      const idx = parseInt(SCENARIO_STR, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= allScenarios.length) {
        console.error(`Invalid SCENARIO=${SCENARIO_STR}. Valid: 1-${allScenarios.length} or "all"`);
        console.log('Available scenarios:');
        allScenarios.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}`));
        process.exit(1);
      }
      scenariosToRun = [allScenarios[idx]];
    }

    console.log(`\nRunning ${scenariosToRun.length} scenario(s)...\n`);

    let passed = 0;
    let failed = 0;

    for (let i = 0; i < scenariosToRun.length; i++) {
      const scenario = scenariosToRun[i];
      console.log(`\n========== Scenario ${i + 1}/${scenariosToRun.length} ==========`);

      const ok = await runScenario(scenario, integrations);
      if (ok) passed++;
      else failed++;

      if (i < scenariosToRun.length - 1) {
        console.log(`\nWaiting ${INTERVAL}s before next scenario...`);
        await sleep(INTERVAL);
      }
    }

    console.log(`\n========== Summary ==========`);
    console.log(`Total: ${scenariosToRun.length} | Passed: ${passed} | Failed: ${failed}`);
    if (failed > 0) process.exit(1);
  } catch (err: unknown) {
    const e = err as { response?: { data?: unknown }; message?: string };
    console.error('Initialization failed:', e.response?.data || e.message);
    process.exit(1);
  }
}

main();
