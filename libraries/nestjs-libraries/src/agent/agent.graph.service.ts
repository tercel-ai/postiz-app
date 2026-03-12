import { Injectable } from '@nestjs/common';
import {
  BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ChatOpenAI, DallEAPIWrapper } from '@langchain/openai';
import { TavilySearchResults } from '@langchain/community/tools/tavily_search';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import dayjs from 'dayjs';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { z } from 'zod';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { GeneratorDto } from '@gitroom/nestjs-libraries/dtos/generator/generator.dto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import {
  AiUsageInfo,
  parseModelId,
  logAiUsage,
} from '@gitroom/nestjs-libraries/openai/openai.service';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import {
  AiseeClient,
  AiseeBusinessType,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';

const agentServicer: string =
  (process.env.IMAGE_PROVIDER || 'openai').toLowerCase() === 'openrouter' &&
  !(
    process.env.OPENAI_API_KEY &&
    process.env.OPENAI_API_KEY !== 'sk-proj-' &&
    process.env.OPENAI_API_KEY.length > 0
  )
    ? 'openrouter'
    : 'openai';

/**
 * Per-run usage collector. Each agent invocation creates its own instance
 * so concurrent requests don't mix usage data.
 */
class AiUsageCollector extends BaseCallbackHandler {
  name = 'AiUsageCollector';
  readonly usages: AiUsageInfo[] = [];

  override async handleLLMEnd(output: any) {
    const usage = output?.llmOutput?.tokenUsage || output?.llmOutput?.usage;
    const rawModel =
      output?.llmOutput?.model_name ||
      output?.llmOutput?.model ||
      'unknown';
    const { provider, model } = parseModelId(rawModel, agentServicer);
    if (usage) {
      const info: AiUsageInfo = {
        servicer: agentServicer,
        provider,
        model,
        type: 'text',
        billing_mode: 'per_token',
        method: 'agent',
        usage: {
          prompt_tokens: usage.promptTokens ?? usage.prompt_tokens ?? 0,
          completion_tokens:
            usage.completionTokens ?? usage.completion_tokens ?? 0,
          total_tokens: usage.totalTokens ?? usage.total_tokens ?? 0,
        },
      };
      logAiUsage(info);
      this.usages.push(info);
    }
  }
}

const tools = !process.env.TAVILY_API_KEY
  ? []
  : [new TavilySearchResults({ maxResults: 3 })];
const toolNode = new ToolNode(tools);

function createModel(callbacks: BaseCallbackHandler[]) {
  if (agentServicer === 'openrouter') {
    return new ChatOpenAI({
      apiKey: process.env.OPENROUTER_API_KEY || '',
      model: process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-4.1',
      temperature: 0.7,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
      },
      callbacks,
    });
  }
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
    model: 'gpt-4.1',
    temperature: 0.7,
    callbacks,
  });
}

const dalle = new DallEAPIWrapper({
  apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
  model: 'dall-e-3',
});

interface WorkflowChannelsState {
  messages: BaseMessage[];
  orgId: string;
  question: string;
  hook?: string;
  fresearch?: string;
  category?: string;
  topic?: string;
  date?: string;
  format: 'one_short' | 'one_long' | 'thread_short' | 'thread_long';
  tone: 'personal' | 'company';
  content?: {
    content: string;
    website?: string;
    prompt?: string;
    image?: string;
  }[];
  isPicture?: boolean;
  popularPosts?: { content: string; hook: string }[];
  /** Per-run usage collector — injected at start */
  _usageCollector?: AiUsageCollector;
}

const category = z.object({
  category: z.string().describe('The category for the post'),
});

const topic = z.object({
  topic: z.string().describe('The topic for the post'),
});

const hook = z.object({
  hook: z
    .string()
    .describe(
      'Hook for the new post, don\'t take it from "the request of the user"'
    ),
});

const contentZod = (
  isPicture: boolean,
  format: 'one_short' | 'one_long' | 'thread_short' | 'thread_long'
) => {
  const content = z.object({
    content: z.string().describe('Content for the new post'),
    website: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Website for the new post if exists, If one of the post present a brand, website link must be to the root domain of the brand or don't include it, website url should contain the brand name"
      ),
    ...(isPicture
      ? {
          prompt: z
            .string()
            .describe(
              "Prompt to generate a picture for this post later, make sure it doesn't contain brand names and make it very descriptive in terms of style"
            ),
        }
      : {}),
  });

  return z.object({
    content:
      format === 'one_short' || format === 'one_long'
        ? content
        : z.array(content).min(2).describe(`Content for the new post`),
  });
};

