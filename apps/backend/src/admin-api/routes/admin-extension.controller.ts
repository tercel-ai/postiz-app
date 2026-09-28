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

type Channel = 'prod' | 'dev';

/**
 * The name the extension's own build gives a non-production build.
 *
 * vite.config.base.ts layers manifest.dev.json over EVERY build that is not an
 * explicit `EXTENSION_ENV=production` release, and that overlay sets this name.
 * A production build keeps the base manifest's plain "Aisee" — manifest.prod.json
 * carries only the signing key. So the name in the uploaded zip IS the channel,
 * and it is the one marker present in the artifact itself.
 */
const DEV_BUILD_NAME = 'Aisee - Dev';

function detectChannel(manifestName: string | undefined): Channel {
  return manifestName?.trim() === DEV_BUILD_NAME ? 'dev' : 'prod';
}

/**
 * Dev and prod use separate databases, so both environments must keep reading
 * and writing the same browser setting keys. The channel only distinguishes
 * artifact filenames in shared object storage.
 */
function settingKey(platform: Platform) {
  return `extension.${platform}`;
}

function extensionFilename(
  platform: Platform,
  version: string,
  channel: Channel = 'prod'
) {
  const suffix = channel === 'dev' ? '-dev' : '';
  return `aisee-extension-${platform}${suffix}-${version}.zip`;
}

@ApiTags('Admin')
@Controller('/admin/extension')
@SuperAdmin()
export class AdminExtensionController {
  constructor(private _settingsService: SettingsService) {}

  @Get('/')
  async getLatest() {
    const [chrome, firefox] = await Promise.all(
      PLATFORMS.map((platform) =>
        this._settingsService.get<Record<string, string>>(settingKey(platform))
      )
    );
    return {
      chrome: chrome ?? null,
      firefox: firefox ?? null,
    };
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

    const { version, name } = this._readManifestFromZip(file.buffer);
    const channel = detectChannel(name);

    const filename = extensionFilename(platform, version, channel);
    const storage = UploadFactory.createStorage();
    const downloadUrl = await storage.uploadBuffer(
      `extensions/${filename}`,
      file.buffer,
      'application/zip'
    );
    const meta = { version, downloadUrl, releasedAt: new Date().toISOString() };

    await this._settingsService.set(settingKey(platform), meta, {
      type: 'object',
      description: `Latest ${platform} extension release (${channel})`,
    });

    return { platform, channel, version, downloadUrl };
  }

  /**
   * Reads the zip's OWN manifest — not the filename, which the uploader
   * chooses and which therefore cannot be trusted to say which build this is.
   *
   * `manifest.json` must sit at the zip ROOT: that is what Chrome's own
   * drag-to-install expects, and it is what scripts/pack.sh produces. A zip
   * that wraps the build in a folder (`zip -r out.zip dist`) fails here, which
   * is the same way it would fail to install.
   */
  private _readManifestFromZip(buffer: Buffer): {
    version: string;
    name?: string;
  } {
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

    const name = manifest['name'];
    return {
      version,
      ...(typeof name === 'string' ? { name } : {}),
    };
  }
}
