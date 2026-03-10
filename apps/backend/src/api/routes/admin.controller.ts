import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { AiPricingService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/ai-pricing.service';
import { UpdateAiPricingDto } from '@gitroom/nestjs-libraries/dtos/admin/ai-pricing.dto';

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
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'pageSize', required: false, description: 'Items per page (default 20, max 100)' })
  @ApiQuery({ name: 'keyword', required: false, description: 'Search in key and description' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by type (string, number, boolean, object, array)' })
  async listSettings(
    @GetUserFromRequest() user: User,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('type') type?: string
  ) {
    requireSuperAdmin(user);
    return this._settingsService.paginate({
      page: safePage(page),
      pageSize: safePageSize(pageSize),
      keyword,
      type,
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

  @Put('/settings/:key')
  async setSetting(
    @GetUserFromRequest() user: User,
    @Param('key') key: string,
    @Body()
    body: {
      value: unknown;
      type?: string;
      description?: string;
    }
  ) {
    requireSuperAdmin(user);
    if (body.value === undefined) {
      throw new HttpException('"value" field is required', 400);
    }
    if (RESERVED_KEYS.includes(key)) {
      throw new HttpException(
        `Setting "${key}" is managed by a dedicated API, use the corresponding endpoint instead`,
        400
      );
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

  @Put('/ai-pricing')
  async setAiPricing(
    @GetUserFromRequest() user: User,
    @Body() body: UpdateAiPricingDto
  ) {
    requireSuperAdmin(user);
    await this._aiPricingService.setPricingConfig(body);
    return { updated: true };
  }
}
