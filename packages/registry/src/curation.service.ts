import { normalizeConceptKey } from "@devloop/shared";
import type { RegistryDatabase } from "./client";
import type { Curation, CurationMerge } from "./curation.schema";
import { deleteDecisionsByProject, insertDecisions, selectDecisions, type DecisionRow, type NewDecisionRow } from "./curation.repo";
import { listProjects, selectProjectByCode, type ProjectRow } from "./project.repo";

export interface RejectedDecision {
  key: string;
  keyNorm: string;
  reason: string;
}

export interface WriteResult {
  project: string;
  applied: { merges: number; blocks: number };
  skipped: { unchanged: number };
  rejected: RejectedDecision[];
}

export class MissingProjectError extends Error {
  constructor(
    readonly project: string,
    readonly registeredProjects: readonly ProjectRow[],
  ) {
    super(`Project "${project}" is not registered. Registered projects: ${registeredProjects.map((item) => item.code).join(", ") || "(none)"}`);
  }
}

interface PreparedInput {
  projectId: number;
  rows: NewDecisionRow[];
  rejected: RejectedDecision[];
}

export async function readCuration(db: RegistryDatabase, projectCode: string): Promise<Curation> {
  const project = await requireProject(db, projectCode);
  return decisionsToCuration(project.code, await selectDecisions(db, project.id));
}

export async function upsertCuration(db: RegistryDatabase, projectCode: string, input: Curation): Promise<WriteResult> {
  const prepared = await prepareInput(db, projectCode, input);
  const existing = await selectDecisions(db, prepared.projectId);
  const rows = changedRows(prepared.rows, existing);
  const unchanged = prepared.rows.length - rows.length;

  await db.transaction(async (tx) => {
    await insertDecisions(tx, rows);
  });

  return writeResult(projectCode, rows, unchanged, prepared.rejected);
}

export async function replaceCuration(db: RegistryDatabase, projectCode: string, input: Curation): Promise<WriteResult> {
  const prepared = await prepareInput(db, projectCode, input);

  await db.transaction(async (tx) => {
    await deleteDecisionsByProject(tx, prepared.projectId);
    await insertDecisions(tx, prepared.rows);
  });

  return writeResult(projectCode, prepared.rows, 0, prepared.rejected);
}

export async function previewCurationWrite(
  db: RegistryDatabase,
  projectCode: string,
  input: Curation,
  mode: "upsert" | "replace",
): Promise<WriteResult> {
  const prepared = await prepareInput(db, projectCode, input);
  if (mode === "replace") {
    return writeResult(projectCode, prepared.rows, 0, prepared.rejected);
  }

  const existing = await selectDecisions(db, prepared.projectId);
  const rows = changedRows(prepared.rows, existing);
  return writeResult(projectCode, rows, prepared.rows.length - rows.length, prepared.rejected);
}

async function prepareInput(db: RegistryDatabase, projectCode: string, input: Curation): Promise<PreparedInput> {
  if (input.project !== projectCode) {
    throw new Error(`Input project "${input.project}" does not match --project ${projectCode}.`);
  }

  const project = await requireProject(db, projectCode);
  const rows: NewDecisionRow[] = [];
  const rejected: RejectedDecision[] = [];
  const seen = new Map<string, { key: string; canonical: string | null }>();

  for (const merge of input.merges) {
    for (const alias of merge.aliases) {
      const row = mergeRow(project.id, merge, alias);
      if (rejectDuplicate(row, seen, rejected)) continue;
      rows.push(row);
    }
  }

  for (const block of input.blocks) {
    const row: NewDecisionRow = {
      projectId: project.id,
      keyRaw: block.key,
      keyNorm: normalizeConceptKey(block.key),
      kind: "block",
      canonical: null,
      reason: block.reason,
      approvedAt: null,
    };
    if (rejectDuplicate(row, seen, rejected)) continue;
    rows.push(row);
  }

  return { projectId: project.id, rows, rejected };
}

