import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { parseDate } from '@gitroom/helpers/utils/date.utils';
import { AllProvidersSettings } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import { validate } from 'class-validator';
import { Integration } from '@prisma/client';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { resolveIntegrationIds, SelectedIntegration } from './resolve-integration';

function countCharacters(text: string, type: string): number {
  if (type !== 'x') {
    return text.length;
  }
  return weightedLength(text);
}

@Injectable()
export class IntegrationSchedulePostTool implements AgentToolInterface {
  constructor(
    private _postsService: PostsService,
    private _integrationService: IntegrationService
  ) {}
  name = 'integrationSchedulePostTool';

  run() {
    return createTool({
      id: 'schedulePostTool',
      description: `
This tool allows you to schedule a post to a social media platform, based on integrationSchema tool.
So for example:

If the user want to post a post to LinkedIn with one comment
- socialPost array length will be one
- postsAndComments array length will be two (one for the post, one for the comment)

If the user want to post 20 posts for facebook each in individual days without comments
- socialPost array length will be 20
- postsAndComments array length will be one

If the tools return errors, you would need to rerun it with the right parameters, don't ask again, just run it

Integration routing:
- If the user selected only 1 channel, you can omit integrationId — it will be auto-resolved.
- If the user selected multiple channels and wants to post to a specific one, pass its integrationId.
- If the user selected multiple channels and wants to post to all, omit integrationId.
`,
      inputSchema: z.object({
        socialPost: z
          .array(
            z.object({
              integrationId: z
                .string()
                .optional()
                .describe(
                  'Optional. The integration ID from the selected channels. If only 1 channel is selected, this is auto-resolved. If omitted with multiple channels, the post goes to ALL selected channels.'
                ),
              isPremium: z
                .boolean()
                .describe(
                  "If the integration is X, return if it's premium or not"
                ),
              date: z.string().describe('The date of the post in ISO 8601 format'),
              shortLink: z
                .boolean()
                .describe(
                  'If the post has a link inside, we can ask the user if they want to add a short link'
                ),
              type: z
                .enum(['draft', 'schedule', 'now'])
                .describe(
                  'The type of the post, if we pass now, we should pass the current date also'
                ),
              postsAndComments: z
                .array(
                  z.object({
                    content: z
                      .string()
                      .describe(
                        "The content of the post, HTML, Each line must be wrapped in <p> here is the possible tags: h1, h2, h3, u, strong, li, ul, p (you can't have u and strong together)"
                      ),
                    attachments: z
                      .array(z.string())
                      .describe('The image of the post (URLS)'),
                  })
                )
                .describe(
                  'first item is the post, every other item is the comments'
                ),
              settings: z
                .array(
                  z.object({
                    key: z
                      .string()
                      .describe('Name of the settings key to pass'),
                    value: z
                      .any()
                      .describe(
                        'Value of the key, always prefer the id then label if possible'
                      ),
                  })
                )
                .describe(
                  'This relies on the integrationSchema tool to get the settings [input:settings]'
                ),
            })
          )
          .describe('Individual post'),
      }),
      outputSchema: z.object({
        output: z
          .array(
            z.object({
              postId: z.string(),
              integration: z.string(),
            })
          )
          .or(z.object({ errors: z.string() })),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;
        // @ts-ignore
        const userId = runtimeContext.get('userId') as string | undefined;
        // @ts-ignore
        const userTimezone: string = runtimeContext.get('timezone') as string || 'UTC';

        // Get user-selected integrations from runtimeContext (set by frontend)
        const selectedIntegrations: SelectedIntegration[] =
          // @ts-ignore
          (runtimeContext.get('integrations') as any[] || []);

        const finalOutput = [];

        // Expand socialPost items: resolve integrationIds using routing rules
        interface ExpandedPost {
          resolvedIntegrationId: string;
          isPremium: boolean;
          date: string;
          shortLink: boolean;
          type: string;
          postsAndComments: { content: string; attachments: string[] }[];
          settings: { key: string; value: any }[];
        }
        const expandedPosts: ExpandedPost[] = [];

        for (const post of context.socialPost) {
          const result = resolveIntegrationIds(selectedIntegrations, post.integrationId);

          if (result.kind === 'error') {
            return { errors: result.message };
          }

          for (const resolvedId of result.integrationIds) {
            // Convert user's local time to UTC using the same parseDate utility
            // as the rest of the codebase (case 3: no offset + tz → local time in that tz)
            const utcDate = parseDate(post.date, userTimezone).utc().toISOString();
            expandedPosts.push({
              resolvedIntegrationId: resolvedId,
              isPremium: post.isPremium,
              date: utcDate,
              shortLink: post.shortLink,
              type: post.type,
              postsAndComments: post.postsAndComments,
              settings: post.settings,
            });
          }
        }

        // Validate all expanded posts
        const integrations = {} as Record<string, Integration>;
        for (const post of expandedPosts) {
          if (!integrations[post.resolvedIntegrationId]) {
            const integration = await this._integrationService.getIntegrationById(
              organizationId,
              post.resolvedIntegrationId
            );

            if (!integration) {
              return {
                errors: `Integration ${post.resolvedIntegrationId} not found in database.`,
              };
            }
            integrations[post.resolvedIntegrationId] = integration;
          }

          const integration = integrations[post.resolvedIntegrationId];
          const providerInfo = socialIntegrationList.find(
            (p) => p.identifier === integration.providerIdentifier
          );

          if (!providerInfo) {
            return {
              errors: `Unknown platform for integration ${integration.name || post.resolvedIntegrationId}.`,
            };
          }

          const { dto, maxLength, identifier } = providerInfo;

          if (dto) {
            const newDTO = new dto();
            const obj = Object.assign(
              newDTO,
              post.settings.reduce(
                (acc, s) => ({
                  ...acc,
                  [s.key]: s.value,
                }),
                {} as AllProvidersSettings
              )
            );
            const errors = await validate(obj);
            if (errors.length) {
              return {
                errors: JSON.stringify(errors),
              };
            }

            const errorsLength = [];
            for (const p of post.postsAndComments) {
              const maximumCharacters = maxLength(post.isPremium);
              const strip = stripHtmlValidation('normal', p.content, true);
              const wLen = countCharacters(strip, identifier || '');
              const totalCharacters =
                wLen > strip.length ? wLen : strip.length;

              if (totalCharacters > (maximumCharacters || 1000000)) {
                errorsLength.push({
                  value: p.content,
                  error: `The maximum characters is ${maximumCharacters}, we got ${totalCharacters}, please fix it, and try integrationSchedulePostTool again.`,
                });
              }
            }

            if (errorsLength.length) {
              return {
                errors: JSON.stringify(errorsLength),
              };
            }
          }
        }

        // Create posts
        for (const post of expandedPosts) {
          const integration = integrations[post.resolvedIntegrationId];

          const output = await this._postsService.createPost(organizationId, {
            date: post.date,
            type: post.type as 'draft' | 'schedule' | 'now',
            shortLink: post.shortLink,
            tags: [],
            posts: [
              {
                integration,
                group: makeId(10),
                settings: post.settings.reduce(
                  (acc, s) => ({
                    ...acc,
                    [s.key]: s.value,
                  }),
                  {
                    __type: integration.providerIdentifier,
                  } as AllProvidersSettings
                ),
                value: post.postsAndComments.map((p) => ({
                  content: p.content,
                  id: makeId(10),
                  delay: 0,
                  image: p.attachments.map((a) => ({
                    id: makeId(10),
                    path: a,
                  })),
                })),
              },
            ],
          }, userId);
          finalOutput.push(...output);
        }

        return {
          output: finalOutput,
        };
      },
    });
  }
}
