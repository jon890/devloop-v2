import type { ConceptEntry, OntologyNode, OntologyRelationship } from "@devloop/shared";
import { CONCEPT_LABEL } from "./concept-alias.const";
import { normalizeText } from "./concept-alias";
import type { NodeRef } from "./node-merge";

export function addDictionaryEndpointAliases(
  endpointAliases: Map<string, NodeRef[]>,
  nodesByIdentity: ReadonlyMap<string, OntologyNode>,
  aliasMap: ReadonlyMap<string, ConceptEntry>,
): void {
  for (const entry of aliasMap.values()) {
    const ref = nodesByIdentity.has(`${CONCEPT_LABEL}:${entry.canonical}`) ? { label: CONCEPT_LABEL, key: entry.canonical } : undefined;
    if (!ref) {
      continue;
    }
    addEndpointAlias(endpointAliases, entry.canonical, ref);
    for (const alias of entry.aliases) {
      addEndpointAlias(endpointAliases, alias, ref);
    }
  }
}

export function addEndpointAlias(index: Map<string, NodeRef[]>, key: string, ref: NodeRef): void {
  const qualifiedKey = `${ref.label}:${key}`;
  for (const alias of [key, normalizeText(key), qualifiedKey, normalizeText(qualifiedKey)]) {
    const refs = index.get(alias) ?? [];
    if (!refs.some((existing) => existing.label === ref.label && existing.key === ref.key)) {
      refs.push(ref);
    }
    index.set(alias, refs);
  }
}

export function resolveEndpoint(
  index: Map<string, NodeRef[]>,
  key: string,
  field: "startKey" | "endKey",
  relationship: OntologyRelationship,
): NodeRef {
  const refs = index.get(key) ?? index.get(normalizeText(key)) ?? [];
  if (refs.length === 0) {
    throw new Error(
      `Missing ${field} node "${key}" for ${relationship.type} relationship ` + `(${relationship.startKey} -> ${relationship.endKey}).`,
    );
  }
  if (refs.length > 1) {
    const candidates = refs.map((ref) => `${ref.label}:${ref.key}`).join(", ");
    throw new Error(`Ambiguous ${field} node "${key}" for ${relationship.type} relationship: ${candidates}.`);
  }
  return refs[0];
}
