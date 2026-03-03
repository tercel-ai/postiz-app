import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { shuffle } from 'lodash';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
});

let _openrouterClient: OpenAI | null = null;
function getOpenRouterClient(): OpenAI {
  if (!_openrouterClient) {
    _openrouterClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY || '',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }
  return _openrouterClient;
}

const PicturePrompt = z.object({
  prompt: z.string(),
});

const VoicePrompt = z.object({
  voice: z.string(),
});

@Injectable()
export class OpenaiService {
  private getTextClient(): { client: OpenAI; model: string } {
    const provider = (process.env.IMAGE_PROVIDER || 'openai').toLowerCase();
    const hasOpenAiKey =
      process.env.OPENAI_API_KEY &&
      process.env.OPENAI_API_KEY !== 'sk-proj-' &&
      process.env.OPENAI_API_KEY.length > 0;

    if (provider === 'openrouter' && !hasOpenAiKey) {
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error(
          'OPENROUTER_API_KEY is required when IMAGE_PROVIDER=openrouter without OPENAI_API_KEY'
        );
      }
      return {
        client: getOpenRouterClient(),
        model: process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-4.1',
      };
    }

    return { client: openai, model: 'gpt-4.1' };
  }

  async generateImage(prompt: string, isUrl: boolean, isVertical = false) {
    const provider = (process.env.IMAGE_PROVIDER || 'openai').toLowerCase();

    if (provider === 'openrouter') {
      return this.generateImageViaOpenRouter(prompt, isUrl, isVertical);
    }

    const generate = (
      await openai.images.generate({
        prompt,
        response_format: isUrl ? 'url' : 'b64_json',
        model: 'dall-e-3',
        ...(isVertical ? { size: '1024x1792' } : {}),
      })
    ).data[0];

    return isUrl ? generate.url : generate.b64_json;
  }

  private async generateImageViaOpenRouter(
    prompt: string,
    isUrl: boolean,
    isVertical: boolean
  ): Promise<string | undefined> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required when IMAGE_PROVIDER=openrouter');
    }

    const model =
      process.env.OPENROUTER_IMAGE_MODEL ||
      'google/gemini-3.1-flash-image-preview';

    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          modalities: ['image', 'text'],
          image_config: {
            aspect_ratio: isVertical ? '9:16' : '1:1',
          },
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OpenRouter image generation failed (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || !Array.isArray(content)) {
      throw new Error(
        'OpenRouter returned unexpected response format: no content array'
      );
    }

    const imagePart = content.find(
      (part: any) => part.type === 'image_url' && part.image_url?.url
    );

    if (!imagePart) {
      throw new Error('OpenRouter response did not contain an image');
    }

    const imageUrl: string = imagePart.image_url.url;

    // imageUrl is typically a data URI like "data:image/png;base64,..."
    if (isUrl) {
      // Return the data URI directly — LocalStorage.uploadSimple can handle it
      return imageUrl;
    }

    // Extract raw base64 from the data URI
    const base64Match = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
    return base64Match ? base64Match[1] : imageUrl;
  }

  async generatePromptForPicture(prompt: string) {
    const { client, model } = this.getTextClient();
    return (
      (
        await client.chat.completions.parse({
          model,
          messages: [
            {
              role: 'system',
              content: `You are an assistant that take a description and style and generate a prompt that will be used later to generate images, make it a very long and descriptive explanation, and write a lot of things for the renderer like, if it${"'"}s realistic describe the camera`,
            },
            {
              role: 'user',
              content: `prompt: ${prompt}`,
            },
          ],
          response_format: zodResponseFormat(PicturePrompt, 'picturePrompt'),
        })
      ).choices[0].message.parsed?.prompt || ''
    );
  }

  async generateVoiceFromText(prompt: string) {
    const { client, model } = this.getTextClient();
    return (
      (
        await client.chat.completions.parse({
          model,
          messages: [
            {
              role: 'system',
              content: `You are an assistant that takes a social media post and convert it to a normal human voice, to be later added to a character, when a person talk they don\'t use "-", and sometimes they add pause with "..." to make it sounds more natural, make sure you use a lot of pauses and make it sound like a real person`,
            },
            {
              role: 'user',
              content: `prompt: ${prompt}`,
            },
          ],
          response_format: zodResponseFormat(VoicePrompt, 'voice'),
        })
      ).choices[0].message.parsed?.voice || ''
    );
  }

  async generatePosts(content: string) {
    const { client, model } = this.getTextClient();
    const posts = (
      await Promise.all([
        client.chat.completions.create({
          messages: [
            {
              role: 'assistant',
              content:
                'Generate a Twitter post from the content without emojis in the following JSON format: { "post": string } put it in an array with one element',
            },
            {
              role: 'user',
              content: content!,
            },
          ],
          n: 5,
          temperature: 1,
          model,
        }),
        client.chat.completions.create({
          messages: [
            {
              role: 'assistant',
              content:
                'Generate a thread for social media in the following JSON format: Array<{ "post": string }> without emojis',
            },
            {
              role: 'user',
              content: content!,
            },
          ],
          n: 5,
          temperature: 1,
          model,
        }),
      ])
    ).flatMap((p) => p.choices);

    return shuffle(
      posts.map((choice) => {
        const { content } = choice.message;
        const start = content?.indexOf('[')!;
        const end = content?.lastIndexOf(']')!;
        try {
          return JSON.parse(
            '[' +
              content
                ?.slice(start + 1, end)
                .replace(/\n/g, ' ')
                .replace(/ {2,}/g, ' ') +
              ']'
          );
        } catch (e) {
          return [];
        }
      })
    );
  }
  async extractWebsiteText(content: string) {
    const { client, model } = this.getTextClient();
    const websiteContent = await client.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'You take a full website text, and extract only the article content',
        },
        {
          role: 'user',
          content,
        },
      ],
      model,
    });

    const { content: articleContent } = websiteContent.choices[0].message;

    return this.generatePosts(articleContent!);
  }

  async separatePosts(content: string, len: number) {
    const { client, model } = this.getTextClient();
    const SeparatePostsPrompt = z.object({
      posts: z.array(z.string()),
    });

    const SeparatePostPrompt = z.object({
      post: z.string().max(len),
    });

    const posts =
      (
        await client.chat.completions.parse({
          model,
          messages: [
            {
              role: 'system',
              content: `You are an assistant that take a social media post and break it to a thread, each post must be minimum ${
                len - 10
              } and maximum ${len} characters, keeping the exact wording and break lines, however make sure you split posts based on context`,
            },
            {
              role: 'user',
              content: content,
            },
          ],
          response_format: zodResponseFormat(
            SeparatePostsPrompt,
            'separatePosts'
          ),
        })
      ).choices[0].message.parsed?.posts || [];

    return {
      posts: await Promise.all(
        posts.map(async (post: any) => {
          if (post.length <= len) {
            return post;
          }

          let retries = 4;
          while (retries) {
            try {
              return (
                (
                  await client.chat.completions.parse({
                    model,
                    messages: [
                      {
                        role: 'system',
                        content: `You are an assistant that take a social media post and shrink it to be maximum ${len} characters, keeping the exact wording and break lines`,
                      },
                      {
                        role: 'user',
                        content: post,
                      },
                    ],
                    response_format: zodResponseFormat(
                      SeparatePostPrompt,
                      'separatePost'
                    ),
                  })
                ).choices[0].message.parsed?.post || ''
              );
            } catch (e) {
              retries--;
            }
          }

          return post;
        })
      ),
    };
  }

  async generateSlidesFromText(text: string) {
    const { client, model } = this.getTextClient();
    for (let i = 0; i < 3; i++) {
      try {
        const message = `You are an assistant that takes a text and break it into slides, each slide should have an image prompt and voice text to be later used to generate a video and voice, image prompt should capture the essence of the slide and also have a back dark gradient on top, image prompt should not contain text in the picture, generate between 3-5 slides maximum`;
        const parse =
          (
            await client.chat.completions.parse({
              model,
              messages: [
                {
                  role: 'system',
                  content: message,
                },
                {
                  role: 'user',
                  content: text,
                },
              ],
              response_format: zodResponseFormat(
                z.object({
                  slides: z
                    .array(
                      z.object({
                        imagePrompt: z.string(),
                        voiceText: z.string(),
                      })
                    )
                    .describe('an array of slides'),
                }),
                'slides'
              ),
            })
          ).choices[0].message.parsed?.slides || [];

        return parse;
      } catch (err) {
        console.log(err);
      }
    }

    return [];
  }
}
