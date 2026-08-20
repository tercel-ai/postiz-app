import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AutomationController } from '@gitroom/backend/api/routes/automation.controller';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';

// AutomationService is globally available via DatabaseModule. This module only
// owns the controller and applies auth middleware to it — mirrors EngageModule
// and OperationPlanModule.
@Module({
  controllers: [AutomationController],
  providers: [AuthMiddleware],
})
export class AutomationModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(AutomationController);
  }
}