async function requireProject(db: RegistryDatabase, code: string): Promise<ProjectRow> {
  const row = await selectProjectByCode(db, code);
  if (row) return row;
  throw new MissingProjectError(code, await listProjects(db));
}

function mergeRow(projectId: number, merge: CurationMerge, alias: string): NewDecisionRow {
  return {
    projectId,
    keyRaw: alias,
    keyNorm: normalizeConceptKey(alias),
    kind: "merge_alias",
    canonical: merge.canonical,
    reason: merge.reason,
    approvedAt: merge.approvedAt ?? null,
  };
}

function rejectDuplicate(row: NewDecisionRow, seen: Map<string, { key: string; canonical: string | null }>, rejected: RejectedDecision[]): boolean {
  const owner = seen.get(row.keyNorm);
  if (!owner) {
    seen.set(row.keyNorm, { key: row.keyRaw, canonical: row.canonical ?? null });
    return false;
  }

  const reason =
    owner.canonical && row.canonical && owner.canonical !== row.canonical
      ? `Alias duplicates key_norm "${row.keyNorm}" under two canonical values: ${owner.canonical}, ${row.canonical}.`
      : `Duplicate key_norm "${row.keyNorm}" in input.`;
  rejected.push({ key: row.keyRaw, keyNorm: row.keyNorm, reason });
  return true;
}

function changedRows(rows: readonly NewDecisionRow[], existing: readonly DecisionRow[]): NewDecisionRow[] {
  const existingByKey = new Map(existing.map((row) => [row.keyNorm, row]));
  return rows.filter((row) => {
    const current = existingByKey.get(row.keyNorm);
    return !current || !sameDecision(row, current);
  });
}

function sameDecision(input: NewDecisionRow, current: DecisionRow): boolean {
  return (
    input.keyRaw === current.keyRaw &&
    input.keyNorm === current.keyNorm &&
    input.kind === current.kind &&
    (input.canonical ?? null) === current.canonical &&
    input.reason === current.reason &&
    (input.approvedAt ?? null) === current.approvedAt
  );
}

function writeResult(project: string, rows: readonly NewDecisionRow[], unchanged: number, rejected: readonly RejectedDecision[]): WriteResult {
  return {
    project,
    applied: {
      merges: rows.filter((row) => row.kind === "merge_alias").length,
      blocks: rows.filter((row) => row.kind === "block").length,
    },
    skipped: { unchanged },
    rejected: [...rejected],
  };
}

function decisionsToCuration(projectCode: string, rows: readonly DecisionRow[]): Curation {
  const merges = new Map<string, { canonical: string; aliases: string[]; reason: string; approvedAt?: string }>();
  const blocks: Curation["blocks"] = [];

  for (const row of rows) {
    if (row.kind === "block") {
      blocks.push({ key: row.keyRaw, reason: row.reason });
      continue;
    }

    if (!row.canonical) {
      throw new Error(`merge_alias row ${row.id} is missing canonical.`);
    }
    const key = JSON.stringify([row.canonical, row.reason, row.approvedAt]);
    const merge = merges.get(key) ?? {
      canonical: row.canonical,
      aliases: [],
      reason: row.reason,
      ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
    };
    merge.aliases.push(row.keyRaw);
    merges.set(key, merge);
  }

  return {
    project: projectCode,
    merges: [...merges.values()].map((merge) => ({ ...merge, aliases: merge.aliases.sort(compareConceptKey) })).sort(compareMerge),
    blocks: blocks.sort((left, right) => compareCodePoints(normalizeConceptKey(left.key), normalizeConceptKey(right.key))),
  };
}

function compareMerge(left: CurationMerge, right: CurationMerge): number {
  return (
    compareCodePoints(left.canonical, right.canonical) ||
    compareCodePoints(left.reason, right.reason) ||
    compareCodePoints(left.approvedAt ?? "", right.approvedAt ?? "")
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareConceptKey(left: string, right: string): number {
  return compareCodePoints(normalizeConceptKey(left), normalizeConceptKey(right)) || compareCodePoints(left, right);
}
