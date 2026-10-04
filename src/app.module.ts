import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { CreateWallet } from "./application/create-wallet";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { ReconcileWallet } from "./application/reconcile-wallet";
import { RetryPendingReferences } from "./application/retry-pending-references";
import { WalletQueries } from "./application/wallet-queries";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { AuthGuard } from "./infrastructure/http/auth.guard";
import { HealthController } from "./infrastructure/http/health.controller";
import { HttpExceptionFilter } from "./infrastructure/http/http-exception.filter";
import { MetricsController } from "./infrastructure/http/metrics.controller";
import { WageringController } from "./infrastructure/http/wagering.controller";
import { WalletsController } from "./infrastructure/http/wallets.controller";
import { OUTBOX_TARGET_QUEUE, OutboxPublisher, defaultOutboxTargetQueue } from "./infrastructure/messaging/outbox-publisher";
import { QueueUrlResolver } from "./infrastructure/messaging/queue-url.resolver";
import { SqsModule } from "./infrastructure/messaging/sqs.module";
import {
  WAGER_QUEUE_CONFIG,
  WagerQueueConsumer,
  defaultWagerQueueConfig,
} from "./infrastructure/messaging/wager-queue.consumer";

@Module({
  imports: [DatabaseModule, SqsModule],
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    AuthGuard,
    QueueUrlResolver,
    CreateWallet,
    ProcessWagerTransaction,
    WalletQueries,
    ReconcileWallet,
    RetryPendingReferences,
    OutboxPublisher,
    { provide: OUTBOX_TARGET_QUEUE, useValue: defaultOutboxTargetQueue },
    WagerQueueConsumer,
    { provide: WAGER_QUEUE_CONFIG, useValue: defaultWagerQueueConfig },
  ],
})
export class AppModule {}
