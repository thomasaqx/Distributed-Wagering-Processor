import { Controller, Get, Header } from "@nestjs/common";
import { metricsRegistry } from "../observability/metrics";

@Controller("metrics")
export class MetricsController {
  @Get()
  @Header("Content-Type", metricsRegistry.contentType)
  scrape(): Promise<string> {
    return metricsRegistry.metrics();
  }
}
