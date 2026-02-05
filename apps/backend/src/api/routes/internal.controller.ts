import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { InternalAuthGuard } from '@gitroom/backend/services/auth/internal-auth.guard';

class CreateInternalUserDto {
  id: string;
  email: string;
  name?: string;
}

@ApiTags('Internal')
@Controller('internal')
@UseGuards(InternalAuthGuard)
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    private _organizationService: OrganizationService,
    private _userService: UsersService
  ) {}

  @Post('/users')
  @HttpCode(200)
  async createUser(@Body() body: CreateInternalUserDto) {
    this.logger.log(
      `Internal callback: creating local user id=${body.id}, email=${body.email}`
    );

    // Idempotent: if user already exists, return success
    const existingUser = await this._userService.getUserById(body.id);
    if (existingUser) {
      this.logger.log(
        `Internal callback: user already exists, userId=${existingUser.id}`
      );
      return { success: true, userId: existingUser.id };
    }

    const result = await this._organizationService.createOrgAndUserWithId(
      body.id,
      body.email,
      body.name
    );

    this.logger.log(
      `Internal callback: local user created, userId=${result.users[0].user.id}`
    );

    return { success: true, userId: result.users[0].user.id };
  }
}
