import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { OperationPlanController } from '@gitroom/backend/api/routes/operation-plan.controller';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { OperationPlanReconciliationService } from './operation-plan-reconciliation.service';

// OperationPlanService/Repository are globally available via DatabaseModule.
// This module only owns the controller and applies auth middleware to it —
// mirrors EngageModule.
@Module({
  controllers: [OperationPlanController],
  providers: [AuthMiddleware, OperationPlanReconciliationService],
})
export class OperationPlanModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(OperationPlanController);
  }
}
