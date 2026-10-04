import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import type { MikroORM } from "@mikro-orm/postgresql";
import { TEST_DB_NAME, initTestOrm, resetDatabase } from "./support/database";
import { countLedgerEntries, expectLedgerConsistent, waitFor, walletBalance } from "./support/fixtures";

const PORTS = [3301, 3302, 3303];

function startInstance(port: number): Subprocess {
  return Bun.spawn(["bun", "run", "src/main.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_NAME: TEST_DB_NAME,
      LOG_LEVEL: "error",
      // Only the HTTP path and the database are exercised here; keep the shared queues untouched.
      SQS_CONSUMER_ENABLED: "false",
      OUTBOX_PUBLISHER_ENABLED: "false",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitUntilLive(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      return (await fetch(`http://localhost:${port}/health/live`)).ok;
    } catch {
      return false;
    }
  }, 30_000, 200);
}

async function post(port: number, path: string, body: unknown, idempotencyKey?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function bet(walletId: string, playerId: string, externalTransactionId: string, amount: string) {
  return {
    providerId: "provider-a",
    externalTransactionId,
    playerId,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

describe("three application instances against one database", () => {
  let orm: MikroORM;
  const instances = new Map<number, Subprocess>();

  beforeAll(async () => {
    orm = await initTestOrm();
    await resetDatabase(orm);
    for (const port of PORTS) {
      instances.set(port, startInstance(port));
    }
    await Promise.all(PORTS.map(waitUntilLive));
  }, 60_000);

  afterAll(async () => {
    for (const instance of instances.values()) {
      instance.kill();
    }
    await orm.close();
  });

  async function createWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
    const playerId = crypto.randomUUID();
    const { json } = await post(PORTS[0] ?? 3301, "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
    return { walletId: String(json.id), playerId };
  }

  it("keeps the 100/80/80 invariant when the two BETs hit different instances", async () => {
    const { walletId, playerId } = await createWallet("100.00");

    const responses = await Promise.all([
      post(3301, "/wagering/transactions", bet(walletId, playerId, "bet-a", "80.00"), "provider-a:bet-a"),
      post(3302, "/wagering/transactions", bet(walletId, playerId, "bet-b", "80.00"), "provider-a:bet-b"),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(await walletBalance(orm, walletId)).toBe("20.00");
    expect(await countLedgerEntries(orm, walletId, "DEBIT")).toBe(1);
    await expectLedgerConsistent(orm, walletId);
  });

  it("applies one BET exactly once when its duplicates are spread over all instances", async () => {
    const { walletId, playerId } = await createWallet("100.00");
    const payload = bet(walletId, playerId, "bet-dup", "25.00");

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post(PORTS[i % PORTS.length] ?? 3301, "/wagering/transactions", payload, "provider-a:bet-dup")),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.json.idempotentReplay === false)).toHaveLength(1);
    expect(await walletBalance(orm, walletId)).toBe("75.00");
    await expectLedgerConsistent(orm, walletId);
  });

  it("stays consistent when an instance is killed mid-load and another one is started", async () => {
    const { walletId, playerId } = await createWallet("100.00");
    const burst = (prefix: string, ports: number[]) =>
      Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          post(ports[i % ports.length] ?? 3301, "/wagering/transactions", bet(walletId, playerId, `${prefix}-${i}`, "3.00"), `provider-a:${prefix}-${i}`),
        ),
      );

    const inFlight = burst("before-crash", PORTS);
    instances.get(3303)?.kill(9);
    await inFlight;

    instances.set(3303, startInstance(3303));
    await waitUntilLive(3303);
    await burst("after-restart", PORTS);

    // Whatever the crash interrupted either fully committed or fully rolled back.
    const debits = await countLedgerEntries(orm, walletId, "DEBIT");
    const expected = (100 - debits * 3).toFixed(2);
    expect(await walletBalance(orm, walletId)).toBe(expected);
    await expectLedgerConsistent(orm, walletId);
  }, 60_000);
});
