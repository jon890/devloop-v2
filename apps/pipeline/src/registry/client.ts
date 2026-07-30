import { createRegistryDb, createRegistryPool, migrateRegistryDb } from "@devloop/registry";
import type { PipelineConfig } from "../config";
import { maskDatabaseUrl, requireRegistryDatabaseUrl } from "./migrate";

export async function withRegistryDb<T>(
  config: PipelineConfig,
  command: string,
  run: (context: { db: ReturnType<typeof createRegistryDb>; databaseUrl: string; maskedDatabaseUrl: string }) => Promise<T>,
): Promise<T> {
  const databaseUrl = requireRegistryDatabaseUrl(config, command);
  const maskedDatabaseUrl = maskDatabaseUrl(databaseUrl);
  const pool = createRegistryPool(databaseUrl);
  try {
    await migrateRegistryDb(pool);
    return await run({ db: createRegistryDb(pool), databaseUrl, maskedDatabaseUrl });
  } finally {
    await pool.end();
  }
}
