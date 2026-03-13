import { Controller, Get, HttpException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AdminPostsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-posts-query.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { resolveOrganizationId } from '@gitroom/backend/admin-api/admin.utils';

@ApiTags('Admin')
@Controller('/admin/posts')
@SuperAdmin()
export class AdminPostsController {
  constructor(
    private _postsService: PostsService,
    private _organizationService: OrganizationService,
  ) {}

  @Get('/')
  async list(@Query() query: AdminPostsQueryDto) {
    const { organizationId, empty } = await resolveOrganizationId(
      this._organizationService,
      query.organizationId,
      query.userId,
    );
    if (empty) {
      return { results: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
    }
    return this._postsService.getAllPostsList({
      page: query.page,
      pageSize: query.pageSize,
      organizationId,
      state: query.state,
      integrationId: query.integrationId,
      channel: query.channel,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('/:id')
  async getById(@Param('id') id: string) {
    const post = await this._postsService.getPostByIdForAdmin(id);
    if (!post) {
      throw new HttpException('Post not found', 404);
    }
    return post;
  }
}
