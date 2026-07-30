import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

export type RegistryDatabase = ReturnType<typeof createRegistryDb>;

export function createRegistryPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export function createRegistryDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export function registryMigrationsPath(): string {
  return resolve(__dirname, "../migrations");
}

export async function migrateRegistryDb(pool: Pool, migrationsFolder = registryMigrationsPath()): Promise<void> {
  await migrate(createRegistryDb(pool), { migrationsFolder });
}
