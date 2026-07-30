import { asc, eq, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";
import { conceptDecision } from "./schema";

export type RegistryExecutor = NodePgDatabase<typeof schema> | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type DecisionKind = "merge_alias" | "block";

export interface DecisionRow {
  id: number;
  projectId: number;
  keyRaw: string;
  keyNorm: string;
  kind: DecisionKind;
  canonical: string | null;
  reason: string;
  approvedAt: string | null;
}

export interface NewDecisionRow {
  projectId: number;
  keyRaw: string;
  keyNorm: string;
  kind: DecisionKind;
  canonical?: string | null;
  reason: string;
  approvedAt?: string | null;
}

/**
 * Returns rows sorted by canonical, then key_norm for deterministic export and downstream dictionary synthesis.
 */
export async function selectDecisions(db: RegistryExecutor, projectId: number): Promise<DecisionRow[]> {
  const rows = await db
    .select()
    .from(conceptDecision)
    .where(eq(conceptDecision.projectId, projectId))
    .orderBy(asc(conceptDecision.canonical), asc(conceptDecision.keyNorm));
  return rows.map((row) => ({ ...row, kind: parseDecisionKind(row.kind) }));
}

export async function insertDecisions(db: RegistryExecutor, rows: NewDecisionRow[]): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insert(conceptDecision)
    .values(rows)
    .onConflictDoUpdate({
      target: [conceptDecision.projectId, conceptDecision.keyNorm],
      set: {
        keyRaw: sql`excluded.key_raw`,
        kind: sql`excluded.kind`,
        canonical: sql`excluded.canonical`,
        reason: sql`excluded.reason`,
        approvedAt: sql`excluded.approved_at`,
      },
    });
}

export async function deleteDecisionsByProject(db: RegistryExecutor, projectId: number): Promise<number> {
  const deleted = await db.delete(conceptDecision).where(eq(conceptDecision.projectId, projectId)).returning({ id: conceptDecision.id });
  return deleted.length;
}

function parseDecisionKind(kind: string): DecisionKind {
  if (kind === "merge_alias" || kind === "block") return kind;
  throw new Error(`Unsupported concept decision kind: ${kind}`);
}
