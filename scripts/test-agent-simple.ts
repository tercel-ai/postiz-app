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
 *   ROUNDS        - number of test rounds (default: 1)
 *   INTERVAL      - seconds between rounds (default: 10)
 *   BACKEND_INTERNAL_URL - backend base URL (default: http://localhost:3000)
 *
 * Examples:
 *   # Single round
 *   USER_ID=xxx ORG_ID=yyy INTEGRATION=cmn2mc... pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 *   # 5 rounds, 30s apart
 *   USER_ID=xxx ORG_ID=yyy ROUNDS=5 INTERVAL=30 pnpm dlx ts-node scripts/test-agent-simple.ts
 */

const {
  USER_ID,
  ORG_ID,
  JWT_SECRET,
  BACKEND_INTERNAL_URL = 'http://localhost:3000',
  INTEGRATION,
  ROUNDS: ROUNDS_STR = '1',
  INTERVAL: INTERVAL_STR = '10',
} = process.env;

const ROUNDS = Math.max(1, parseInt(ROUNDS_STR, 10) || 1);
const INTERVAL = Math.max(0, parseInt(INTERVAL_STR, 10) || 10);

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
      ... on ResponseMessageOutput {
        id
        role
        content {
          ... on TextMessageOutput { value }
        }
      }
    }
    status {
      ... on SuccessResponseStatus { code }
      ... on FailedResponseStatus { code reason details }
      ... on PendingResponseStatus { code }
    }
  }
}`;

function buildVariables(
  threadId: string,
  messages: { id: string; role: string; content: string }[],
  integrations: any[],
) {
  return {
    data: {
      threadId,
      runId: `run-${Date.now()}`,
      metadata: {
        requestType: 'Chat',
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        textMessage: { content: m.content },
      })),
      frontend: {
        actions: [],
        url: 'http://localhost:4200',
      },
    },
    properties: {
      integrations: integrations.map((i: any) => ({
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
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario(scenarioName: string, prompt: string, integrations: any[]) {
  console.log(`\n--- [${scenarioName}]`);

  const threadId = `e2e-${Date.now()}`;

  const messages = [{ id: '1', role: 'user', content: prompt }];
  const body = {
    query: GENERATE_MUTATION,
    variables: buildVariables(threadId, messages, integrations),
  };

  try {
    console.log(`User: ${prompt}`);
    const { data } = await client.post('/copilot/agent', body);

    if (data.errors) {
      console.error('GraphQL errors:', JSON.stringify(data.errors, null, 2));
      return false;
    }

    const resp = data.data?.generateCopilotResponse;
    const agentMessages = resp?.messages || [];
    const lastMsg = agentMessages[agentMessages.length - 1];
    const agentText =
      lastMsg?.content?.map((c: any) => c.value).join('') || '(no text)';
    console.log('Agent:', agentText);

    // Auto-confirm
    console.log('System: Auto-confirming...');
    const confirmMessages = [
      ...messages,
      { id: '2', role: 'assistant', content: agentText },
      {
        id: '3',
        role: 'user',
        content: 'Yes, please schedule it right away. This is for testing.',
      },
    ];
    const confirmBody = {
      query: GENERATE_MUTATION,
      variables: buildVariables(threadId, confirmMessages, integrations),
    };

    const { data: finalData } = await client.post('/copilot/agent', confirmBody);
    if (finalData.errors) {
      console.error('Confirm errors:', JSON.stringify(finalData.errors, null, 2));
      return false;
    }

    const finalResp = finalData.data?.generateCopilotResponse;
    const status = finalResp?.status?.code || 'unknown';
    console.log(`Status: ${status}`);
    return status !== 'failed';
  } catch (err: any) {
    console.error('Error:', err.response?.data || err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    console.log(`Connecting to ${BACKEND_INTERNAL_URL}...`);
    console.log(`Config: ROUNDS=${ROUNDS} INTERVAL=${INTERVAL}s`);

    // GET /integrations/list returns { integrations: [...] }
    const { data } = await client.get('/integrations/list');
    const allIntegrations: any[] = data.integrations || data || [];
    console.log(`Auth successful. Found ${allIntegrations.length} integrations.`);

    if (allIntegrations.length === 0) {
      console.error('No integrations found.');
      process.exit(1);
    }

    // Filter
    let integrations = allIntegrations;
    if (INTEGRATION) {
      integrations = allIntegrations.filter(
        (i: any) => i.id === INTEGRATION || i.name === INTEGRATION,
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
      `Using: ${integrations.map((i: any) => `${i.name} (${i.identifier})`).join(', ')}`,
    );

    let passed = 0;
    let failed = 0;

    for (let round = 1; round <= ROUNDS; round++) {
      console.log(`\n========== Round ${round}/${ROUNDS} ==========`);

      const ok = await runScenario(
        `Round ${round} - Text Post`,
        `Create a short professional tech tip post. Schedule it for now. (test round ${round})`,
        integrations,
      );
      if (ok) passed++;
      else failed++;

      if (round < ROUNDS) {
        console.log(`\nWaiting ${INTERVAL}s before next round...`);
        await sleep(INTERVAL);
      }
    }

    console.log(`\n========== Summary ==========`);
    console.log(`Total: ${ROUNDS} | Passed: ${passed} | Failed: ${failed}`);
  } catch (err: any) {
    console.error('Initialization failed:', err.response?.data || err.message);
  }
}

main();
