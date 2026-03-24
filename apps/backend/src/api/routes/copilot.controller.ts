import {
  Logger,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Query,
  Param,
} from '@nestjs/common';
import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNodeHttpEndpoint,
  copilotRuntimeNestEndpoint,
} from '@copilotkit/runtime';
import OpenAI from 'openai';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { Organization, User } from '@prisma/client';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { MastraAgent } from '@ag-ui/mastra';
import { MastraService } from '@gitroom/nestjs-libraries/chat/mastra.service';
import { Request, Response } from 'express';
import { RuntimeContext } from '@mastra/core/di';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { AuthorizationActions, Sections } from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import { AiseeBusinessType, AiseeBusinessSubType, AiseeClient } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { AiPricingService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/ai-pricing.service';
import { runWithContext, getCollectedUsages } from '@gitroom/nestjs-libraries/chat/async.storage';
import { randomUUID } from 'crypto';
import { logAiUsage } from '@gitroom/nestjs-libraries/openai/openai.service';

function hasValidOpenAiKey(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return !!key && key !== 'sk-proj-' && key.length > 0;
}

function isOpenRouterProvider(): boolean {
  return (process.env.IMAGE_PROVIDER || 'openai').toLowerCase() === 'openrouter';
}

function createServiceAdapter(): OpenAIAdapter {
  if (isOpenRouterProvider() && !hasValidOpenAiKey()) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_API_KEY is required when IMAGE_PROVIDER=openrouter without OPENAI_API_KEY'
      );
    }
    const openrouterClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    return new OpenAIAdapter({
      openai: openrouterClient as any,
      model: process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-4.1',
    });
  }
  return new OpenAIAdapter({ model: 'gpt-4.1' });
}

function hasAnyApiKey(): boolean {
  return hasValidOpenAiKey() || (isOpenRouterProvider() && !!process.env.OPENROUTER_API_KEY);
}

export type ChannelsContext = {
  integrations: string;
  organization: string;
  userId: string;
  ui: string;
};

@Controller('/copilot')
export class CopilotController {
  private readonly logger = new Logger(CopilotController.name);

  constructor(
    private _subscriptionService: SubscriptionService,
    private _mastraService: MastraService,
    private _creditService: AiseeCreditService,
    private _aiPricingService: AiPricingService
  ) {}
  @Post('/chat')
  chatAgent(@Req() req: Request, @Res() res: Response) {
    if (!hasAnyApiKey()) {
      Logger.warn('No AI API key set (OPENAI_API_KEY or OPENROUTER_API_KEY), chat functionality will not work');
      return;
    }

    const copilotRuntimeHandler = copilotRuntimeNodeHttpEndpoint({
      endpoint: '/copilot/chat',
      runtime: new CopilotRuntime(),
      serviceAdapter: createServiceAdapter(),
    });

    return copilotRuntimeHandler(req, res);
  }

  @Post('/agent')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async agent(
    @Req() req: Request,
    @Res() res: Response,
    @GetOrgFromRequest() organization: Organization,
    @GetUserFromRequest() user: User
  ) {
    if (!hasAnyApiKey()) {
      Logger.warn('No AI API key set (OPENAI_API_KEY or OPENROUTER_API_KEY), chat functionality will not work');
      return;
    }

    const insufficientError = await this.checkMinChatCredits(organization.id);
    if (insufficientError) {
      res.status(402).json(insufficientError);
      return;
    }

    const mastra = await this._mastraService.mastra();
    const runtimeContext = new RuntimeContext<ChannelsContext>();
    runtimeContext.set(
      'integrations',
      req?.body?.variables?.properties?.integrations || []
    );

    runtimeContext.set('organization', JSON.stringify(organization));
    runtimeContext.set('userId', user.id);
    runtimeContext.set('ui', 'true');

    const agents = MastraAgent.getLocalAgents({
      resourceId: organization.id,
      mastra,
      // @ts-ignore
      runtimeContext,
    });

    const runtime = new CopilotRuntime({
      agents,
    });

    const handler = copilotRuntimeNestEndpoint({
      endpoint: '/copilot/agent',
      runtime,
      serviceAdapter: createServiceAdapter(),
    });

    // Extract threadId from CopilotKit GraphQL variables
    const threadId = req?.body?.variables?.threadId
      || req?.body?.threadId
      || undefined;

    // Run handler within AsyncLocalStorage context for usage collection
    return runWithContext(
      { requestId: randomUUID(), auth: organization, usages: [] },
      () => {
        // Capture threadId from closure — ALS context may not survive the 'close' event
        res.on('close', () => {
          this.billAfterResponse(organization, threadId);
        });
        return handler(req, res);
      }
    );
  }

