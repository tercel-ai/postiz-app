import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { EngageScanConfigService } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { AiPricingService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/ai-pricing.service';
import { UpdateAiPricingDto } from '@gitroom/nestjs-libraries/dtos/admin/ai-pricing.dto';
import { ListSettingsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/settings-query.dto';
import { CreateSettingDto, UpdateSettingDto } from '@gitroom/nestjs-libraries/dtos/admin/settings-body.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';

const RESERVED_KEYS = ['ai_model_pricing'];

function safePage(val?: string): number {
  const n = val ? Number(val) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function safePageSize(val?: string): number {
  const n = val ? Number(val) : 20;
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(Math.floor(n), 100);
}

@ApiTags('Admin')
@Controller('/admin')
@SuperAdmin()
export class AdminSettingsController {
  constructor(
    private _settingsService: SettingsService,
    private _aiPricingService: AiPricingService,
    private _engageScanConfigService: EngageScanConfigService,
    private _integrationManager: IntegrationManager
  ) {}

  // ============ Social providers ============

  /**
   * GET /admin/social-providers
   *
   * The full list of registered social providers ({ identifier, name }) — the
   * single source of truth behind admin pickers such as the operation-plan
   * platform allowlist. Sourced from the provider registry so it never drifts
   * from what the backend actually implements.
   */
  @Get('/social-providers')
  listSocialProviders() {
    return this._integrationManager.getSocialProviderList();
  }

  // ============ Settings CRUD ============

  @Get('/settings')
  async listSettings(@Query() query: ListSettingsQueryDto) {
    return this._settingsService.paginate({
      page: safePage(query.page),
      pageSize: safePageSize(query.pageSize),
      keyword: query.keyword,
      type: query.type,
    });
  }

  // ============ Engage initial-scan effective budget ============
  // NOTE: must be declared before @Get('/settings/:key') so NestJS doesn't
  // swallow the literal path segment as the :key parameter.

  /**
   * GET /admin/settings/engage-initial-scan-budget
   *
   * Returns the currently effective budget values for each platform's keyword
   * initial scan, resolved through the same priority chain the orchestrator uses:
   *   admin settings DB → platform env var → generic env var → hardcoded constant
   *
   * Also returns the per-key source so the UI can show where each value came from.
   */
  @Get('/settings/engage-initial-scan-budget')
  async getEngageInitialScanBudget() {
    const PREFIX = 'engage.keyword_initial_scan.';
    const DEFAULT_MAX_UNITS = 10;
    const DEFAULT_MAX_CALLS = 5;

    const dbRows = await this._settingsService.listByPrefix(PREFIX);
    const db = new Map<string, unknown>(dbRows.map((r: any) => [r.key, r.value]));

    const resolve = (
      dbKey: string,
      envSpecific: string,
      envGeneric: string,
      fallback: number
    ): { value: number; source: 'db' | 'env' | 'default' } => {
      if (db.has(dbKey)) {
        const v = Number(db.get(dbKey));
        if (Number.isFinite(v) && v > 0) return { value: v, source: 'db' };
      }
      const fromEnv = process.env[envSpecific] ?? process.env[envGeneric];
      if (fromEnv) {
        const v = Number(fromEnv);
        if (Number.isFinite(v) && v > 0) return { value: v, source: 'env' };
      }
      return { value: fallback, source: 'default' };
    };

    const resolveShared = (
      dbKey: string,
      envGeneric: string,
      fallback: number
    ): { value: number; source: 'db' | 'env' | 'default' } => {
      if (db.has(dbKey)) {
        const v = Number(db.get(dbKey));
        if (Number.isFinite(v) && v > 0) return { value: v, source: 'db' };
      }
      const fromEnv = process.env[envGeneric];
      if (fromEnv) {
        const v = Number(fromEnv);
        if (Number.isFinite(v) && v > 0) return { value: v, source: 'env' };
      }
      return { value: fallback, source: 'default' };
    };

    // Resolved through the same allowlist the scan task-producer uses:
    // settings.operation_plan.allowed_platforms || ENGAGE_SUPPORTED_PLATFORMS.
    const platforms = await this._engageScanConfigService.getSupportedScanPlatforms();
    const result: Record<string, any> = {};
    for (const platform of platforms) {
      const envPrefix = platform.toUpperCase();
      result[platform] = {
        maxUnits: resolve(
          `${PREFIX}${platform}.max_units`,
          `ENGAGE_${envPrefix}_KEYWORD_INITIAL_SCAN_MAX_UNITS`,
          'ENGAGE_KEYWORD_INITIAL_SCAN_MAX_UNITS',
          DEFAULT_MAX_UNITS
        ),
        maxCalls: resolve(
          `${PREFIX}${platform}.max_calls`,
          `ENGAGE_${envPrefix}_KEYWORD_INITIAL_SCAN_MAX_CALLS`,
          'ENGAGE_KEYWORD_INITIAL_SCAN_MAX_CALLS',
          DEFAULT_MAX_CALLS
        ),
      };
    }

    return {
      platforms: result,
      shared: {
        lookbackHours: resolveShared(`${PREFIX}lookback_hours`, 'ENGAGE_KEYWORD_INITIAL_SCAN_LOOKBACK_HOURS', 24),
        maxAttempts:   resolveShared(`${PREFIX}max_attempts`,   'ENGAGE_KEYWORD_INITIAL_SCAN_MAX_ATTEMPTS',   3),
        retryMs:       resolveShared(`${PREFIX}retry_ms`,       'ENGAGE_KEYWORD_INITIAL_SCAN_RETRY_MS',       900_000),
        staleMs:       resolveShared(`${PREFIX}stale_ms`,       'ENGAGE_KEYWORD_INITIAL_SCAN_STALE_MS',       1_800_000),
      },
      // Pagination pacing (page caps + inter-page/inter-unit delays + jitter +
      // per-session cap), split by workflow vs extension path. Stored under the
      // `engage_scan_pacing` settings key; edit it via PUT /admin/settings/:key.
      pacing: await this._engageScanConfigService.getPacing(),
      // Per-call page size for X keyword scans (X `max_results`), with its source.
      // Stored under the `engage.keyword_x_scan_max_results` settings key; edit it
      // via PUT /admin/settings/:key. Clamped to X's valid [10, 100] range.
      xScanMaxResults: await this._engageScanConfigService.resolveXScanMaxResults(),
    };
  }

  @Get('/settings/:key')
  async getSetting(@Param('key') key: string) {
    const value = await this._settingsService.get(key);
    if (value === null) {
      throw new HttpException(`Setting "${key}" not found`, 404);
    }
    return { key, value };
  }

  @Post('/settings')
  async createSetting(@Body() body: CreateSettingDto) {
    if (RESERVED_KEYS.includes(body.key)) {
      throw new HttpException(
        `Setting "${body.key}" is managed by a dedicated API, use the corresponding endpoint instead`,
        400
      );
    }
    const existing = await this._settingsService.get(body.key);
    if (existing !== null) {
      throw new HttpException(`Setting "${body.key}" already exists, use PUT to update`, 409);
    }
    await this._settingsService.set(body.key, body.value, {
      type: body.type,
      description: body.description,
    });
    return { key: body.key, created: true };
  }

  @Put('/settings/:key')
  async updateSetting(
    @Param('key') key: string,
    @Body() body: UpdateSettingDto
  ) {
    if (RESERVED_KEYS.includes(key)) {
      throw new HttpException(
        `Setting "${key}" is managed by a dedicated API, use the corresponding endpoint instead`,
        400
      );
    }
    const existing = await this._settingsService.get(key);
    if (existing === null) {
      throw new HttpException(`Setting "${key}" not found, use POST to create`, 404);
    }
    await this._settingsService.set(key, body.value, {
      type: body.type,
      description: body.description,
    });
    return { key, updated: true };
  }

  @Delete('/settings/:key')
  async deleteSetting(@Param('key') key: string) {
    if (RESERVED_KEYS.includes(key)) {
      throw new HttpException(
        `Setting "${key}" is managed by a dedicated API and cannot be deleted here`,
        400
      );
    }
    const deleted = await this._settingsService.delete(key);
    if (!deleted) {
      throw new HttpException(`Setting "${key}" not found`, 404);
    }
    return { key, deleted: true };
  }

  // ============ AI Pricing ============

  @Get('/ai-pricing')
  async getAiPricing() {
    const config = await this._aiPricingService.getPricingConfig();
    return config || {};
  }

  @Post('/ai-pricing')
  async createAiPricing(@Body() body: UpdateAiPricingDto) {
    const existing = await this._aiPricingService.getPricingConfig();
    if (existing) {
      throw new HttpException('AI pricing config already exists, use PUT to update', 409);
    }
    await this._aiPricingService.setPricingConfig(body);
    return { created: true };
  }

  @Put('/ai-pricing')
  async updateAiPricing(@Body() body: UpdateAiPricingDto) {
    const existing = await this._aiPricingService.getPricingConfig();
    if (!existing) {
      throw new HttpException('AI pricing config not found, use POST to create', 404);
    }
    await this._aiPricingService.setPricingConfig(body);
    return { updated: true };
  }
}