@Injectable()
export class AgentGraphService {
  private storage = UploadFactory.createStorage();
  constructor(
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _aiseeCreditService: AiseeCreditService
  ) {}
  static state = () =>
    new StateGraph<WorkflowChannelsState>({
      channels: {
        messages: {
          reducer: (currentState, updateValue) =>
            currentState.concat(updateValue),
          default: () => [],
        },
        fresearch: null,
        format: null,
        tone: null,
        question: null,
        orgId: null,
        hook: null,
        content: null,
        date: null,
        category: null,
        popularPosts: null,
        topic: null,
        isPicture: null,
        _usageCollector: null,
      },
    });

  async startCall(state: WorkflowChannelsState) {
    const collector = state._usageCollector!;
    const runModel = createModel([collector]);
    const runTools = runModel.bindTools(tools);
    const response = await ChatPromptTemplate.fromTemplate(
      `
    Today is ${dayjs().format()}, You are an assistant that gets a social media post or requests for a social media post.
    You research should be on the most possible recent data.
    You concat the text of the request together with an internet research based on the text.
    {text}
    `
    )
      .pipe(runTools)
      .invoke({
        text: state.messages[state.messages.length - 1].content,
      });

    return { messages: [response] };
  }

  async saveResearch(state: WorkflowChannelsState) {
    const content = state.messages.filter((f) => f instanceof ToolMessage);
    return { fresearch: content };
  }

