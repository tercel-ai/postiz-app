import { BadRequestException, Injectable } from '@nestjs/common';
import { SEND_ACCOUNT_POLICY_KEY } from '../../../extension/send-policy.constants';
import { SEND_MODE_SYSTEM_KEY, SEND_MODE_ORGANIZATION_PREFIX } from '../../../extension/send-mode.service';
import { SettingsRepository } from './settings.repository';

@Injectable()
export class SettingsService {
  constructor(private _settingsRepository: SettingsRepository) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    return this._settingsRepository.getValue<T>(key);
  }

  async set(
    key: string,
    value: unknown,
    options?: {
      type?: string;
      required?: boolean;
      description?: string;
      defaultValue?: unknown;
    }
  ) {
    if (key === SEND_ACCOUNT_POLICY_KEY) throw new BadRequestException('SEND_POLICY_MANAGED_SEPARATELY');
    if (key === SEND_MODE_SYSTEM_KEY || key.startsWith(SEND_MODE_ORGANIZATION_PREFIX)) throw new BadRequestException('SEND_MODE_MANAGED_SEPARATELY');
    return this._settingsRepository.set(key, value, options);
  }

  async delete(key: string) {
    if (key === SEND_ACCOUNT_POLICY_KEY) throw new BadRequestException('SEND_POLICY_MANAGED_SEPARATELY');
    if (key === SEND_MODE_SYSTEM_KEY || key.startsWith(SEND_MODE_ORGANIZATION_PREFIX)) throw new BadRequestException('SEND_MODE_MANAGED_SEPARATELY');
    return this._settingsRepository.delete(key);
  }

  async listByPrefix(prefix: string) {
    return this._settingsRepository.listByPrefix(prefix);
  }

  async paginate(options: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    type?: string;
  }) {
    return this._settingsRepository.paginate({
      page: options.page || 1,
      pageSize: options.pageSize || 20,
      keyword: options.keyword,
      type: options.type,
    });
  }
}
