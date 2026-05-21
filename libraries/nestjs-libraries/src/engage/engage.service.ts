import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Organization } from '@prisma/client';
import { TemporalService } from 'nestjs-temporal-core';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  AddKeywordDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ListOpportunitiesDto,
  ListSentDto,
  SaveEngageConfigDto,
  ScoreStatsDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

const REDDIT_COMMENT_URL_RE =
  /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+\/[^/]+\/[a-z0-9]+\/?/i;

@Injectable()
export class EngageService {
  private readonly logger = new Logger(EngageService.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _temporalService: TemporalService
  ) {}

  // ─── Config ───────────────────────────────────────────────────────────────

  getConfig(org: Organization) {
    return this._engageRepository.getOrCreateConfig(org.id);
  }

  async saveConfig(org: Organization, dto: SaveEngageConfigDto) {
    const result = await this._engageRepository.saveConfig(org.id, dto);
    // When an org completes setup for the first time, start its per-org workflows
    if (dto.setupCompleted) {
      await this._startEngageWorkflowsForOrg(org.id);
    }
    return result;
  }

  async resetConfig(org: Organization) {
    return this._engageRepository.resetConfig(org.id);
  }

  // ─── Keywords ─────────────────────────────────────────────────────────────

  async addKeyword(org: Organization, dto: AddKeywordDto) {
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return this._engageRepository.addKeyword(config.id, org.id, dto);
  }

  async updateKeyword(org: Organization, id: string, dto: UpdateKeywordDto) {
    return this._engageRepository.updateKeyword(org.id, id, dto);
  }

  async deleteKeyword(org: Organization, id: string) {
    return this._engageRepository.deleteKeyword(org.id, id);
  }

  // ─── Monitored Channels ───────────────────────────────────────────────────

  async listMonitoredChannels(org: Organization) {
    return this._engageRepository.listMonitoredChannels(org.id);
  }

  async addMonitoredChannel(org: Organization, dto: AddMonitoredChannelDto) {
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return this._engageRepository.addMonitoredChannel(
      config.id,
      org.id,
      dto
    );
  }

  async updateMonitoredChannel(
    org: Organization,
    id: string,
    dto: UpdateMonitoredChannelDto
  ) {
    return this._engageRepository.updateMonitoredChannel(org.id, id, dto);
  }

  async removeMonitoredChannel(org: Organization, id: string) {
    return this._engageRepository.removeMonitoredChannel(org.id, id);
  }

  async searchChannels(platform: string, query: string) {
    // Platform-specific channel search stub.
    // V1: Reddit search via public API; others return empty.
    if (platform === 'reddit') {
      return this._searchRedditSubreddits(query);
    }
    return [];
  }

  // ─── Tracked Accounts ─────────────────────────────────────────────────────

  async listTrackedAccounts(org: Organization) {
    return this._engageRepository.listTrackedAccounts(org.id);
  }

  async addTrackedAccount(org: Organization, dto: AddTrackedAccountDto) {
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return this._engageRepository.addTrackedAccount(config.id, org.id, dto);
  }

  async updateTrackedAccount(
    org: Organization,
    id: string,
    dto: UpdateTrackedAccountDto
  ) {
    return this._engageRepository.updateTrackedAccount(org.id, id, dto);
  }

  async removeTrackedAccount(org: Organization, id: string) {
    return this._engageRepository.removeTrackedAccount(org.id, id);
  }

  // ─── Reply Accounts ───────────────────────────────────────────────────────

  async listReplyAccounts(org: Organization) {
    return this._engageRepository.listXIntegrationsWithReplySettings(org.id);
  }

  async updateReplyAccountSettings(
    org: Organization,
    integrationId: string,
    dto: UpdateReplyAccountDto
  ) {
    return this._engageRepository.updateReplyAccount(
      org.id,
      integrationId,
      dto
    );
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  async listOpportunities(org: Organization, dto: ListOpportunitiesDto) {
    return this._engageRepository.listOpportunities(org.id, dto);
  }

  async dismissOpportunity(org: Organization, id: string) {
    return this._engageRepository.dismissOpportunity(org.id, id);
  }

  async toggleBookmark(org: Organization, id: string) {
    return this._engageRepository.toggleBookmark(org.id, id);
  }

  async getScoreStats(org: Organization, dto: ScoreStatsDto) {
    return this._engageRepository.getScoreStats(org.id, dto.date, dto.platform);
  }

  async getOpportunityById(org: Organization, id: string) {
    return this._engageRepository.getOpportunityById(org.id, id);
  }

  async getOpportunityForReply(org: Organization, id: string) {
    return this._engageRepository.getOpportunityForReply(org.id, id);
  }

  // ─── Sent Replies ─────────────────────────────────────────────────────────

  async listSentReplies(org: Organization, dto: ListSentDto) {
    return this._engageRepository.listSentReplies(org.id, dto);
  }

  async getSentStats(org: Organization) {
    return this._engageRepository.getSentStats(org.id);
  }

  async submitManualReplyUrl(
    org: Organization,
    sentReplyId: string,
    url: string
  ) {
    if (!REDDIT_COMMENT_URL_RE.test(url)) {
      throw new BadRequestException(
        'Invalid Reddit comment URL. Expected: https://www.reddit.com/r/.../comments/.../comment/...'
      );
    }
    return this._engageRepository.updateReplyUrl(org.id, sentReplyId, url);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _searchRedditSubreddits(query: string) {
    // Calls Reddit public search; no auth required for listing subreddits.
    // Falls back to empty list on any network error.
    try {
      const url = `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(query)}&limit=10`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'AISEE-Engage/1.0' },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        data?: { children?: Array<{ data: Record<string, unknown> }> };
      };
      return (json?.data?.children ?? []).map((c) => ({
        platform: 'reddit',
        channelId: c.data.display_name as string,
        channelName: `r/${c.data.display_name as string}`,
        audienceSize: Number(c.data.subscribers ?? 0),
        metadata: {
          description: c.data.public_description,
          url: `https://reddit.com/r/${c.data.display_name}`,
        },
      }));
    } catch {
      return [];
    }
  }

  // Starts per-org Temporal workflows when setup completes.
  // USE_EXISTING policy prevents double-starting if the org re-saves config.
  private async _startEngageWorkflowsForOrg(orgId: string): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;
    for (const [workflowId, name] of [
      [`engage-scan-${orgId}`, 'engageScanWorkflow'],
      [`engage-tracked-${orgId}`, 'engageTrackedAccountsWorkflow'],
    ] as const) {
      try {
        await client.workflow?.start(name, {
          workflowId,
          taskQueue: 'main',
          args: [orgId],
          workflowIdConflictPolicy: 'USE_EXISTING',
        });
      } catch (err) {
        this.logger.error(`Failed to start ${name} for org ${orgId}:`, err);
      }
    }
  }

  // Called by engage.controller after creating an EngageSentReply to start 24h metrics sync.
  async startMetricsSyncForReply(sentReplyId: string): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;
    try {
      await client.workflow?.start('engageMetricsSyncWorkflow', {
        workflowId: `engage-metrics-${sentReplyId}`,
        taskQueue: 'main',
        args: [sentReplyId],
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
    } catch (err) {
      this.logger.warn(`Failed to start engageMetricsSyncWorkflow for reply ${sentReplyId}:`, err);
    }
  }
}
