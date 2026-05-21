import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { EngageController } from '@gitroom/backend/api/routes/engage.controller';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';

// EngageService and EngageRepository are globally available via DatabaseModule.
// This module only owns the controller and applies auth middleware to it.
@Module({
  controllers: [EngageController],
  providers: [AuthMiddleware],
})
export class EngageModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(EngageController);
  }
}