  /**
   * Estimate minimum credits needed for one chat round (~500 tokens)
   * and check if the user has enough balance.
   * Returns error object if insufficient, null if OK.
   */
  private async checkMinChatCredits(
    organizationId: string
  ): Promise<{ error: string; required: number; balance: number } | null> {
    const balance = await this._creditService.getBalance(organizationId);
    if (!balance) {
      return null; // Aisee disabled, allow
    }

    // Hard block: balance <= 0
    if (balance.total <= 0) {
      return {
        error: 'Insufficient credits. Please top up to continue.',
        required: 0,
        balance: balance.total,
      };
    }

    const config = await this._aiPricingService.getPricingConfig();
    const textEntry = config?.text;
    if (!textEntry) {
      return null; // No pricing config, allow
    }

    // Estimate: ~200 input tokens + ~300 output tokens for a minimal chat round
    const MIN_INPUT_TOKENS = 200;
    const MIN_OUTPUT_TOKENS = 300;
    let minCost: number;

    if (textEntry.input_price && textEntry.output_price) {
      minCost =
        MIN_INPUT_TOKENS * parseFloat(textEntry.input_price) +
        MIN_OUTPUT_TOKENS * parseFloat(textEntry.output_price);
    } else {
      minCost =
        (MIN_INPUT_TOKENS + MIN_OUTPUT_TOKENS) * parseFloat(textEntry.price);
    }

    if (balance.total < minCost) {
      return {
        error: 'Insufficient credits for chat',
        required: minCost,
        balance: balance.total,
      };
    }

    return null;
  }

  private billAfterResponse(organization: Organization, threadId?: string): void {
    const usages = getCollectedUsages();
    if (usages.length === 0) {
      return;
    }

    for (const usage of usages) {
      logAiUsage(usage);
    }

    const taskId = AiseeClient.buildTaskId(`agent_chat_${organization.id}_${Date.now()}`);

    this._creditService
      .billCollectedUsages(
        {
          userId: organization.id,
          taskId,
          businessType: AiseeBusinessType.AI_COPYWRITING,
          subType: AiseeBusinessSubType.CHAT,
          relatedId: threadId,
          description: 'Agent chat conversation',
          data: { ...(threadId && { threadId }), messageCount: usages.length, source: 'chat' },
        },
        usages
      )
      .catch((err) => {
        this.logger.error('Failed to bill agent chat usage:', err);
      });
  }

  @Get('/credits')
  calculateCredits(
    @GetOrgFromRequest() organization: Organization,
    @Query('type') type: 'ai_images' | 'ai_videos'
  ) {
    return this._subscriptionService.checkCredits(
      organization,
      type || 'ai_images'
    );
  }

  @Get('/:thread/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getMessagesList(
    @GetOrgFromRequest() organization: Organization,
    @Param('thread') threadId: string
  ): Promise<any> {
    const mastra = await this._mastraService.mastra();
    const memory = await mastra.getAgent('postiz').getMemory();
    try {
      return await memory.query({
        resourceId: organization.id,
        threadId,
      });
    } catch (err) {
      return { messages: [] };
    }
  }

  @Get('/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getList(@GetOrgFromRequest() organization: Organization) {
    const mastra = await this._mastraService.mastra();
    // @ts-ignore
    const memory = await mastra.getAgent('postiz').getMemory();
    const list = await memory.getThreadsByResourceIdPaginated({
      resourceId: organization.id,
      perPage: 100000,
      page: 0,
      orderBy: 'createdAt',
      sortDirection: 'DESC',
    });

    return {
      threads: list.threads.map((p) => ({
        id: p.id,
        title: p.title,
      })),
    };
  }
}
