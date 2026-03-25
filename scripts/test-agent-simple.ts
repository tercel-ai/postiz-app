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

// Append hidden integration context to user message, same as frontend NewInput component
function appendIntegrationContext(text: string, integrations: Record<string, unknown>[]): string {
  if (integrations.length === 0) return text;
  const payload = integrations.map((i) => ({
    id: i.id,
    platform: i.identifier || i.providerIdentifier,
    profilePicture: i.picture,
    additionalSettings: i.additionalSettings,
  }));
  return `${text}
[--integrations--]
Use the following social media platforms: ${JSON.stringify(payload)}
[--integrations--]`;
}

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
  agentReplies: string[]; // agent replies from prior steps
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

function buildScenarios(): Scenario[] {
  return [
    // 1. Simple English text post, send now
    {
      name: 'EN text post - send now',
      description: 'Single-turn: English text, immediate send',
      steps: [
        (_ctx) =>
          `Write a short tech tip post and send it now. Text only, no images.`,
        (_ctx) =>
          `Yes, send it now.`,
      ],
    },

    // 2. Chinese text post, send now
    {
      name: 'CN text post - send now',
      description: 'Single-turn: Chinese text, immediate send',
      steps: [
        (_ctx) =>
          `用中文写一条关于AI编程效率提升的短帖子，立即发送。纯文本就行。`,
        (_ctx) =>
          `确认，立即发送。`,
      ],
    },

    // 3. Multi-turn: draft → revise → send
    {
      name: 'Multi-turn: draft → revise → send',
      description: '3-turn: draft, revise content, then confirm',
      steps: [
        (_ctx) =>
          `帮我写一条关于远程办公效率的帖子。先帮我草拟看看，不要直接发。`,
        (_ctx) =>
          `太长了，缩短到200字以内，结尾加个行动号召。`,
        (_ctx) =>
          `可以了，直接发送吧。`,
      ],
    },

    // 4. Multi-turn Chinese: modify tone
    {
      name: 'Multi-turn CN: draft → modify tone → send',
      description: '3-turn Chinese: draft, adjust tone, confirm',
      steps: [
        (_ctx) =>
          `帮我写一条关于开源社区协作的帖子。先看看草稿。`,
        (_ctx) =>
          `语气太正式了，改轻松口语化一些，加个emoji。`,
        (_ctx) =>
          `可以了，发送。`,
      ],
    },

    // 5. Post with image generation
    {
      name: 'Text + generated image',
      description: 'Generate an image and post together',
      steps: [
        (_ctx) =>
          `写一条关于AI在医疗领域应用的帖子，帮我配一张图。`,
        (_ctx) =>
          `确认，带图发送。`,
      ],
    },

    // 6. Schedule for future time
    {
      name: 'Schedule for future time',
      description: 'Schedule a post for next Monday',
      steps: [
        (_ctx) =>
          `Write a motivational post. Schedule it for next Monday 9am UTC. Text only.`,
        (_ctx) =>
          `Confirmed, schedule it.`,
      ],
    },

    // 7. Draft mode (save, don't send)
    {
      name: 'Save as draft',
      description: 'Create a post and save as draft only',
      steps: [
        (_ctx) =>
          `帮我写一条JavaScript最佳实践的帖子，保存为草稿就行，不要发送。`,
        (_ctx) =>
          `对，只保存草稿，别发。`,
      ],
    },

    // 8. Thread (multi-part)
    {
      name: 'Thread (multi-part)',
      description: 'Create a thread with 3 posts',
      steps: [
        (_ctx) =>
          `I want to write a 3-part thread about why startups should invest in developer experience. Post it now.`,
        (_ctx) =>
          `Looks good, send the thread now.`,
      ],
    },

    // 9. Vague request → agent asks → user clarifies
    {
      name: 'Multi-turn: vague → clarify → send',
      description: 'Start vague, let agent ask, then clarify and send',
      steps: [
        (_ctx) =>
          `I want to post something about our new product launch.`,
        (_ctx) =>
          `It's a SaaS collaboration tool. Keep it short and professional.`,
        (_ctx) =>
          `OK send it now.`,
      ],
    },

    // 10. English prompt, Chinese content
    {
      name: 'EN prompt → CN content',
      description: 'User prompts in English, wants Chinese output',
      steps: [
        (_ctx) =>
          `Write a post in Chinese about cloud-native trends in 2026. Send it now. Text only.`,
        (_ctx) =>
          `确认发送。`,
      ],
    },

    // 11. Post with a link
    {
      name: 'Post with link',
      description: 'Share an article URL with brief intro',
      steps: [
        (_ctx) =>
          `帮我分享这篇文章 https://example.com/best-practices-2026 ，写个简短的介绍。不要短链接。`,
        (_ctx) =>
          `发送。`,
      ],
    },

    // 12. Check analytics → write post
    {
      name: 'Multi-turn: analytics → write → send',
      description: 'Ask analytics, then create post based on insights',
      steps: [
        (_ctx) =>
          `Show me how my posts have been performing recently.`,
        (_ctx) =>
          `Based on that, help me write a new post in a similar style. Text only.`,
        (_ctx) =>
          `Send it now.`,
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

  const ctx: ScenarioContext = {
    agentReplies: [],
  };

  try {
    for (let step = 0; step < scenario.steps.length; step++) {
      const userMessage = scenario.steps[step](ctx);
      // Append hidden integration context to every user message, same as frontend
      const messageWithContext = appendIntegrationContext(userMessage, integrations);
      const msgId = String(conversationHistory.length + 1);
      conversationHistory.push({ id: msgId, role: 'user', content: messageWithContext });

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
