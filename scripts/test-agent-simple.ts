import 'dotenv/config';
import axios from 'axios';
import { sign } from 'jsonwebtoken';

/**
 * SIMPLIFIED E2E TEST FOR CHAT AGENT
 * 
 * Usage:
 * USER_ID="your-user-uuid" ORG_ID="your-org-uuid" pnpm dlx ts-node scripts/test-agent-simple.ts
 * 
 * It will automatically:
 * 1. Sign a JWT for the USER_ID using JWT_SECRET from .env
 * 2. Use BACKEND_INTERNAL_URL from .env
 * 3. Fetch integrations and run X.com test scenarios
 */

const {
  USER_ID,
  ORG_ID,
  JWT_SECRET,
  BACKEND_INTERNAL_URL = 'http://localhost:3000'
} = process.env;

if (!USER_ID || !JWT_SECRET) {
  console.error('❌ ERROR: USER_ID and JWT_SECRET are required.');
  console.log('You can find USER_ID in your database (User table) and JWT_SECRET in your .env file.');
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
    const { data: integrations } = await client.get('/integrations');
    console.log(`✅ Auth successful. Found ${integrations.length} integrations.`);

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