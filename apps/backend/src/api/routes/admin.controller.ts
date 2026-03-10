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
import { User } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { AiPricingService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/ai-pricing.service';
import { UpdateAiPricingDto } from '@gitroom/nestjs-libraries/dtos/admin/ai-pricing.dto';
import { ListSettingsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/settings-query.dto';
import { CreateSettingDto, UpdateSettingDto } from '@gitroom/nestjs-libraries/dtos/admin/settings-body.dto';

const RESERVED_KEYS = ['ai_model_pricing'];

function requireSuperAdmin(user: User) {
  if (!user.isSuperAdmin) {
    throw new HttpException('Unauthorized: superadmin required', 403);
  }
}

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
export class AdminController {
  constructor(
    private _settingsService: SettingsService,
    private _aiPricingService: AiPricingService
  ) {}

  // ============ Settings CRUD ============

  @Get('/settings')
  async listSettings(
    @GetUserFromRequest() user: User,
    @Query() query: ListSettingsQueryDto
  ) {
    requireSuperAdmin(user);
    return this._settingsService.paginate({
      page: safePage(query.page),
      pageSize: safePageSize(query.pageSize),
      keyword: query.keyword,
      type: query.type,
    });
  }

  @Get('/settings/:key')
  async getSetting(
    @GetUserFromRequest() user: User,
    @Param('key') key: string
  ) {
    requireSuperAdmin(user);
    const value = await this._settingsService.get(key);
    if (value === null) {
      throw new HttpException(`Setting "${key}" not found`, 404);
    }
    return { key, value };
  }

  @Post('/settings')
  async createSetting(
    @GetUserFromRequest() user: User,
    @Body() body: CreateSettingDto
  ) {
    requireSuperAdmin(user);
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
    @GetUserFromRequest() user: User,
    @Param('key') key: string,
    @Body() body: UpdateSettingDto
  ) {
    requireSuperAdmin(user);
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
  async deleteSetting(
    @GetUserFromRequest() user: User,
    @Param('key') key: string
  ) {
    requireSuperAdmin(user);
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
  async getAiPricing(@GetUserFromRequest() user: User) {
    requireSuperAdmin(user);
    const config = await this._aiPricingService.getPricingConfig();
    return config || {};
  }

  @Post('/ai-pricing')
  async createAiPricing(
    @GetUserFromRequest() user: User,
    @Body() body: UpdateAiPricingDto
  ) {
    requireSuperAdmin(user);
    const existing = await this._aiPricingService.getPricingConfig();
    if (existing) {
      throw new HttpException('AI pricing config already exists, use PUT to update', 409);
    }
    await this._aiPricingService.setPricingConfig(body);
    return { created: true };
  }

  @Put('/ai-pricing')
  async updateAiPricing(
    @GetUserFromRequest() user: User,
    @Body() body: UpdateAiPricingDto
  ) {
    requireSuperAdmin(user);
    const existing = await this._aiPricingService.getPricingConfig();
    if (!existing) {
      throw new HttpException('AI pricing config not found, use POST to create', 404);
    }
    await this._aiPricingService.setPricingConfig(body);
    return { updated: true };
  }
}
