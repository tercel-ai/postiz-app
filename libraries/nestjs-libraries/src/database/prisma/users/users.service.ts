import { Injectable, Logger } from '@nestjs/common';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { Provider } from '@prisma/client';
import { UserDetailDto } from '@gitroom/nestjs-libraries/dtos/users/user.details.dto';
import { EmailNotificationsDto } from '@gitroom/nestjs-libraries/dtos/users/email-notifications.dto';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { AiseeClient } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private _usersRepository: UsersRepository,
    private _organizationRepository: OrganizationRepository,
    private _aiseeClient: AiseeClient
  ) {}

  getUserByEmail(email: string) {
    return this._usersRepository.getUserByEmail(email);
  }

  getUserById(id: string) {
    return this._usersRepository.getUserById(id);
  }

  getImpersonateUser(name: string) {
    return this._organizationRepository.getImpersonateUser(name);
  }

  getUserByProvider(providerId: string, provider: Provider) {
    return this._usersRepository.getUserByProvider(providerId, provider);
  }

  activateUser(id: string) {
    return this._usersRepository.activateUser(id);
  }

  updatePassword(id: string, password: string) {
    return this._usersRepository.updatePassword(id, password);
  }

  getPersonal(userId: string) {
    return this._usersRepository.getPersonal(userId);
  }

  changePersonal(userId: string, body: UserDetailDto) {
    return this._usersRepository.changePersonal(userId, body);
  }

  getEmailNotifications(userId: string) {
    return this._usersRepository.getEmailNotifications(userId);
  }

  updateEmailNotifications(userId: string, body: EmailNotificationsDto) {
    return this._usersRepository.updateEmailNotifications(userId, body);
  }

  async getUserLimits(userId: string): Promise<
    | { postChannelLimit: number; postSendLimit: number }
    | { postChannelLimit: number; postSendLimit: number; periodStart: string; periodEnd: string; name: string; interval: string }
  > {
    const pkg = await this._aiseeClient.getUserCreditPackage(userId);

    // API failed or no active package — hard block
    if (pkg === null) {
      this.logger.warn(`No credit package for user=${userId}, blocking channels and posts`);
      return { postChannelLimit: 0, postSendLimit: 0 };
    }

    // Package expired or periodEnd missing — hard block
    if (!pkg.periodEnd || new Date(pkg.periodEnd) < new Date()) {
      this.logger.warn(`Credit package expired at ${pkg.periodEnd} for user=${userId}, blocking channels and posts`);
      return { postChannelLimit: 0, postSendLimit: 0 };
    }

    return {
      postChannelLimit: pkg.postChannelLimit,
      postSendLimit: pkg.postSendLimit,
      periodStart: pkg.periodStart,
      periodEnd: pkg.periodEnd,
      name: pkg.name,
      interval: pkg.interval,
    };
  }

}
