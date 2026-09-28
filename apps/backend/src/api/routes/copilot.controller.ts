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
  EmptyAdapter,
  copilotRuntimeNodeHttpEndpoint,
  copilotRuntimeNestEndpoint,
} from '@copilotkit/runtime';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { GetTimezone } from '@gitroom/nestjs-libraries/user/timezone.from.request';
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
import { withCopilotChatUsageTracking } from '@gitroom/nestjs-libraries/chat/billing.middleware';
import { randomUUID } from 'crypto';
import { logAiUsage } from '@gitroom/nestjs-libraries/openai/openai.service';
import { createCopilotOpenRouterClient } from '@gitroom/nestjs-libraries/chat/copilot-openai-client';

/**
 * Credits an accruing /copilot/chat window may reach before it is charged
 * immediately instead of waiting for the next window.
 *
 * It bounds two things at once: how much spend sits uncharged if a user goes
 * quiet mid-hour, and how stale a heavy user's ledger gets. At current text
 * pricing (~0.0015 credits per output token) 5 credits is on the order of a few
 * thousand tokens — a busy editing session, not a keystroke.
 */
const COPILOT_CHAT_ACCRUAL_THRESHOLD_CREDITS = 5;

/**
 * Whether the site-wide CopilotKit runtime at POST /copilot/chat is served.
 *
 * Default OFF. The endpoint backs postiz-frontend's own editor assistant and
 * autosuggestion boxes; `../aisee-app`, the frontend actually deployed against
 * this backend, only uses /copilot/agent. Leaving it on would expose a billable
 * LLM path with no consumer, so it has to be turned on deliberately by whoever
 * is serving the postiz frontend.
 */
function isCopilotChatEnabled(): boolean {
  return (
    (process.env.COPILOT_CHAT_ENABLED ?? 'false').toLowerCase().trim() === 'true'
  );
}

function hasValidOpenAiKey(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return !!key && key !== 'sk-proj-' && key.length > 0;
}

function isOpenRouterProvider(): boolean {
  return (process.env.IMAGE_PROVIDER || 'openai').toLowerCase() === 'openrouter';
}

