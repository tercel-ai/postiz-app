import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';

@Injectable()
export class SendModeTransitionReconciliationService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(
    SendModeTransitionReconciliationService.name
  );
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly modes: SendModeService) {}

  onApplicationBootstrap(): void {
    const run = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.modes.reconcilePendingTransitions();
      } catch (error) {
        this.logger.error(
          'Sending mode transition reconciliation failed',
          error instanceof Error ? error.stack : error
        );
      } finally {
        this.running = false;
      }
    };
    void run();
    this.timer = setInterval(() => void run(), 15_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
