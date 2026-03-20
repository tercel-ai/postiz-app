import { HttpException, Injectable, Logger } from '@nestjs/common';
import { MediaRepository } from '@gitroom/nestjs-libraries/database/prisma/media/media.repository';
import { OpenaiService, AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { Organization } from '@prisma/client';
import { SaveMediaInformationDto } from '@gitroom/nestjs-libraries/dtos/media/save.media.information.dto';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import {
  AuthorizationActions,
  Sections,
  SubscriptionException,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import {
  AiseeClient,
  AiseeBusinessType,
  AiseeBusinessSubType,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { isInternalBilling } from '@gitroom/nestjs-libraries/services/billing.helper';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private storage = UploadFactory.createStorage();

  constructor(
    private _mediaRepository: MediaRepository,
    private _openAi: OpenaiService,
    private _subscriptionService: SubscriptionService,
    private _videoManager: VideoManager,
    private _aiseeCreditService: AiseeCreditService
  ) {}

  async deleteMedia(org: string, id: string) {
    return this._mediaRepository.deleteMedia(org, id);
  }

  getMediaById(id: string) {
    return this._mediaRepository.getMediaById(id);
  }

  async generateImage(
    prompt: string,
    org: Organization,
    generatePromptFirst?: boolean
  ) {
    // BILL_TYPE=internal → original useCredit() subscription quota only
    // BILL_TYPE=third    → Aisee credits only (no subscription quota)
    if (isInternalBilling()) {
      return this._generateImageInternal(prompt, org, generatePromptFirst);
    }

    return this._generateImageThird(prompt, org, generatePromptFirst);
  }

  /**
   * Internal billing path: subscription-based useCredit() quota tracking.
   * Also creates BillingRecord (status='internal') for unified tracking.
   */
  private async _generateImageInternal(
    prompt: string,
    org: Organization,
    generatePromptFirst?: boolean
  ) {
    return this._subscriptionService.useCredit(
      org,
      'ai_images',
      async () => {
        const { data, usages } = await this._generateImageCore(prompt, org, generatePromptFirst);
        this._billImageUsages(org, usages, { prompt, generatePromptFirst });
        return data;
      }
    );
  }

  /**
   * Core image generation — returns data + usages without billing.
   */
  private async _generateImageCore(
    prompt: string,
    org: Organization,
    generatePromptFirst?: boolean
  ): Promise<{ data: string; usages: AiUsageInfo[] }> {
    const usages: AiUsageInfo[] = [];

    if (generatePromptFirst) {
      const promptResult = await this._openAi.generatePromptForPicture(prompt);
      prompt = promptResult.data;
      usages.push(promptResult.usage);
    }

    const imageResult = await this._openAi.generateImage(prompt, !!generatePromptFirst);
    usages.push(imageResult.usage);

    return { data: imageResult.data, usages };
  }

  /**
   * Fire image billing — fire-and-forget.
   * Always creates a BillingRecord regardless of billing mode.
   */
  private _billImageUsages(
    org: Organization,
    usages: AiUsageInfo[],
    opts?: { relatedId?: string; prompt?: string; generatePromptFirst?: boolean }
  ): void {
    const taskId = AiseeClient.buildTaskId(`img_${org.id}_${Date.now()}`);
    this._aiseeCreditService
      .billCollectedUsages(
        {
          userId: org.id,
          taskId,
          businessType: AiseeBusinessType.IMAGE_GEN,
          subType: AiseeBusinessSubType.IMAGE,
          relatedId: opts?.relatedId,
          description: `Image generation${opts?.generatePromptFirst ? ' (with prompt enhancement)' : ''}`,
          data: opts?.prompt ? { prompt: opts.prompt } : undefined,
        },
        usages
      )
      .catch((err) => {
        this.logger.error('[AiseeBilling] Image billing failed:', err);
      });
  }

  /**
   * Aisee billing path: deduct actual AI usage credits via Aisee.
   * No subscription quota involved.
   */
  private async _generateImageThird(
    prompt: string,
    org: Organization,
    generatePromptFirst?: boolean
  ): Promise<string> {
    const { data, usages } = await this._generateImageCore(prompt, org, generatePromptFirst);
    this._billImageUsages(org, usages, { prompt, generatePromptFirst });
    return data;
  }

  /**
   * Generate an image, upload + save to media, and bill with the saved mediaId.
   * Used by the /generate-image-with-prompt endpoint.
   * Always creates a BillingRecord with relatedId=mediaId.
   */
  async generateImageWithSave(
    prompt: string,
    org: Organization
  ): Promise<ReturnType<MediaService['saveFile']>> {
    const doGenerate = async () => {
      const { data, usages } = await this._generateImageCore(prompt, org, true);
      const file = await this.storage.uploadSimple(data);
      const saved = await this.saveFile(org.id, file.split('/').pop()!, file);
      this._billImageUsages(org, usages, {
        relatedId: saved.id,
        prompt,
        generatePromptFirst: true,
      });
      return saved;
    };

    if (isInternalBilling()) {
      return this._subscriptionService.useCredit(org, 'ai_images', doGenerate);
    }
    return doGenerate();
  }

  saveFile(org: string, fileName: string, filePath: string) {
    return this._mediaRepository.saveFile(org, fileName, filePath);
  }

  getMedia(org: string, page: number) {
    return this._mediaRepository.getMedia(org, page);
  }

  paginate(options: {
    page: number;
    pageSize: number;
    keyword?: string;
    organizationId?: string | string[];
    type?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    return this._mediaRepository.paginate(options);
  }

  saveMediaInformation(org: string, data: SaveMediaInformationDto) {
    return this._mediaRepository.saveMediaInformation(org, data);
  }

  getVideoOptions() {
    return this._videoManager.getAllVideos();
  }

  async generateVideoAllowed(org: Organization, type: string) {
    const video = this._videoManager.getVideoByName(type);
    if (!video) {
      throw new Error(`Video type ${type} not found`);
    }

    if (!video.trial && org.isTrailing) {
      throw new HttpException('This video is not available in trial mode', 406);
    }

    return true;
  }

  async generateVideo(org: Organization, body: VideoDto) {
    const video = this._videoManager.getVideoByName(body.type);
    if (!video) {
      throw new Error(`Video type ${body.type} not found`);
    }

    if (!video.trial && org.isTrailing) {
      throw new HttpException('This video is not available in trial mode', 406);
    }

    await video.instance.processAndValidate(body.customParams);

    // BILL_TYPE=internal → legacy subscription credit check + useCredit wrapper
    if (isInternalBilling()) {
      const totalCredits = await this._subscriptionService.checkCredits(
        org,
        'ai_videos'
      );

      if (totalCredits.credits <= 0) {
        throw new SubscriptionException({
          action: AuthorizationActions.Create,
          section: Sections.VIDEOS_PER_MONTH,
        });
      }

      return this._subscriptionService.useCredit(
        org,
        'ai_videos',
        () => this._generateVideoCore(video, org, body)
      );
    }

    // BILL_TYPE=third → Aisee billing (TODO: pending KieAI cost integration)
    return this._generateVideoCore(video, org, body);
  }

  private async _generateVideoCore(
    video: ReturnType<VideoManager['getVideoByName']>,
    org: Organization,
    body: VideoDto
  ) {
    const loadedData = await video.instance.process(
      body.output,
      body.customParams
    );

    const file = await this.storage.uploadSimple(loadedData);

    // TODO: Aisee billing for video generation — pending KieAI cost integration.
    // Once available, collect AiUsageInfo from video.instance.process() and call
    // this._aiseeCreditService.billCollectedUsages() with businessType VIDEO_GEN,
    // similar to image generation above.

    return this.saveFile(org.id, file.split('/').pop(), file);
  }

  async videoFunction(identifier: string, functionName: string, body: any) {
    const video = this._videoManager.getVideoByName(identifier);
    if (!video) {
      throw new Error(`Video with identifier ${identifier} not found`);
    }

    // @ts-ignore
    const functionToCall = video.instance[functionName];
    if (
      typeof functionToCall !== 'function' ||
      this._videoManager.checkAvailableVideoFunction(functionToCall)
    ) {
      throw new HttpException(
        `Function ${functionName} not found on video instance`,
        400
      );
    }

    return functionToCall(body);
  }
}
