import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CORE_CONCEPTS,
  ConceptDictionarySchema,
  normalizeConceptKey,
  type ConceptDictionary,
  type ConceptEntry,
  type ConceptKind,
} from "@devloop/shared";
import { readCuration, type Curation } from "@devloop/registry";
import type { PipelineConfig } from "../config";
import { withRegistryDb } from "../registry/client";

export interface ConceptCuration {
  merges: Curation["merges"];
  blocks: Curation["blocks"];
}

export interface CuratedConceptDictionary {
  dictionary: ConceptDictionary;
  blockedConceptKeys: ReadonlySet<string>;
  judgedAliasKeys: ReadonlySet<string>;
  decisionCount: number;
}

export async function readConceptCuration(config: PipelineConfig | undefined, project: string, command: string): Promise<ConceptCuration> {
  if (!config) {
    return { merges: [], blocks: [] };
  }
  const curation = await withRegistryDb(config, command, ({ db }) => readCuration(db, project));
  return { merges: curation.merges, blocks: curation.blocks };
}

export async function loadConceptDictionary(
  dataDir: string,
  project: string,
  curation: ConceptCuration = { merges: [], blocks: [] },
): Promise<CuratedConceptDictionary> {
  const generated = await readGeneratedConceptDictionary(dataDir, project);
  return composeConceptDictionary(generated, curation);
}

async function readGeneratedConceptDictionary(dataDir: string, project: string): Promise<ConceptDictionary> {
  const dictionaryPath = path.join(dataDir, "concepts", `${project}.json`);
  try {
    const raw = await readFile(dictionaryPath, "utf8");
    return ConceptDictionarySchema.parse([...CORE_CONCEPTS, ...JSON.parse(raw)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ConceptDictionarySchema.parse(CORE_CONCEPTS);
    }
    throw error;
  }
}

export function composeConceptDictionary(
  generated: ConceptDictionary,
  curation: ConceptCuration,
  options: { fallbackKind?: (canonical: string) => ConceptKind } = {},
): CuratedConceptDictionary {
  const decisionCount = curation.merges.reduce((sum, merge) => sum + merge.aliases.length, 0) + curation.blocks.length;
  const blockedConceptKeys = new Set(curation.blocks.map((block) => normalizeConceptKey(block.key)).filter(Boolean));
  const judgedAliasKeys = new Set(curation.merges.flatMap((merge) => merge.aliases.map((alias) => normalizeConceptKey(alias))).filter(Boolean));
  if (decisionCount === 0) {
    return { dictionary: ConceptDictionarySchema.parse(generated), blockedConceptKeys, judgedAliasKeys, decisionCount };
  }

  const entries = new Map<string, ConceptEntry>();
  for (const entry of generated) {
    if (judgedAliasKeys.has(normalizeConceptKey(entry.canonical))) {
      continue;
    }
    mergeEntry(entries, entry);
  }

  for (const merge of curation.merges) {
    const existing = entries.get(merge.canonical);
    mergeEntry(entries, {
      canonical: merge.canonical,
      kind: existing?.kind ?? options.fallbackKind?.(merge.canonical) ?? "type",
      aliases: merge.aliases,
    });
  }

  return {
    dictionary: ConceptDictionarySchema.parse([...entries.values()].map(sortEntryAliases).sort(compareEntries)),
    blockedConceptKeys,
    judgedAliasKeys,
    decisionCount,
  };
}

function mergeEntry(entries: Map<string, ConceptEntry>, entry: ConceptEntry): void {
  const existing = entries.get(entry.canonical);
  if (!existing) {
    entries.set(entry.canonical, { canonical: entry.canonical, kind: entry.kind, aliases: [...new Set(entry.aliases)] });
    return;
  }
  entries.set(entry.canonical, {
    canonical: existing.canonical,
    kind: existing.kind,
    aliases: [...new Set([...existing.aliases, ...entry.aliases])],
  });
}

function sortEntryAliases(entry: ConceptEntry): ConceptEntry {
  return {
    ...entry,
    aliases: [...entry.aliases].sort(compareConceptNames),
  };
}

function compareEntries(left: ConceptEntry, right: ConceptEntry): number {
  return compareConceptNames(left.canonical, right.canonical);
}

function compareConceptNames(left: string, right: string): number {
  return compareCodePoints(normalizeConceptKey(left), normalizeConceptKey(right)) || compareCodePoints(left, right);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
