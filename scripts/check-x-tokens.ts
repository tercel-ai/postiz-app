/**
 * Quick diagnostic: check token format for X integrations.
 * Usage: npx ts-node scripts/check-x-tokens.ts
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const integrations = await prisma.integration.findMany({
    where: { providerIdentifier: 'x', deletedAt: null, disabled: false },
    select: { id: true, name: true, token: true, refreshNeeded: true, tokenExpiration: true },
    orderBy: { createdAt: 'asc' },
  });
  await prisma.$disconnect();

  console.log(`Found ${integrations.length} X integrations:\n`);
  for (const i of integrations) {
    const parts = i.token.split(':');
    const hasColon = parts.length >= 2;
    const part1Len = parts[0]?.length || 0;
    const part2Len = parts[1]?.length || 0;
    const tokenPreview = i.token.slice(0, 20) + '...';
    const format = hasColon && part1Len > 10 && part2Len > 10
      ? 'OK (OAuth1.0a accessToken:accessSecret)'
      : hasColon
        ? `SUSPECT (parts: ${part1Len}:${part2Len})`
        : `BAD (no colon, len=${i.token.length})`;

    console.log(`  [${i.id}] ${i.name}`);
    console.log(`    token: ${tokenPreview} | format: ${format}`);
    console.log(`    refreshNeeded: ${i.refreshNeeded} | expiration: ${i.tokenExpiration?.toISOString() || 'null'}`);
    console.log('');
  }
}

main().catch(console.error);
