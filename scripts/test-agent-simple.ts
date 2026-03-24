import 'dotenv/config';
import axios from 'axios';
import pkg from 'jsonwebtoken';
const { sign } = pkg;

/**
 * SIMPLIFIED E2E TEST FOR CHAT AGENT
 *
 * Usage:
 * USER_ID="uuid" ORG_ID="uuid" pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 * Optional: filter to a specific integration by ID or name
 * USER_ID="uuid" ORG_ID="uuid" INTEGRATION="my-x-account" pnpm dlx ts-node scripts/test-agent-simple.ts
 *
 * JWT_SECRET and BACKEND_INTERNAL_URL are loaded from .env automatically.
 */

const {
  USER_ID,
  ORG_ID,
  JWT_SECRET,
  BACKEND_INTERNAL_URL = 'http://localhost:3000',
  INTEGRATION,
} = process.env;

if (!USER_ID || !JWT_SECRET) {
  console.error('ERROR: USER_ID is required. JWT_SECRET must be set in .env.');
  process.exit(1);
}

// Generate a valid JWT for the user
const token = sign({ id: USER_ID, activated: true }, JWT_SECRET);

const client = axios.create({
  baseURL: BACKEND_INTERNAL_URL,
  headers: {
    'Authorization': `Bearer ${token}`,
    'showorg': ORG_ID || '', // Optional: specify which org to use if user has many
    'Content-Type': 'application/json'
  }
});

async function runScenario(scenarioName: string, prompt: string, integrations: any[]) {
  console.log(`\n🚀 [${scenarioName}]`);
  
  const threadId = `e2e-simple-${Date.now()}`;
  const xIntegration = integrations.find(i => i.providerIdentifier === 'x');
  
  if (!xIntegration) {
    console.warn('⚠️ No X integration found, the agent might not be able to schedule.');
  }

  const payload = {
    threadId,
    messages: [{ id: '1', role: 'user', content: prompt }],
    variables: {
      properties: {
        integrations: integrations.map(i => ({
          id: i.id,
          name: i.name,
          providerIdentifier: i.providerIdentifier,
          picture: i.picture,
          profile: i.profile
        }))
      }
    }
  };

  try {
    console.log(`User: ${prompt}`);
    const { data } = await client.post('/copilot/agent', payload);
    
    // Get the response content
    const assistantMessage = data.messages ? data.messages[data.messages.length - 1]?.content : 'Check preview';
    console.log('Agent:', assistantMessage);

    // Auto-confirm
    console.log('System: Auto-confirming...');
    const confirmPayload = {
      ...payload,
      messages: [
        ...payload.messages,
        { id: '2', role: 'assistant', content: assistantMessage },
        { id: '3', role: 'user', content: 'Yes, please schedule it right away. This is for testing.' }
      ]
    };

    const { data: finalData } = await client.post('/copilot/agent', confirmPayload);
    console.log('Final Result:', JSON.stringify(finalData, null, 2));

  } catch (err: any) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
}

async function main() {
  try {
    console.log(`🔗 Connecting to ${BACKEND_INTERNAL_URL}...`);
    
    // Verify auth and get integrations
    const { data: allIntegrations } = await client.get('/integrations');
    console.log(`Auth successful. Found ${allIntegrations.length} integrations.`);

    // Filter integrations if INTEGRATION env var is set (match by id or name)
    let integrations = allIntegrations;
    if (INTEGRATION) {
      integrations = allIntegrations.filter(
        (i: any) => i.id === INTEGRATION || i.name === INTEGRATION
      );
      if (integrations.length === 0) {
        console.error(`No integration matching "${INTEGRATION}". Available:`);
        for (const i of allIntegrations) {
          console.log(`  - ${i.name} (${i.providerIdentifier}) id=${i.id}`);
        }
        process.exit(1);
      }
      console.log(`Filtered to: ${integrations.map((i: any) => `${i.name} (${i.providerIdentifier})`).join(', ')}`);
    }

    // Test Scenarios
    await runScenario(
      'Text Only',
      'Create a professional tech tip for X.com about React performance. Schedule it for now.',
      integrations
    );

    await runScenario(
      'Image + Text',
      'Create a marketing post for X.com about Postiz AI. Generate a futuristic image. Schedule for tomorrow 10am.',
      integrations
    );

    console.log('\n✨ All tests completed.');
  } catch (err: any) {
    console.error('❌ Initialization failed:', err.response?.data || err.message);
  }
}

main();