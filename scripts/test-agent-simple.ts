import 'dotenv/config';
import axios from 'axios';
import pkg from 'jsonwebtoken';
const { sign } = pkg;

/**
 * E2E TEST FOR CHAT AGENT — Tool Calling Coverage
 *
 * Covers 4 dimensions:
 *   - Single tool trigger (S01-S04)
 *   - Combined tool trigger (C01-C05)
 *   - Single-turn conversation (R01-R06)
 *   - Multi-turn conversation (M01-M06)
 *
 * Usage:
 *   USER_ID="uuid" ORG_ID="uuid" pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 * Options (env vars):
 *   INTEGRATION   - filter by integration ID or name
 *   SCENARIO      - run specific scenario(s): "S01", "C01", "R01-R06", "M01", or "all" (default)
 *   INTERVAL      - seconds between scenarios (default: 15)
 *   BACKEND_INTERNAL_URL - backend base URL (default: http://localhost:3000)
 *
 * Examples:
 *   # Run all
 *   USER_ID=xxx ORG_ID=yyy INTEGRATION=cmn2mc... pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 *   # Run only single-turn scenarios
 *   SCENARIO=R01-R06 USER_ID=xxx ORG_ID=yyy pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 *   # Run one scenario
 *   SCENARIO=C02 USER_ID=xxx ORG_ID=yyy pnpm dlx ts-node scripts/test-agent-simple.ts
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
  console.error('ERROR: USER_ID and JWT_SECRET are required.');
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
  timeout: 120_000, // agent tool calls can be slow
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      metadata: { requestType: 'Chat' },
      agentSession: { agentName: 'postiz' },
      messages: messages.map((m) => ({
        id: m.id,
        createdAt: new Date().toISOString(),
        textMessage: { role: m.role, content: m.content },
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
// Frontend simulation: append hidden integration context to user messages
// Same as frontend NewInput component in agent.chat.tsx
// ---------------------------------------------------------------------------

function appendIntegrationContext(
  text: string,
  integrations: Record<string, unknown>[],
): string {
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

// ---------------------------------------------------------------------------
// Send one message turn and get agent response
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
    console.error('    GraphQL errors:', JSON.stringify(data.errors, null, 2));
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
// Post verification: query DB via API
// ---------------------------------------------------------------------------

interface PostRecord {
  id: string;
  state: string;
  content: string;
  publishDate: string;
  image: string | null;
  integrationId: string;
  group: string;
  parentPostId: string | null;
  createdAt: string;
}

async function getRecentPosts(limit = 10): Promise<PostRecord[]> {
  try {
    // API requires startDate/endDate as ISO 8601 strings
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ago
    const endDate = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ahead
    const { data } = await client.get('/posts/', {
      params: {
        page: 1,
        pageSize: limit,
        startDate,
        endDate,
      },
    });
    // API returns { posts: [...] } — posts is a direct array
    const results = Array.isArray(data?.posts) ? data.posts : (data?.posts?.results || data?.results || []);
    return Array.isArray(results) ? results : [];
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    console.error('    Failed to fetch posts:', e.response?.status, JSON.stringify(e.response?.data || e.message));
    return [];
  }
}

async function getNewPostsSince(
  beforeIds: Set<string>,
  retries = 3,
  delayMs = 2000,
): Promise<PostRecord[]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const posts = await getRecentPosts(20);
    const newPosts = posts.filter((p) => !beforeIds.has(p.id));
    if (newPosts.length > 0) return newPosts;
    if (attempt < retries) {
      await sleep(delayMs);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

type VerifyFn = (ctx: VerifyContext) => boolean;

interface VerifyContext {
  agentText: string;        // last agent response text
  allAgentTexts: string[];  // all agent responses in conversation
  newPosts: PostRecord[];   // posts created during this scenario
  integrations: Record<string, unknown>[];
}

const verify = {
  // Agent response contains certain keywords
  responseContains:
    (...keywords: string[]): VerifyFn =>
    ({ agentText }) => {
      const lower = agentText.toLowerCase();
      return keywords.some((kw) => lower.includes(kw.toLowerCase()));
    },

  // At least N new posts in DB
  postCreated:
    (minCount = 1): VerifyFn =>
    ({ newPosts }) =>
      newPosts.length >= minCount,

  // New post has expected state (supports multiple valid states)
  postState:
    (...expected: string[]): VerifyFn =>
    ({ newPosts }) =>
      newPosts.some((p) => expected.includes(p.state)),

  // New post content contains string
  postContentContains:
    (substr: string): VerifyFn =>
    ({ newPosts }) =>
      newPosts.some((p) => (p.content || '').includes(substr)),

  // New post content matches regex
  postContentMatches:
    (regex: RegExp): VerifyFn =>
    ({ newPosts }) =>
      newPosts.some((p) => regex.test(p.content || '')),

  // New post has image attachment
  postHasImage: (): VerifyFn => ({ newPosts }) =>
    newPosts.some((p) => {
      if (!p.image) return false;
      try {
        const parsed = JSON.parse(p.image);
        return Array.isArray(parsed) ? parsed.length > 0 : !!parsed;
      } catch {
        return p.image.length > 2; // not empty "[]"
      }
    }),

  // New post publishDate is in the future
  postScheduledFuture: (): VerifyFn => ({ newPosts }) =>
    newPosts.some((p) => new Date(p.publishDate).getTime() > Date.now() + 60_000),

  // Thread: multiple posts in same group
  postThread:
    (minParts = 2): VerifyFn =>
    ({ newPosts }) => {
      const groups = new Map<string, number>();
      for (const p of newPosts) {
        groups.set(p.group, (groups.get(p.group) || 0) + 1);
      }
      return Array.from(groups.values()).some((count) => count >= minParts);
    },

  // Combine multiple verifiers (all must pass)
  all:
    (...fns: VerifyFn[]): VerifyFn =>
    (ctx) =>
      fns.every((fn) => fn(ctx)),
};

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

interface Scenario {
  id: string;
  name: string;
  description: string;
  steps: ((ctx: { agentReplies: string[] }) => string)[];
  verify: VerifyFn;
  // If true, skip DB post verification (info-only scenarios)
  infoOnly?: boolean;
}

// ---------------------------------------------------------------------------
// All scenarios
// ---------------------------------------------------------------------------

function buildScenarios(): Scenario[] {
  return [
    // =========================================================================
    // Dimension 1: Single tool trigger (S01-S04)
    // =========================================================================
    {
      id: 'S01',
      name: 'Query available channels',
      description: 'Trigger integrationList tool',
      infoOnly: true,
      steps: [() => '我有哪些可以发帖的账号？列出来看看。'],
      verify: verify.responseContains('channel', 'account', '账号', '平台', 'integration'),
    },
    {
      id: 'S02',
      name: 'Query platform rules',
      description: 'Trigger integrationSchema tool for X',
      infoOnly: true,
      steps: [() => 'X平台发帖有什么限制？字数上限是多少？能发几张图？'],
      verify: verify.responseContains('200', '4000', 'character', 'image', 'video', '字', '图片'),
    },
    {
      id: 'S03',
      name: 'Generate image only',
      description: 'Trigger generateImageTool without posting',
      infoOnly: true,
      steps: [() => '帮我生成一张科技主题的图片，先不要发帖，我只想看看效果。'],
      verify: verify.responseContains('http', 'image', 'Image', '图片', '生成'),
    },
    {
      id: 'S04',
      name: 'Query video options',
      description: 'Trigger videoFunctionTool',
      infoOnly: true,
      steps: [() => '生成视频有哪些选项？比如可以用什么声音？'],
      verify: verify.responseContains('video', 'voice', '视频', '声音', 'option'),
    },

    // =========================================================================
    // Dimension 2: Combined tool trigger (C01-C05)
    // =========================================================================
    {
      id: 'C01',
      name: 'Schema → write → send',
      description: 'integrationSchema + schedulePostTool',
      steps: [
        () => '帮我写一条符合平台规则的帖子，立即发送。',
        () => '确认，发送。',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },
    {
      id: 'C02',
      name: 'Generate image → send',
      description: 'generateImageTool + integrationSchema + schedulePostTool',
      steps: [
        () => '帮我生成一张图，配一段关于AI创新的文字，立即发送。',
        () => '确认，带图发送。',
      ],
      verify: verify.all(
        verify.postCreated(),
        verify.postState('QUEUE', 'PUBLISHED'),
        verify.postHasImage(),
      ),
    },
    {
      id: 'C03',
      name: 'Schema → image → send',
      description: 'integrationSchema + generateImageTool + schedulePostTool',
      steps: [
        () => '按照平台规则，发一条带图的帖子，内容关于可持续发展。',
        () => '好的，发送。',
      ],
      verify: verify.all(
        verify.postCreated(),
        verify.postState('QUEUE', 'PUBLISHED'),
        verify.postHasImage(),
      ),
    },
    {
      id: 'C04',
      name: 'Video options → generate → send',
      description: 'videoFunctionTool + generateVideoTool + schedulePostTool',
      steps: [
        () => '帮我生成一个关于产品介绍的短视频并发送。',
        () => '确认，发送。',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },
    {
      id: 'C05',
      name: 'List channels → schema → send',
      description: 'integrationList + integrationSchema + schedulePostTool',
      steps: [
        () => '看看我有哪些账号，然后帮我选一个写条帖子发出去。',
        () => '就用这个账号，发送。',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },

    // =========================================================================
    // Dimension 3: Single-turn conversation (R01-R06)
    // =========================================================================
    {
      id: 'R01',
      name: 'EN text - send now',
      description: 'English text post, immediate',
      steps: [
        () => 'Write a short tech tip post and send it now. Text only.',
        () => 'Yes, send it now.',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },
    {
      id: 'R02',
      name: 'CN text - send now',
      description: 'Chinese text post, immediate',
      steps: [
        () => '写一条关于AI编程效率提升的帖子，立即发送。纯文本。',
        () => '确认发送。',
      ],
      verify: verify.all(
        verify.postCreated(),
        verify.postState('QUEUE', 'PUBLISHED'),
        verify.postContentMatches(/[\u4e00-\u9fff]/), // contains Chinese chars
      ),
    },
    {
      id: 'R03',
      name: 'Schedule future',
      description: 'Schedule post for next Monday',
      steps: [
        () => 'Write a motivational post. Schedule it for next Monday 9am UTC. Text only.',
        () => 'Confirmed, schedule it.',
      ],
      verify: verify.all(
        verify.postCreated(),
        verify.postState('QUEUE', 'PUBLISHED'),
        verify.postScheduledFuture(),
      ),
    },
    {
      id: 'R04',
      name: 'Save as draft',
      description: 'Create draft, do not send',
      steps: [
        () => '写一条JavaScript最佳实践的帖子，保存为草稿，不要发送。',
        () => '对，只保存草稿。',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('DRAFT')),
    },
    {
      id: 'R05',
      name: 'EN prompt → CN content',
      description: 'English instruction, Chinese output',
      steps: [
        () => 'Write a post in Chinese about cloud-native trends in 2026. Send it now. Text only.',
        () => '确认发送。',
      ],
      verify: verify.all(
        verify.postCreated(),
        verify.postState('QUEUE', 'PUBLISHED'),
        verify.postContentMatches(/[\u4e00-\u9fff]/),
      ),
    },
    {
      id: 'R06',
      name: 'Post with link',
      description: 'Share a URL with intro text',
      steps: [
        () => '分享这个链接 https://example.com/best-practices-2026 ，写段介绍，发送。不要短链接。',
        () => '发送。',
      ],
      verify: verify.all(
        verify.postCreated(),
        verify.postState('QUEUE', 'PUBLISHED'),
        verify.postContentContains('example.com'),
      ),
    },

    // =========================================================================
    // Dimension 4: Multi-turn conversation (M01-M06)
    // =========================================================================
    {
      id: 'M01',
      name: 'Draft → revise → send',
      description: '3-turn: draft, shorten, confirm send',
      steps: [
        () => '帮我写一条关于远程办公效率的帖子。先草拟，不要发。',
        () => '太长了，缩短到200字以内，结尾加个行动号召。',
        () => '可以了，直接发送。',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },
    {
      id: 'M02',
      name: 'Draft → change tone → send',
      description: '3-turn Chinese: draft, adjust tone, confirm',
      steps: [
        () => '帮我写一条关于开源社区协作的帖子。先看看草稿。',
        () => '语气太正式了，改轻松口语化一些，加个emoji。',
        () => '可以了，发送。',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },
    {
      id: 'M03',
      name: 'Vague → clarify → send',
      description: '3-turn: vague request, clarify, send',
      steps: [
        () => 'I want to post something about our new product launch.',
        () => "It's a SaaS collaboration tool. Keep it short and professional.",
        () => 'OK send it now.',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },
    {
      id: 'M04',
      name: 'Write → add image → send',
      description: '3-turn: text first, then add generated image',
      steps: [
        () => '写一条关于AI在医疗领域应用的帖子。先不要发。',
        () => '帮我配一张相关的图片。',
        () => '带图发送。',
      ],
      verify: verify.all(
        verify.postCreated(),
        verify.postState('QUEUE', 'PUBLISHED'),
        verify.postHasImage(),
      ),
    },
    {
      id: 'M05',
      name: 'Thread → send',
      description: '2-turn: create 3-part thread, confirm',
      steps: [
        () => 'I want to write a 3-part thread about why startups should invest in developer experience. Create the thread.',
        () => 'Looks good, send the thread now.',
      ],
      verify: verify.all(verify.postCreated(2), verify.postThread(2)),
    },
    {
      id: 'M06',
      name: 'Analytics → write → send',
      description: '3-turn: check analytics, write similar post, send',
      steps: [
        () => '最近帖子表现怎么样？',
        () => '根据表现好的风格，帮我写一条新帖子。纯文本。',
        () => '发送。',
      ],
      verify: verify.all(verify.postCreated(), verify.postState('QUEUE', 'PUBLISHED')),
    },
  ];
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: Scenario,
  integrations: Record<string, unknown>[],
): Promise<{ passed: boolean; reason: string }> {
  console.log(`\n--- [${scenario.id}] ${scenario.name}`);
  console.log(`    ${scenario.description}`);

  const threadId = `e2e-${Date.now()}-${scenario.id}`;
  const conversationHistory: { id: string; role: string; content: string }[] = [];
  const agentReplies: string[] = [];

  // Snapshot existing post IDs before this scenario
  const postsBefore = await getRecentPosts(20);
  const beforeIds = new Set(postsBefore.map((p) => p.id));

  try {
    // Execute conversation steps
    for (let step = 0; step < scenario.steps.length; step++) {
      const rawMessage = scenario.steps[step]({ agentReplies });
      const messageWithContext = appendIntegrationContext(rawMessage, integrations);
      const msgId = String(conversationHistory.length + 1);
      conversationHistory.push({ id: msgId, role: 'user', content: messageWithContext });

      const display = rawMessage.slice(0, 100) + (rawMessage.length > 100 ? '...' : '');
      console.log(`    [${step + 1}/${scenario.steps.length}] User: ${display}`);

      const result = await sendMessage(threadId, conversationHistory, integrations);
      if (!result) {
        return { passed: false, reason: `No response at step ${step + 1}` };
      }

      const { agentText, status } = result;
      agentReplies.push(agentText);
      const assistantId = String(conversationHistory.length + 1);
      conversationHistory.push({ id: assistantId, role: 'assistant', content: agentText });

      const agentDisplay = agentText.slice(0, 150) + (agentText.length > 150 ? '...' : '');
      console.log(`    Agent: ${agentDisplay}`);

      if (status === 'failed') {
        return { passed: false, reason: `GraphQL status=failed at step ${step + 1}` };
      }
    }

    // Verify results
    let newPosts: PostRecord[] = [];
    if (!scenario.infoOnly) {
      newPosts = await getNewPostsSince(beforeIds);
    }

    const verifyCtx: VerifyContext = {
      agentText: agentReplies[agentReplies.length - 1] || '',
      allAgentTexts: agentReplies,
      newPosts,
      integrations,
    };

    const passed = scenario.verify(verifyCtx);

    if (!passed) {
      const dbInfo = scenario.infoOnly
        ? '(info-only, no DB check)'
        : `newPosts=${newPosts.length}, states=[${newPosts.map((p) => p.state).join(',')}]`;
      return { passed: false, reason: `Verification failed. ${dbInfo}` };
    }

    return { passed: true, reason: '' };
  } catch (err: unknown) {
    const e = err as { response?: { data?: unknown }; message?: string };
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 200)
      : e.message;
    return { passed: false, reason: `Exception: ${detail}` };
  }
}

// ---------------------------------------------------------------------------
// Scenario filter
// ---------------------------------------------------------------------------

function filterScenarios(all: Scenario[], filter: string): Scenario[] {
  if (filter === 'all') return all;

  // Range: "R01-R06"
  const rangeMatch = filter.match(/^([A-Z]\d{2})-([A-Z]\d{2})$/);
  if (rangeMatch) {
    const [, start, end] = rangeMatch;
    const inRange = all.filter((s) => s.id >= start && s.id <= end);
    if (inRange.length === 0) {
      console.error(`No scenarios in range ${start}-${end}`);
      process.exit(1);
    }
    return inRange;
  }

  // Prefix: "S", "C", "R", "M"
  if (/^[SCRM]$/.test(filter)) {
    return all.filter((s) => s.id.startsWith(filter));
  }

  // Exact: "C02"
  const exact = all.filter((s) => s.id === filter.toUpperCase());
  if (exact.length === 0) {
    console.error(`Scenario "${filter}" not found. Available:`);
    all.forEach((s) => console.log(`  ${s.id} - ${s.name}`));
    process.exit(1);
  }
  return exact;
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
    const scenariosToRun = filterScenarios(allScenarios, SCENARIO_STR);

    console.log(`\nRunning ${scenariosToRun.length} scenario(s):`);
    scenariosToRun.forEach((s) => console.log(`  ${s.id} - ${s.name}`));

    const results: { id: string; name: string; passed: boolean; reason: string }[] = [];

    for (let i = 0; i < scenariosToRun.length; i++) {
      const scenario = scenariosToRun[i];
      console.log(`\n========== ${scenario.id} (${i + 1}/${scenariosToRun.length}) ==========`);

      const result = await runScenario(scenario, integrations);
      results.push({ id: scenario.id, name: scenario.name, ...result });

      console.log(result.passed ? '    ✓ PASS' : `    ✗ FAIL: ${result.reason}`);

      if (i < scenariosToRun.length - 1) {
        console.log(`\n    Waiting ${INTERVAL}s...`);
        await sleep(INTERVAL * 1000);
      }
    }

    // Summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`RESULTS: ${passed} passed, ${failed} failed, ${results.length} total`);
    console.log('='.repeat(60));

    for (const r of results) {
      const icon = r.passed ? '✓' : '✗';
      const detail = r.passed ? '' : ` — ${r.reason}`;
      console.log(`  ${icon} ${r.id} ${r.name}${detail}`);
    }

    if (failed > 0) process.exit(1);
  } catch (err: unknown) {
    const e = err as { response?: { data?: unknown }; message?: string };
    console.error('Initialization failed:', e.response?.data || e.message);
    process.exit(1);
  }
}

main();
