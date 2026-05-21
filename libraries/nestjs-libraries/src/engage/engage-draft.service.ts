import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { EngageOpportunity } from '@prisma/client';

const STRATEGY_PROMPTS: Record<string, string> = {
  EXPERT_ANSWER:
    'Give expert step-by-step advice. Share actionable frameworks. Be specific and concrete.',
  DATA_BACKED:
    'Lead with data from scanning 500+ brands. Cite specific numbers and findings.',
  EMPATHY_LED:
    'Acknowledge the frustration or situation first, then pivot to a concrete insight.',
};

const BRAND_PROMPTS: Record<number, string> = {
  0: 'Do not mention AISEE or any brand name. Provide pure value.',
  1: 'Share insights and data naturally. Build authority without naming any brand.',
  2: 'When highly relevant, naturally mention AISEE as an example or tool.',
  3: 'Proactively introduce AISEE and invite the person to try it.',
};

const INTENT_PROMPTS: Record<string, string> = {
  help_seeking: 'The person is asking for help. Give them a direct, usable answer.',
  rant: 'The person is frustrated. Acknowledge that first, then offer a concrete insight.',
  discussion:
    'This is an open discussion. Engage with an interesting question or perspective.',
  opinion: 'The person shared an opinion. Extend or add nuance to their point.',
  comparison:
    'The person is comparing options. Provide neutral, balanced analysis.',
  data_share:
    'The person shared data. Expand with related data or implications.',
};

@Injectable()
export class EngageDraftService {
  private readonly anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY,
  });

  async *generateDraft(
    opportunity: EngageOpportunity,
    strategy: string,
    brandStrength: number
  ): AsyncGenerator<string> {
    const systemPrompt = this._buildSystemPrompt(
      opportunity.platform,
      strategy,
      opportunity.primaryIntent,
      brandStrength
    );
    const userPrompt = this._buildUserPrompt(opportunity);

    const stream = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      stream: true,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text;
      }
    }
  }

  private _buildSystemPrompt(
    platform: string,
    strategy: string,
    primaryIntent: string,
    brandStrength: number
  ): string {
    const charLimit =
      platform === 'x' ? 'under 280 characters' : 'up to 500 words';
    const strategyInstruction =
      STRATEGY_PROMPTS[strategy] ?? STRATEGY_PROMPTS['EXPERT_ANSWER'];
    const brandInstruction = BRAND_PROMPTS[brandStrength] ?? BRAND_PROMPTS[1];
    const intentInstruction =
      INTENT_PROMPTS[primaryIntent] ?? INTENT_PROMPTS['discussion'];

    return `You are a social media engagement expert writing a reply on ${platform}.
${strategyInstruction}
${brandInstruction}
${intentInstruction}
Platform constraint: Keep the reply ${charLimit}.
Be direct, natural, and valuable. Do not start with "Great post!" or similar openers.`;
  }

  private _buildUserPrompt(opportunity: EngageOpportunity): string {
    return `Original post by @${opportunity.authorUsername}:
---
${opportunity.postContent}
---
Write a reply to this post.`;
  }
}
