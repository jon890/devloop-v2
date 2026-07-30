import { and, asc, eq } from "drizzle-orm";
import type { RegistryExecutor } from "./curation.repo";
import { project, source } from "./schema";

export type SourceKind = "dooray" | "github";

export interface ProjectRow {
  id: number;
  code: string;
  name: string | null;
}

export interface RegisteredProject {
  project: ProjectRow;
  projectCreated: boolean;
  sourceCreated: boolean;
}

export async function listProjects(db: RegistryExecutor): Promise<ProjectRow[]> {
  return db.select({ id: project.id, code: project.code, name: project.name }).from(project).orderBy(asc(project.code));
}

export async function selectProjectByCode(db: RegistryExecutor, code: string): Promise<ProjectRow | undefined> {
  const rows = await db.select({ id: project.id, code: project.code, name: project.name }).from(project).where(eq(project.code, code)).limit(1);
  return rows[0];
}

export async function registerProjectRows(
  db: RegistryExecutor,
  input: { code: string; name: string; sourceKind?: SourceKind; sourceKey?: string },
): Promise<RegisteredProject> {
  const insertedProjects = await db
    .insert(project)
    .values({ code: input.code, name: input.name })
    .onConflictDoNothing()
    .returning({ id: project.id, code: project.code, name: project.name });
  const projectRow = insertedProjects[0] ?? (await selectProjectByCode(db, input.code));
  if (!projectRow) {
    throw new Error(`Failed to register project ${input.code}.`);
  }

  let sourceCreated = false;
  if (input.sourceKind && input.sourceKey) {
    const insertedSources = await db
      .insert(source)
      .values({ projectId: projectRow.id, kind: input.sourceKind, externalKey: input.sourceKey })
      .onConflictDoNothing()
      .returning({ id: source.id });
    sourceCreated = insertedSources.length > 0;
    if (!sourceCreated) {
      const existingSources = await db
        .select({ projectId: source.projectId })
        .from(source)
        .where(and(eq(source.kind, input.sourceKind), eq(source.externalKey, input.sourceKey)))
        .limit(1);
      if (existingSources[0]?.projectId !== projectRow.id) {
        throw new Error(`Source ${input.sourceKind}:${input.sourceKey} is already registered to another project.`);
      }
    }
  }

  return { project: projectRow, projectCreated: insertedProjects.length > 0, sourceCreated };
}
