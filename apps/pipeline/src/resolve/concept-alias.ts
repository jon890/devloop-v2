import {
  conceptLookupKeys,
  INFERRED_GRAPH_FILE,
  normalizeConceptKey,
  normalizeText,
  PARSED_GRAPH_FILE,
  type ConceptDictionary,
  type ConceptEntry,
} from "@devloop/shared";
import { CONCEPT_KEY_MERGE_DENYLIST } from "./concept-alias.const";

export type ConceptSource = "llm" | "structural";
export { normalizeConceptKey, normalizeText } from "@devloop/shared";

export function buildConceptAliasMap(dictionary: ConceptDictionary, blockedConceptKeys: ReadonlySet<string> = new Set()): Map<string, ConceptEntry> {
  const aliases = new Map<string, ConceptEntry>();
  const conceptKeyOwners = new Map<string, Map<string, ConceptEntry>>();
  for (const entry of dictionary) {
    for (const name of [entry.canonical, ...entry.aliases]) {
      const exactKey = normalizeText(name);
      const exactOwner = aliases.get(exactKey);
      if (exactOwner && exactOwner.canonical !== entry.canonical) {
        throw conceptDictionaryConflict(exactKey, [exactOwner, entry]);
      }
      aliases.set(exactKey, entry);
      const conceptKey = normalizeConceptKey(name);
      if (conceptKey) {
        const owners = conceptKeyOwners.get(conceptKey) ?? new Map();
        owners.set(entry.canonical, entry);
        conceptKeyOwners.set(conceptKey, owners);
      }
    }
  }

  for (const [conceptKey, ownersByCanonical] of conceptKeyOwners) {
    if (CONCEPT_KEY_MERGE_DENYLIST.has(conceptKey) || blockedConceptKeys.has(conceptKey)) {
      continue;
    }
    const owners = [...ownersByCanonical.values()];
    const exactOwner = aliases.get(conceptKey);
    if (exactOwner) {
      aliases.set(conceptKey, exactOwner);
      continue;
    }
    if (owners.length === 1) {
      aliases.set(conceptKey, owners[0]);
      continue;
    }

    throw conceptDictionaryConflict(conceptKey, owners);
  }
  return aliases;
}

function conceptDictionaryConflict(key: string, owners: readonly ConceptEntry[]): Error {
  return new Error(
    `Concept key "${key}" has conflicting canonical entries: ` +
      `${owners.map((entry) => entry.canonical).join(", ")}. ` +
      "Merge the entries in the concept dictionary or add a registry block.",
  );
}

export function conceptEntry(value: string, aliasMap: ReadonlyMap<string, ConceptEntry>): ConceptEntry | undefined {
  return conceptLookupKeys(value)
    .map((key) => aliasMap.get(key))
    .find((candidate): candidate is ConceptEntry => candidate !== undefined);
}

export function conceptSource(sourceFile: string): ConceptSource {
  if (sourceFile === INFERRED_GRAPH_FILE) {
    return "llm";
  }
  if (sourceFile === PARSED_GRAPH_FILE) {
    return "structural";
  }
  throw new Error(`Unsupported Concept source file "${sourceFile}". ` + `Expected ${INFERRED_GRAPH_FILE} or ${PARSED_GRAPH_FILE}.`);
}
