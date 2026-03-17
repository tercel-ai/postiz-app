import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { AdminSettingsController } from './routes/admin-settings.controller';
import { AdminOrganizationsController } from './routes/admin-organizations.controller';
import { AdminPostsController } from './routes/admin-posts.controller';
import { AdminIntegrationsController } from './routes/admin-integrations.controller';
import { AdminErrorsController } from './routes/admin-errors.controller';
import { AdminMediaController } from './routes/admin-media.controller';
import { AdminDashboardController } from './routes/admin-dashboard.controller';
import { AdminDiagnosticsController } from './routes/admin-diagnostics.controller';

const adminControllers = [
  AdminSettingsController,
  AdminOrganizationsController,
  AdminPostsController,
  AdminIntegrationsController,
  AdminErrorsController,
  AdminMediaController,
  AdminDashboardController,
  AdminDiagnosticsController,
];

@Module({
  controllers: [...adminControllers],
  providers: [AuthService],
  get exports() {
    return [...this.providers];
  },
})
export class AdminApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(...adminControllers);
  }
}