// OpenAIAdapter drives its client through `beta.chat.completions.stream()`,
// which exists only in openai v4 — v6 (this repo's root dependency) removed it.
// The adapter's own default client is fine, because @copilotkit/runtime pulls in
// a nested openai v4; the hazard is passing it a client of ours. So the
// OpenRouter branch below — which MUST inject a client, since
// OpenAIAdapterParams has no baseURL knob — builds it from that same nested v4
// via createCopilotOpenRouterClient(). See copilot-openai-client.ts.
function createServiceAdapter(): OpenAIAdapter {
  if (isOpenRouterProvider() && !hasValidOpenAiKey()) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_API_KEY is required when IMAGE_PROVIDER=openrouter without OPENAI_API_KEY'
      );
    }
    const model = process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-4.1';
    return new OpenAIAdapter({
      // Cast: the param is typed against the root openai v6 types, but the
      // adapter wants v4 — which is what this client is.
      openai: withCopilotChatUsageTracking(
        createCopilotOpenRouterClient(process.env.OPENROUTER_API_KEY),
        { provider: 'openrouter', model }
      ) as any,
      model,
    });
  }
  // NOTE: no usage tracking on this branch. The adapter builds its own client
  // inside its constructor, so there is nothing for us to wrap and
  // /copilot/chat goes unbilled here. Closing that gap means replacing
  // OpenAIAdapter with a custom CopilotServiceAdapter; it is not a concern while
  // IMAGE_PROVIDER=openrouter, which is the branch above.
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
  timezone: string;
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
  /**
   * Site-wide CopilotKit runtime: the post-editor assistant (CopilotPopup) and
   * every CopilotTextarea autosuggestion box. Billed the same way as /agent
   * below — `runWithContext` opens a usage-collection scope, the adapter's
   * wrapped client pushes each completion's tokens into it, and the response
   * 'close' settles it.
   */
  @Post('/chat')
  chatAgent(
    @Req() req: Request,
    @Res() res: Response,
    @GetOrgFromRequest() organization: Organization
  ) {
    // Off by default — see isCopilotChatEnabled(). 404 rather than 403: when the
    // runtime is not being served, the honest answer is that this route does not
    // exist here.
    if (!isCopilotChatEnabled()) {
      res.status(404).json({
        error: 'Copilot chat runtime is not enabled on this deployment',
      });
      return;
    }

    if (!hasAnyApiKey()) {
      // Answer the request. Returning without touching `res` under @Res() sends
      // nothing at all, leaving the connection open until it times out.
      Logger.warn('No AI API key set (OPENAI_API_KEY or OPENROUTER_API_KEY), chat functionality will not work');
      res.status(503).json({ error: 'AI is not configured on this deployment' });
      return;
    }

    const copilotRuntimeHandler = copilotRuntimeNodeHttpEndpoint({
      endpoint: '/copilot/chat',
      runtime: new CopilotRuntime(),
      serviceAdapter: createServiceAdapter(),
    });

    // Which UI produced the request. CopilotKit sends one of Chat, Suggestion,
    // Task, TextareaCompletion, TextareaPopover — so an autosuggestion keystroke
    // is distinguishable in the ledger from someone typing in the assistant, even
    // though both arrive here. Recorded, not acted on: the two are charged alike,
    // and this is the axis that would let that change.
    const requestType: string | undefined =
      req?.body?.variables?.data?.metadata?.requestType;

    return runWithContext(
      { requestId: randomUUID(), auth: organization, usages: [] },
      () => {
        res.on('close', () => {
          this.billAfterResponse(organization, undefined, 'copilot_chat', {
            requestType,
          });
        });
        return copilotRuntimeHandler(req, res);
      }
    );
  }

  @Post('/agent')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async agent(
    @Req() req: Request,
    @Res() res: Response,
    @GetOrgFromRequest() organization: Organization,
    @GetUserFromRequest() user: User,
    @GetTimezone() timezone: string | undefined
  ) {
    if (!hasAnyApiKey()) {
      // Same as /chat: a bare return under @Res() answers nothing and holds the
      // connection until it times out.
      Logger.warn('No AI API key set (OPENAI_API_KEY or OPENROUTER_API_KEY), chat functionality will not work');
      res.status(503).json({ error: 'AI is not configured on this deployment' });
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
    runtimeContext.set('timezone', timezone || 'UTC');

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
      // EmptyAdapter: the Mastra agent makes the LLM calls itself via
      // @ai-sdk/openai → OpenRouter, and its usage is captured by
      // withBillingTracking on the model. No service adapter is involved in
      // inference here, so there is nothing for OpenAIAdapter to do.
      serviceAdapter: new EmptyAdapter(),
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

  /**
   * Settle the usages collected during one request.
   *
   * `surface` separates the two endpoints in the ledger. Both bill as
   * ai_copywriting/chat, but only `data.surface` says whether the spend came from
   * the Agent page or from the editor assistant / autosuggestion boxes — a
   * distinction that matters because the latter fire without the user ever
   * opening a chat. `extra.requestType` narrows that further, to which CopilotKit
   * UI made the call.
   */
  private billAfterResponse(
    organization: Organization,
    threadId?: string,
    surface: 'agent_chat' | 'copilot_chat' = 'agent_chat',
    extra?: { requestType?: string }
  ): void {
    // Called from a response 'close' listener, where a synchronous throw is an
    // uncaught exception rather than a failed request. AuthMiddleware guarantees
    // req.org on every path that reaches a controller, so this is belt-and-braces
    // against a future change there — but the cost of being wrong is the process.
    if (!organization?.id) {
      this.logger.warn(`[${surface}] no organization on request — nothing billed`);
      return;
    }

    const usages = getCollectedUsages();
    if (usages.length === 0) {
      // Not necessarily an error — an aborted request or a turn the runtime
      // answered without calling the model both land here. Worth a line anyway:
      // on /copilot/chat it is also what a silently missing `usage` in the
      // upstream stream looks like, and that WOULD be lost revenue.
      this.logger.debug(
        `[${surface}] no AI usage collected for org=${organization.id} — nothing billed`
      );
      return;
    }

    for (const usage of usages) {
      logAiUsage(usage);
    }

    // /copilot/chat accrues instead of charging per request: its autosuggestion
    // boxes fire on every typing pause, so one charge per request would put a
    // ledger row and two aisee-core round-trips behind every keystroke pause.
    // /copilot/agent stays immediate — it is one deliberate turn per request.
    if (surface === 'copilot_chat') {
      this._creditService
        .accrueCollectedUsages(
          {
            userId: organization.id,
            streamKey: `${surface}_${organization.id}`,
            businessType: AiseeBusinessType.AI_COPYWRITING,
            subType: AiseeBusinessSubType.CHAT,
            description: 'Copilot editor assistant / autosuggestions',
            data: {
              ...(extra?.requestType && { requestType: extra.requestType }),
              source: 'chat',
              surface,
            },
          },
          usages,
          COPILOT_CHAT_ACCRUAL_THRESHOLD_CREDITS
        )
        .catch((err) => {
          this.logger.error(`Failed to accrue ${surface} usage:`, err);
        });
      return;
    }

    const taskId = AiseeClient.buildTaskId(`${surface}_${organization.id}_${Date.now()}`);

    this._creditService
      .billCollectedUsages(
        {
          userId: organization.id,
          taskId,
          businessType: AiseeBusinessType.AI_COPYWRITING,
          subType: AiseeBusinessSubType.CHAT,
          relatedId: threadId,
          // Only the agent surface reaches here — copilot_chat returned above.
          description: 'Agent chat conversation',
          data: {
            ...(threadId && { threadId }),
            ...(extra?.requestType && { requestType: extra.requestType }),
            messageCount: usages.length,
            source: 'chat',
            surface,
          },
        },
        usages
      )
      .catch((err) => {
        this.logger.error(`Failed to bill ${surface} usage:`, err);
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
