import { logger } from "../observability/logger";

export class PollingLoop {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    private readonly idleMs: number,
    private readonly tick: () => Promise<number>,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.runOnce();
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    let processed = 0;
    try {
      processed = await this.tick();
    } catch (error) {
      logger.error({ worker: this.name, err: error }, "worker tick failed");
    }
    if (this.running) {
      this.schedule(processed > 0 ? 0 : this.idleMs);
    }
  }
}
