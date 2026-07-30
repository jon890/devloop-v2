import "reflect-metadata";
import { createRegistryPool, migrateRegistryDb } from "@devloop/registry";
import { type PipelineConfig, withPipelineConfig } from "../config";

export function requireRegistryDatabaseUrl(config: PipelineConfig, command: string): string {
  const databaseUrl = config.registry.databaseUrl;
  if (!databaseUrl) {
    throw new Error(`${command} requires REGISTRY_DATABASE_URL.`);
  }
  return databaseUrl;
}

export function maskDatabaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.username = url.username ? "***" : "";
  url.password = url.password ? "***" : "";
  return url.toString();
}

export async function migrateRegistry(config: PipelineConfig): Promise<number> {
  const databaseUrl = requireRegistryDatabaseUrl(config, "migrate-registry");
  const pool = createRegistryPool(databaseUrl);

  try {
    const before = await countAppliedMigrations(pool);
    await migrateRegistryDb(pool);
    const after = await countAppliedMigrations(pool);
    const applied = after - before;
    console.log(`Applied ${applied} registry migrations to ${maskDatabaseUrl(databaseUrl)}.`);
    return applied;
  } finally {
    await pool.end();
  }
}

async function countAppliedMigrations(pool: ReturnType<typeof createRegistryPool>): Promise<number> {
  const result = await pool.query<{ count: string }>(`
    select count(*)::text as count
    from information_schema.tables
    where table_schema = 'drizzle'
      and table_name = '__drizzle_migrations'
  `);
  if (result.rows[0]?.count === "0") return 0;

  const migrations = await pool.query<{ count: string }>("select count(*)::text as count from drizzle.__drizzle_migrations");
  return Number(migrations.rows[0]?.count ?? 0);
}

if (require.main === module) {
  void withPipelineConfig((config) => migrateRegistry(config)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
