import { Module } from "@nestjs/common";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { HealthController } from "./infrastructure/http/health.controller";
import { SqsModule } from "./infrastructure/messaging/sqs.module";

@Module({
  imports: [DatabaseModule, SqsModule],
  controllers: [HealthController],
})
export class AppModule {}
