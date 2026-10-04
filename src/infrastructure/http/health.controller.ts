import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { WAGER_TRANSACTIONS_QUEUE } from "../messaging/sqs.module";

type CheckStatus = "up" | "down";

interface ReadinessReport {
  status: "ok" | "unavailable";
  checks: { postgres: CheckStatus; sqs: CheckStatus };
}

@Controller("health")
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
  ) {}

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: { status(code: number): unknown }): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const report: ReadinessReport = {
      status: postgres === "up" && sqs === "up" ? "ok" : "unavailable",
      checks: { postgres, sqs },
    };
    response.status(report.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  private async checkPostgres(): Promise<CheckStatus> {
    try {
      await this.orm.em.getConnection().execute("select 1");
      return "up";
    } catch {
      return "down";
    }
  }

  private async checkSqs(): Promise<CheckStatus> {
    try {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE }));
      return "up";
    } catch {
      return "down";
    }
  }
}
