import type { RegistryDatabase } from "./client";
import { registerProjectRows, type RegisteredProject, type SourceKind } from "./project.repo";

export async function registerProject(
  db: RegistryDatabase,
  input: { code: string; name: string; sourceKind?: SourceKind; sourceKey?: string },
): Promise<RegisteredProject> {
  return db.transaction((tx) => registerProjectRows(tx, input));
}
