/**
 * Seed AI model pricing into Settings table.
 * Usage: npx ts-node -r tsconfig-paths/register libraries/nestjs-libraries/src/database/prisma/ai-pricing/run-seed-pricing.ts
 */
import { PrismaClient } from '@prisma/client';
import { AI_PRICING_SEED } from './seed-pricing';

const SETTINGS_KEY = 'ai_model_pricing';

async function main() {
  const prisma = new PrismaClient();

  try {
    await prisma.settings.upsert({
      where: { key: SETTINGS_KEY },
      create: {
        key: SETTINGS_KEY,
        type: 'object',
        required: false,
        description:
          'AI model pricing: price unit depends on billing_mode (per_token: per 1M tokens, per_image: per image)',
        value: AI_PRICING_SEED as any,
        default: AI_PRICING_SEED as any,
      },
      update: {
        value: AI_PRICING_SEED as any,
      },
    });

    const { text, image } = AI_PRICING_SEED;
    const fmt = (e: typeof text) =>
      e.billing_mode === 'per_token'
        ? `$${e.price}/1M tokens`
        : `$${e.price}/image`;

    console.log('Seeded ai_model_pricing:');
    console.log(
      `  text:  ${text.servicer}/${text.provider}/${text.model} [${text.billing_mode}] → ${fmt(text)}`
    );
    console.log(
      `  image: ${image.servicer}/${image.provider}/${image.model} [${image.billing_mode}] → ${fmt(image)}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
