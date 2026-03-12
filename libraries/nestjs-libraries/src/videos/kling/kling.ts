import {
  URL,
  Video,
  VideoAbstract,
} from '@gitroom/nestjs-libraries/videos/video.interface';
import { timer } from '@gitroom/helpers/utils/timer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

class KlingParams {
  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  negativePrompt?: string;

  @IsOptional()
  @IsBoolean()
  sound?: boolean;

  @IsOptional()
  @IsString()
  duration?: '5' | '10';
}

@Video({
  identifier: 'kling',
  title: 'Kling 2.6 (Text to Video)',
  description: 'Generate high-quality videos with cinematic visuals and smooth motion using Kling AI.',
  placement: 'text-to-image',
  dto: KlingParams,
  tools: [],
  trial: false,
  available: !!process.env.KIEAI_API_KEY,
})
export class Kling extends VideoAbstract<KlingParams> {
  override dto = KlingParams;

  private readonly baseUrl = 'https://api.kie.ai/api/v1';
  private readonly model = 'kling-2.6/text-to-video';
  private readonly pollIntervalMs = 10000;
  private readonly maxPollAttempts = 120; // ~20 minutes max

  async process(
    output: 'vertical' | 'horizontal',
    customParams: KlingParams
  ): Promise<URL> {
    const apiKey = process.env.KIEAI_API_KEY;
    if (!apiKey) {
      throw new Error('KIEAI_API_KEY is not configured');
    }

    // Submit generation task
    const createResp = await fetch(`${this.baseUrl}/jobs/createTask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          prompt: customParams.prompt,
          negative_prompt: customParams.negativePrompt || '',
          sound: customParams.sound ?? false,
          aspect_ratio: output === 'horizontal' ? '16:9' : '9:16',
          duration: customParams.duration || '5',
        },
      }),
    });

    const createData = await createResp.json();

    if (createData.code !== 200 && createData.code !== 201) {
      throw new Error(
        `Failed to create Kling video task: ${createData.msg || JSON.stringify(createData)}`
      );
    }

    const taskId = createData.data?.taskId;
    if (!taskId) {
      throw new Error('No taskId returned from Kling API');
    }

    console.log(`[Kling] Task created: ${taskId}`);

    // Poll for completion
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      await timer(this.pollIntervalMs);

      const statusResp = await fetch(
        `${this.baseUrl}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );

      if (!statusResp.ok) {
        // 4xx = client error (auth, not found) — fail fast, don't spin
        if (statusResp.status >= 400 && statusResp.status < 500) {
          throw new Error(
            `Kling polling aborted: HTTP ${statusResp.status} ${await statusResp.text()}`
          );
        }
        console.warn(`[Kling] Polling HTTP ${statusResp.status}, retrying...`);
        continue;
      }

      const statusData = await statusResp.json();

      if (statusData.code !== 200) {
        console.warn(`[Kling] Unexpected API code: ${statusData.code}, retrying...`);
        continue;
      }

      const state = statusData.data?.state;
      const progress = statusData.data?.progress;

      if (state === 'fail') {
        throw new Error(
          `Kling video generation failed: ${statusData.data?.failMsg || 'Unknown error'}`
        );
      }

      if (state === 'success') {
        const resultJson = statusData.data?.resultJson;
        let resultUrls: string[] = [];

        if (typeof resultJson === 'string') {
          try {
            const parsed = JSON.parse(resultJson);
            resultUrls = parsed.resultUrls || [];
          } catch {
            // resultJson might already be in response format
          }
        }

        // Also check the nested response format (same as Veo3)
        if (resultUrls.length === 0) {
          resultUrls = statusData.data?.response?.resultUrls || [];
        }

        if (resultUrls.length === 0) {
          throw new Error('Kling video completed but no result URL found');
        }

        console.log(`[Kling] Video ready: ${resultUrls[0]}`);
        return resultUrls[0];
      }

      console.log(
        `[Kling] Waiting for video (state=${state}, progress=${progress ?? 'N/A'}, attempt=${attempt + 1}/${this.maxPollAttempts})`
      );
    }

    throw new Error(
      `Kling video generation timed out after ${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s`
    );
  }
}
