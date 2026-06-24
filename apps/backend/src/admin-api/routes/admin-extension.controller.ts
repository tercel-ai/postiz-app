import {
  BadRequestException,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import AdmZip from 'adm-zip';

type Platform = 'chrome' | 'firefox';
const PLATFORMS: Platform[] = ['chrome', 'firefox'];

function settingKey(platform: Platform) {
  return `extension.${platform}`;
}

function extensionFilename(platform: Platform, version: string) {
  return `aisee-extension-${platform}-${version}.zip`;
}

@ApiTags('Admin')
@Controller('/admin/extension')
@SuperAdmin()
export class AdminExtensionController {
  constructor(private _settingsService: SettingsService) {}

  @Get('/')
  async getLatest() {
    const [chrome, firefox] = await Promise.all(
      PLATFORMS.map((p) => this._settingsService.get<Record<string, string>>(settingKey(p)))
    );
    return { chrome: chrome ?? null, firefox: firefox ?? null };
  }

  @Post('/upload/chrome')
  @UseInterceptors(FileInterceptor('file'))
  async uploadChrome(@UploadedFile() file: Express.Multer.File) {
    return this._handleUpload(file, 'chrome');
  }

  @Post('/upload/firefox')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFirefox(@UploadedFile() file: Express.Multer.File) {
    return this._handleUpload(file, 'firefox');
  }

  private async _handleUpload(file: Express.Multer.File, platform: Platform) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    if (!file.originalname.endsWith('.zip')) {
      throw new BadRequestException('Only .zip files are accepted');
    }

    const version = this._readVersionFromZip(file.buffer);

    const filename = extensionFilename(platform, version);
    const storage = UploadFactory.createStorage();
    const downloadUrl = await storage.uploadBuffer(
      `extensions/${filename}`,
      file.buffer,
      'application/zip'
    );
    const meta = { version, downloadUrl, releasedAt: new Date().toISOString() };

    await this._settingsService.set(settingKey(platform), meta, {
      type: 'object',
      description: `Latest ${platform} extension release`,
    });

    return { platform, version, downloadUrl };
  }

  private _readVersionFromZip(buffer: Buffer): string {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new BadRequestException('Invalid zip file');
    }

    const entry = zip.getEntry('manifest.json');
    if (!entry) {
      throw new BadRequestException('manifest.json not found in zip');
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(entry.getData().toString('utf8'));
    } catch {
      throw new BadRequestException('manifest.json is not valid JSON');
    }

    const version = manifest['version'];
    if (typeof version !== 'string' || !version) {
      throw new BadRequestException('manifest.json is missing the "version" field');
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new BadRequestException(`Invalid version format "${version}": expected MAJOR.MINOR.PATCH`);
    }

    return version;
  }
}
