import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { NestPinoLogger, logger } from "./infrastructure/observability/logger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new NestPinoLogger() });
  app.useBodyParser("json", { limit: "16kb" });
  app.enableShutdownHooks();
  process.once("SIGTERM", () => logger.info("SIGTERM received, shutting down"));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.info({ port }, "wagering processor started");
}

void bootstrap();
