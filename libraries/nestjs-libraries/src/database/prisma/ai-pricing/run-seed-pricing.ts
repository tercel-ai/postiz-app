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
    const existing = await prisma.settings.findUnique({
      where: { key: SETTINGS_KEY },
    });

    if (existing) {
      console.log('ai_model_pricing already exists, skipping seed (use Admin API to modify).');
    } else {
      await prisma.settings.create({
        data: {
          key: SETTINGS_KEY,
          type: 'object',
          required: false,
          description:
            'AI model pricing in credits ($1=100 credits). per_token: credits per 1 token, per_image: credits per 1 image.',
          value: AI_PRICING_SEED as any,
          default: AI_PRICING_SEED as any,
        },
      });

      const { text, image } = AI_PRICING_SEED;
      const fmt = (e: typeof text) => {
        const parts = [`price=${e.price}`];
        if (e.input_price) parts.push(`input=${e.input_price}`);
        if (e.output_price) parts.push(`output=${e.output_price}`);
        return `${e.billing_mode === 'per_token' ? 'credits/token' : 'credits/image'} (${parts.join(', ')})`;
      };

      console.log('Seeded ai_model_pricing:');
      console.log(
        `  text:  ${text.servicer}/${text.provider}/${text.model} [${text.billing_mode}] → ${fmt(text)}`
      );
      console.log(
        `  image: ${image.servicer}/${image.provider}/${image.model} [${image.billing_mode}] → ${fmt(image)}`
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