  async findCategories(state: WorkflowChannelsState) {
    const collector = state._usageCollector!;
    const runModel = createModel([collector]);
    const allCategories = await this._postsService.findAllExistingCategories();
    const structuredOutput = runModel.withStructuredOutput(category);
    const { category: outputCategory } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets a text that will be later summarized into a social media post
        and classify it to one of the following categories: {categories}
        text: {text}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        categories: allCategories.map((p) => p.category).join(', '),
        text: state.fresearch,
      });

    return {
      category: outputCategory,
    };
  }

  async findTopic(state: WorkflowChannelsState) {
    const collector = state._usageCollector!;
    const runModel = createModel([collector]);
    const allTopics = await this._postsService.findAllExistingTopicsOfCategory(
      state?.category!
    );
    if (allTopics.length === 0) {
      return { topic: null };
    }

    const structuredOutput = runModel.withStructuredOutput(topic);
    const { topic: outputTopic } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets a text that will be later summarized into a social media post
        and classify it to one of the following topics: {topics}
        text: {text}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        topics: allTopics.map((p) => p.topic).join(', '),
        text: state.fresearch,
      });

    return {
      topic: outputTopic,
    };
  }

  async findPopularPosts(state: WorkflowChannelsState) {
    const popularPosts = await this._postsService.findPopularPosts(
      state.category!,
      state.topic
    );
    return { popularPosts };
  }

  async generateHook(state: WorkflowChannelsState) {
    const collector = state._usageCollector!;
    const runModel = createModel([collector]);
    const structuredOutput = runModel.withStructuredOutput(hook);
    const { hook: outputHook } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets content for a social media post, and generate only the hook.
        The hook is the 1-2 sentences of the post that will be used to grab the attention of the reader.
        You will be provided existing hooks you should use as inspiration.
        - Avoid weird hook that starts with "Discover the secret...", "The best...", "The most...", "The top..."
        - Make sure it sounds ${state.tone}
        - Use ${state.tone === 'personal' ? '1st' : '3rd'} person mode
        - Make sure it's engaging
        - Don't be cringy
        - Use simple english
        - Make sure you add "\n" between the lines
        - Don't take the hook from "request of the user"

        <!-- BEGIN request of the user -->
        {request}
        <!-- END request of the user -->

        <!-- BEGIN existing hooks -->
        {hooks}
        <!-- END existing hooks -->

        <!-- BEGIN current content -->
        {text}
        <!-- END current content -->

      `
    )
      .pipe(structuredOutput)
      .invoke({
        request: state.messages[0].content,
        hooks: state.popularPosts!.map((p) => p.hook).join('\n'),
        text: state.fresearch,
      });

    return {
      hook: outputHook,
    };
  }

  async generateContent(state: WorkflowChannelsState) {
    const collector = state._usageCollector!;
    const runModel = createModel([collector]);
    const structuredOutput = runModel.withStructuredOutput(
      contentZod(!!state.isPicture, state.format)
    );
    const { content: outputContent } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets existing hook of a social media, content and generate only the content.
        - Don't add any hashtags
        - Make sure it sounds ${state.tone}
        - Use ${state.tone === 'personal' ? '1st' : '3rd'} person mode
        - ${
          state.format === 'one_short' || state.format === 'thread_short'
            ? 'Post should be maximum 200 chars to fit twitter'
            : 'Post should be long'
        }
        - ${
          state.format === 'one_short' || state.format === 'one_long'
            ? 'Post should have only 1 item'
            : 'Post should have minimum 2 items'
        }
        - Use the hook as inspiration
        - Make sure it's engaging
        - Don't be cringy
        - Use simple english
        - The Content should not contain the hook
        - Try to put some call to action at the end of the post
        - Make sure you add "\n" between the lines
        - Add "\n" after every "."

        Hook:
        {hook}

        User request:
        {request}

        current content information:
        {information}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        hook: state.hook,
        request: state.messages[0].content,
        information: state.fresearch,
      });

    return {
      content: outputContent,
    };
  }

  async fixArray(state: WorkflowChannelsState) {
    if (state.format === 'one_short' || state.format === 'one_long') {
      return {
        content: [state.content],
      };
    }

    return {};
  }

  async generatePictures(state: WorkflowChannelsState) {
    if (!state.isPicture) {
      return {};
    }

    const collector = state._usageCollector!;
    const newContent = await Promise.all(
      (state.content || []).map(async (p) => {
        const image = await dalle.invoke(p.prompt!);
        const imageUsage: AiUsageInfo = {
          servicer: 'openai',
          provider: 'openai',
          model: 'dall-e-3',
          type: 'image',
          billing_mode: 'per_image',
          method: 'agent.generatePictures',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          image_billing: { count: 1, size: '1024x1024', quality: 'standard' },
        };
        logAiUsage(imageUsage);
        collector.usages.push(imageUsage);
        return {
          ...p,
          image,
        };
      })
    );

    return {
      content: newContent,
    };
  }

  async uploadPictures(state: WorkflowChannelsState) {
    const all = await Promise.all(
      (state.content || []).map(async (p) => {
        if (p.image) {
          const upload = await this.storage.uploadSimple(p.image);
          const name = upload.split('/').pop()!;
          const uploadWithId = await this._mediaService.saveFile(
            state.orgId,
            name,
            upload
          );

          return {
            ...p,
            image: uploadWithId,
          };
        }

        return p;
      })
    );

    return { content: all };
  }

  async isGeneratePicture(state: WorkflowChannelsState) {
    if (state.isPicture) {
      return 'generate-picture';
    }

    return 'post-time';
  }

  async postDateTime(state: WorkflowChannelsState) {
    return { date: await this._postsService.findFreeDateTime(state.orgId) };
  }

  /**
   * Bill all collected AI usages after the graph completes.
   */
  private async billUsages(
    orgId: string,
    collector: AiUsageCollector
  ): Promise<void> {
    if (collector.usages.length === 0) return;

    const taskId = AiseeClient.buildTaskId(`agent_${orgId}_${Date.now()}`);
    await this._aiseeCreditService.billCollectedUsages(
      {
        userId: orgId,
        taskId,
        businessType: AiseeBusinessType.AI_COPYWRITING,
        description: 'Agent post generation (text + image)',
      },
      collector.usages
    );
  }

  async *start(orgId: string, body: GeneratorDto) {
    // Per-run usage collector
    const collector = new AiUsageCollector();

    const state = AgentGraphService.state();
    const workflow = state
      .addNode('agent', this.startCall.bind(this))
      .addNode('research', toolNode)
      .addNode('save-research', this.saveResearch.bind(this))
      .addNode('find-category', this.findCategories.bind(this))
      .addNode('find-topic', this.findTopic.bind(this))
      .addNode('find-popular-posts', this.findPopularPosts.bind(this))
      .addNode('generate-hook', this.generateHook.bind(this))
      .addNode('generate-content', this.generateContent.bind(this))
      .addNode('generate-content-fix', this.fixArray.bind(this))
      .addNode('generate-picture', this.generatePictures.bind(this))
      .addNode('upload-pictures', this.uploadPictures.bind(this))
      .addNode('post-time', this.postDateTime.bind(this))
      .addEdge(START, 'agent')
      .addEdge('agent', 'research')
      .addEdge('research', 'save-research')
      .addEdge('save-research', 'find-category')
      .addEdge('find-category', 'find-topic')
      .addEdge('find-topic', 'find-popular-posts')
      .addEdge('find-popular-posts', 'generate-hook')
      .addEdge('generate-hook', 'generate-content')
      .addEdge('generate-content', 'generate-content-fix')
      .addConditionalEdges(
        'generate-content-fix',
        this.isGeneratePicture.bind(this)
      )
      .addEdge('generate-picture', 'upload-pictures')
      .addEdge('upload-pictures', 'post-time')
      .addEdge('post-time', END);

    const app = workflow.compile();

    const stream = app.streamEvents(
      {
        messages: [new HumanMessage(body.research)],
        isPicture: body.isPicture,
        format: body.format,
        tone: body.tone,
        orgId,
        _usageCollector: collector,
      },
      {
        streamMode: 'values',
        version: 'v2',
      }
    );

    for await (const event of stream) {
      yield event;
    }

    // Bill after stream completes — fire-and-forget
    this.billUsages(orgId, collector).catch((err) => {
      console.error('[AgentBilling] Unhandled billing error:', err);
    });
  }
}
