import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "./mikro-orm.config";

type Direction = "up" | "down";

function parseDirection(arg: string | undefined): Direction {
  if (arg === "up" || arg === "down") {
    return arg;
  }
  throw new Error(`usage: bun run src/infrastructure/database/migrate.ts <up|down>, got "${arg ?? ""}"`);
}

async function main(): Promise<void> {
  const direction = parseDirection(process.argv[2]);
  const orm = await MikroORM.init(createOrmConfig());
  try {
    // `down` reverts only the latest migration, so each call is one reversible step.
    const executed = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
    const names = executed.map((migration) => migration.name);
    console.log(names.length > 0 ? `migrated ${direction}: ${names.join(", ")}` : `nothing to migrate ${direction}`);
  } finally {
    await orm.close();
  }
}

await main();
