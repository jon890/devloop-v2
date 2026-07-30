import {
  NODE_KEY_PROPERTIES,
  PARSED_GRAPH_FILE,
  type ConceptEntry,
  type NodeLabel,
  type OntologyNode,
  type OntologyRelationship,
} from "@devloop/shared";
import { CONCEPT_KEY_MERGE_DENYLIST, CONCEPT_LABEL } from "./concept-alias.const";
import { conceptEntry, conceptSource, normalizeConceptKey, normalizeText, type ConceptSource } from "./concept-alias";

export interface NodeRef {
  label: NodeLabel;
  key: string;
}

export function buildUnmatchedConceptRepresentatives(
  inputNodes: readonly OntologyNode[],
  inputRelationships: readonly OntologyRelationship[],
  aliasMap: ReadonlyMap<string, ConceptEntry>,
  nodeSources?: readonly string[],
  blockedConceptKeys: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const groups = new Map<string, Map<string, { occurrences: number; referenceKey: string }>>();

  inputNodes.forEach((node, index) => {
    addUnmatchedConceptCandidate(groups, node, aliasMap, nodeSources?.[index] ?? PARSED_GRAPH_FILE, blockedConceptKeys);
  });

  const referenceCounts = conceptReferenceCounts(inputRelationships);
  return selectUnmatchedRepresentatives(groups, referenceCounts);
}

function addUnmatchedConceptCandidate(
  groups: Map<string, Map<string, { occurrences: number; referenceKey: string }>>,
  node: OntologyNode,
  aliasMap: ReadonlyMap<string, ConceptEntry>,
  sourceFile: string,
  blockedConceptKeys: ReadonlySet<string>,
): void {
  if (node.label !== CONCEPT_LABEL || conceptEntry(node.key, aliasMap)) {
    return;
  }
  const source = conceptSource(sourceFile);
  if (source === "structural") {
    throw new Error(`Structural Concept "${node.key}" is missing from the concept dictionary.`);
  }

  const key = normalizeConceptKey(node.key);
  if (!key || CONCEPT_KEY_MERGE_DENYLIST.has(key) || blockedConceptKeys.has(key)) {
    return;
  }
  const displayName = normalizeText(node.key);
  const candidates = groups.get(key) ?? new Map();
  const candidate = candidates.get(displayName) ?? {
    occurrences: 0,
    referenceKey: normalizeText(displayName),
  };
  candidate.occurrences += 1;
  candidates.set(displayName, candidate);
  groups.set(key, candidates);
}

function selectUnmatchedRepresentatives(
  groups: ReadonlyMap<string, Map<string, { occurrences: number; referenceKey: string }>>,
  referenceCounts: ReadonlyMap<string, number>,
): Map<string, string> {
  return new Map(
    [...groups.entries()].map(([key, candidates]) => [
      key,
      [...candidates.entries()].sort(
        ([leftName, left], [rightName, right]) =>
          (referenceCounts.get(right.referenceKey) ?? 0) - (referenceCounts.get(left.referenceKey) ?? 0) ||
          right.occurrences - left.occurrences ||
          compareCodePoints(leftName, rightName),
      )[0][0],
    ]),
  );
}

function conceptReferenceCounts(relationships: readonly OntologyRelationship[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const relationship of relationships) {
    for (const endpoint of [relationship.startKey, relationship.endKey]) {
      const conceptKey = endpoint.startsWith(`${CONCEPT_LABEL}:`) ? endpoint.slice(CONCEPT_LABEL.length + 1) : endpoint;
      const key = normalizeText(conceptKey);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function normalizeNode(
  node: OntologyNode,
  aliasMap: ReadonlyMap<string, ConceptEntry>,
  unmatchedRepresentatives: ReadonlyMap<string, string>,
  unknownConcepts: Map<string, number>,
  sourceFile: string,
): OntologyNode {
  if (node.label !== CONCEPT_LABEL) {
    return normalizeNonConceptNode(node);
  }

  const normalized = normalizeText(node.key);
  const entry = conceptEntry(node.key, aliasMap);
  const source = conceptSource(sourceFile);
  if (!entry) {
    return normalizeUnmatchedConceptNode(node, normalized, source, unmatchedRepresentatives, unknownConcepts);
  }

  return {
    label: CONCEPT_LABEL,
    key: entry.canonical,
    properties: {
      ...node.properties,
      name: entry.canonical,
      kind: entry.kind,
      source,
      dictMatched: true,
    },
  };
}

function normalizeNonConceptNode(node: OntologyNode): OntologyNode {
  return {
    ...node,
    properties: {
      ...node.properties,
      [NODE_KEY_PROPERTIES[node.label]]: normalizedKey(node.label, node.key),
    },
  };
}

function normalizeUnmatchedConceptNode(
  node: OntologyNode,
  normalized: string,
  source: ConceptSource,
  unmatchedRepresentatives: ReadonlyMap<string, string>,
  unknownConcepts: Map<string, number>,
): OntologyNode {
  if (source === "structural") {
    throw new Error(`Structural Concept "${node.key}" is missing from the concept dictionary.`);
  }
  const representative = unmatchedRepresentatives.get(normalizeConceptKey(node.key)) ?? normalized;
  unknownConcepts.set(normalized, (unknownConcepts.get(normalized) ?? 0) + 1);
  return {
    label: CONCEPT_LABEL,
    key: representative,
    properties: {
      ...node.properties,
      name: representative,
      source,
      dictMatched: false,
    },
  };
}

export function normalizedKey(label: NodeLabel, key: string): string | number {
  if (label !== "Task") return key;
  const number = Number(key);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Task key must be a safe integer: ${key}`);
  }
  return number;
}

export function mergeNode(existing: OntologyNode | undefined, incoming: OntologyNode): OntologyNode {
  if (!existing) {
    return incoming;
  }
  const merged = {
    label: existing.label,
    key: existing.key,
    properties: {
      ...existing.properties,
      ...incoming.properties,
    },
  };
  if (existing.label !== CONCEPT_LABEL) {
    return merged;
  }
  return {
    ...merged,
    properties: {
      ...merged.properties,
      // 'llm'은 이 Concept이 inferred.jsonl에 한 번이라도 등장했음을 뜻한다.
      source: existing.properties.source === "llm" || incoming.properties.source === "llm" ? "llm" : "structural",
      dictMatched: existing.properties.dictMatched === true || incoming.properties.dictMatched === true,
    },
  };
}
