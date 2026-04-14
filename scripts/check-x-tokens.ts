/**
 * Quick diagnostic: check token format for X integrations.
 * Usage: npx ts-node scripts/check-x-tokens.ts
 */
import { PrismaClient } from '@prisma/client';

/** Mirrors XProvider.isOAuth1Token — keep in sync. */
function isOAuth1Token(token: string): boolean {
  const colonIdx = token.indexOf(':');
  return colonIdx > 0 && token.length > colonIdx + 1;
}

async function main() {
  const prisma = new PrismaClient();
  const integrations = await prisma.integration.findMany({
    where: { providerIdentifier: 'x', deletedAt: null, disabled: false },
    select: { id: true, name: true, token: true, refreshNeeded: true, tokenExpiration: true },
    orderBy: { createdAt: 'asc' },
  });
  await prisma.$disconnect();

  let oauth1Count = 0;
  let oauth2Count = 0;
  let emptyCount = 0;

  console.log(`Found ${integrations.length} X integrations:\n`);
  for (const i of integrations) {
    const tokenPreview = i.token ? i.token.slice(0, 20) + '...' : '(empty)';
    let format: string;
    if (!i.token) {
      format = 'EMPTY (needs re-auth)';
      emptyCount++;
    } else if (isOAuth1Token(i.token)) {
      format = 'OAuth 1.0a (accessToken:accessSecret)';
      oauth1Count++;
    } else {
      format = `OAuth 2.0 bearer (len=${i.token.length})`;
      oauth2Count++;
    }

    console.log(`  [${i.id}] ${i.name}`);
    console.log(`    token: ${tokenPreview} | format: ${format}`);
    console.log(`    refreshNeeded: ${i.refreshNeeded} | expiration: ${i.tokenExpiration?.toISOString() || 'null'}`);
    console.log('');
  }

  console.log(`Summary: OAuth 1.0a=${oauth1Count}, OAuth 2.0=${oauth2Count}, empty=${emptyCount}`);
}

main().catch(console.error);
