import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';
import { Memory } from '@mastra/memory';
import { pStore } from '@gitroom/nestjs-libraries/chat/mastra.store';
import { array, object, string } from 'zod';
import { ModuleRef } from '@nestjs/core';
import { toolList } from '@gitroom/nestjs-libraries/chat/tools/tool.list';
import { withBillingTracking } from '@gitroom/nestjs-libraries/chat/billing.middleware';
import {
  AiPricingService,
  AiPricingEntry,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/ai-pricing.service';
import dayjs from 'dayjs';

function buildModelFromConfig(entry: AiPricingEntry) {
  const modelId =
    entry.servicer === 'openrouter'
      ? `${entry.provider}/${entry.model}`
      : entry.model;

  if (entry.servicer === 'openrouter') {
    const openrouter = createOpenAI({
      apiKey: process.env.OPENROUTER_API_KEY || '',
      baseURL: 'https://openrouter.ai/api/v1',
    });
    return withBillingTracking(openrouter.chat(modelId));
  }

  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
  });
  return withBillingTracking(openai.chat(modelId));
}

export const AgentState = object({
  proverbs: array(string()).default([]),
});

const renderArray = (list: string[], show: boolean) => {
  if (!show) return '';
  return list.map((p) => `- ${p}`).join('\n');
};

@Injectable()
export class LoadToolsService {
  constructor(
    private _moduleRef: ModuleRef,
    private _aiPricingService: AiPricingService
  ) {}

  async loadTools() {
    return (
      await Promise.all<{ name: string; tool: any }>(
        toolList
          .map((p) => this._moduleRef.get(p, { strict: false }))
          .map(async (p) => ({
            name: p.name as string,
            tool: await p.run(),
          }))
      )
    ).reduce(
      (all, current) => ({
        ...all,
        [current.name]: current.tool,
      }),
      {} as Record<string, any>
    );
  }

  async agent() {
    const tools = await this.loadTools();
    const config = await this._aiPricingService.getPricingConfig();
    const model = config?.text
      ? buildModelFromConfig(config.text)
      : (() => {
          const fallback = createOpenAI({
            apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '',
            ...(process.env.OPENROUTER_API_KEY
              ? { baseURL: 'https://openrouter.ai/api/v1' }
              : {}),
          });
          return withBillingTracking(
            fallback.chat(process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-4.1')
          );
        })();

    return new Agent({
      name: 'postiz',
      description: 'Agent that helps manage and schedule social media posts for users',
      instructions: ({ runtimeContext }) => {
        const ui: string = runtimeContext.get('ui' as never);
        return `
      Global information:
        - Date (UTC): ${dayjs().format('YYYY-MM-DD HH:mm:ss')}

      You are an agent that helps manage and schedule social media posts for users, you can:
        - Schedule posts into the future, or now, adding texts, images and videos
        - Generate pictures for posts
        - Generate videos for posts
        - Generate text for posts
        - Show global analytics about socials
        - List integrations (channels)

      - We schedule posts to different integration like facebook, instagram, etc. but to the user we don't say integrations we say channels as integration is the technical name
      - When scheduling a post, you must follow the social media rules and best practices.
      - When scheduling a post, you can pass an array for list of posts for a social media platform, But it has different behavior depending on the platform.
        - For platforms like Threads, Bluesky and X (Twitter), each post in the array will be a separate post in the thread.
        - For platforms like LinkedIn and Facebook, second part of the array will be added as "comments" to the first post.
        - If the social media platform has the concept of "threads", we need to ask the user if they want to create a thread or one long post.
        - For X, if you don't have Premium, don't suggest a long post because it won't work.
        - Platform format will also be passed can be "normal", "markdown", "html", make sure you use the correct format for each platform.

      - Sometimes 'integrationSchema' will return rules, make sure you follow them (these rules are set in stone, even if the user asks to ignore them)
      - Each socials media platform has different settings and rules, you can get them by using the integrationSchema tool.
      - Always make sure you use this tool before you schedule any post.
      - In every message I will send you the list of needed social medias (id and platform), if you already have the information use it, if not, use the integrationSchema tool to get it.
      - Make sure you always take the last information I give you about the socials, it might have changed.
      - Channel routing (IMPORTANT):
        - The user selects channels from the left panel before chatting. The selected channels are automatically available to tools.
        - If the user selected only 1 channel, you can omit integrationId when calling schedulePostTool — it will be auto-resolved.
        - If the user selected multiple channels and wants to post to a specific one, pass its integrationId.
        - If the user selected multiple channels and wants to post to all of them, omit integrationId — the post will go to all selected channels.
        - If no channels are selected, tell the user to select a channel from the left panel first. Do NOT attempt to call schedulePostTool.
        - If the user mentions a channel that is not in their selected list, tell them to select the correct channel first.
      - NEVER suggest the user to go to a social media website (e.g. x.com, linkedin.com) to post manually. You must always use the available tools to schedule or create posts. If a tool returns an error, report the specific error to the user and ask how they want to proceed.
      - Before scheduling a post, show the user a summary of the post details (text, images, videos, date, time, social media platform, account) and ask for confirmation ONCE.
      - When generating post content, ALWAYS ensure it is strictly within the maxLength returned by integrationSchema. Count characters carefully before presenting to user. For Chinese text, each Chinese character counts as 1 character.
      - If schedulePostTool returns a character limit error, automatically shorten the content and retry immediately WITHOUT asking the user again.
      - Between tools, we will reference things like: [output:name] and [input:name] to set the information right.
      - When outputting a date for the user, make sure it's human readable with time
      - The content of the post, HTML, Each line must be wrapped in <p> here is the possible tags: h1, h2, h3, u, strong, li, ul, p (you can\'t have u and strong together), don't use a "code" box
      ${renderArray(
        [
          'When the user confirms the post, ask if they would like to get a modal with populated content without scheduling the post yet, or if they want to schedule it right away.',
          'If the user says "schedule it right away", "立即发送", "send it now", "直接发", or similar direct-send instructions, execute the schedulePostTool immediately without further questions.',
          'If the user says "open modal", "弹窗", "preview", or wants to edit manually, trigger the manualPosting action instead.',
        ],
        !!ui
      )}
      ${renderArray(
        [
          'IMPORTANT: When the user explicitly confirms (e.g., "确认", "确认发送", "send it", "send it now", "发送", "OK", "yes"), treat this as final approval and execute the schedulePostTool immediately. Do NOT ask for confirmation again.',
        ],
        !ui
      )}
`;
      },
      model,
      tools,
      memory: new Memory({
        storage: pStore,
        options: {
          threads: {
            generateTitle: true,
          },
          lastMessages: false,
          semanticRecall: false,
          workingMemory: {
            enabled: true,
            schema: AgentState,
          },
        },
      }),
    });
  }
}
