import {
  INFERRED_GRAPH_FILE,
  OntologyNodeSchema,
  OntologyRelationshipSchema,
  PARSED_GRAPH_FILE,
  type ConceptDictionary,
  type ConceptEntry,
  type OntologyNode,
  type OntologyRelationship,
} from "@devloop/shared";
import {
  buildEndpointIndex,
  parseLlmGraphRecord,
  sanitizeLlmRecords,
  type DroppedRelationship,
  type EndpointIndex,
} from "../infer/llm-relationship-sanitizer";
import { buildConceptAliasMap } from "./concept-alias";
import { addDictionaryEndpointAliases, addEndpointAlias, resolveEndpoint } from "./endpoint";
import { buildUnmatchedConceptRepresentatives, mergeNode, normalizeNode, type NodeRef } from "./node-merge";
import type { ResolveResult, SkippedRelationshipsReport, SourcedRecord } from "./resolve.schema";

export interface ResolveInput {
  parsed: SourcedRecord[];
  inferred: SourcedRecord[];
  dictionary: ConceptDictionary;
  endpointIndex: EndpointIndex;
  previousDropped: readonly DroppedRelationship[];
}

export function resolveGraph(input: ResolveInput): ResolveResult {
  const aliasMap = buildConceptAliasMap(input.dictionary);
  const inferredRecords = input.inferred.map((record) => parseLlmGraphRecord(record.value));
  const sanitized = sanitizeLlmRecords(inferredRecords, input.previousDropped, input.endpointIndex);
  const sourcedInferred: SourcedRecord[] = sanitized.records.map((value) => ({ value, sourceFile: INFERRED_GRAPH_FILE }));
  const records = [...sourcedInferred, ...input.parsed];
  const { nodes, nodeSources, relationships, relationshipSources } = parseGraphRecords(records);
  const graph = normalizeGraph(nodes, relationships, aliasMap, relationshipSources, nodeSources);

  return {
    ...graph,
    droppedRelationships: sanitized.droppedRelationships,
    rewrittenRelationships: sanitized.rewrittenRelationships,
  };
}

export function parseGraphRecords(records: readonly SourcedRecord[]): {
  nodes: OntologyNode[];
  nodeSources: string[];
  relationships: OntologyRelationship[];
  relationshipSources: string[];
} {
  const nodes: OntologyNode[] = [];
  const nodeSources: string[] = [];
  const relationships: OntologyRelationship[] = [];
  const relationshipSources: string[] = [];

  for (const record of records) {
    const node = OntologyNodeSchema.safeParse(record.value);
    if (node.success) {
      nodes.push(node.data);
      nodeSources.push(record.sourceFile);
      continue;
    }

    const relationship = OntologyRelationshipSchema.safeParse(record.value);
    if (relationship.success) {
      relationships.push(relationship.data);
      relationshipSources.push(record.sourceFile);
      continue;
    }

    throw new Error(`Unsupported graph record in ${record.sourceFile}: ${JSON.stringify(record.value)}`);
  }

  return { nodes, nodeSources, relationships, relationshipSources };
}

interface NormalizedGraph {
  nodes: OntologyNode[];
  relationships: OntologyRelationship[];
  unknownConcepts: Map<string, number>;
  skippedRelationships: SkippedRelationshipsReport;
}

export function normalizeGraph(
  inputNodes: readonly OntologyNode[],
  inputRelationships: readonly OntologyRelationship[],
  aliasMap: Map<string, ConceptEntry>,
  relationshipSources?: readonly string[],
  nodeSources?: readonly string[],
): NormalizedGraph {
  validateNormalizationSources(inputNodes, inputRelationships, relationshipSources, nodeSources);
  const unknownConcepts = new Map<string, number>();
  const unmatchedRepresentatives = buildUnmatchedConceptRepresentatives(inputNodes, inputRelationships, aliasMap, nodeSources);
  const { nodesByIdentity, endpointAliases } = normalizeNodes(inputNodes, aliasMap, unmatchedRepresentatives, unknownConcepts, nodeSources);
  addDictionaryEndpointAliases(endpointAliases, nodesByIdentity, aliasMap);
  const { relationships, skippedRelationships } = normalizeRelationships(inputRelationships, endpointAliases, relationshipSources);

  return {
    nodes: [...nodesByIdentity.values()],
    relationships,
    unknownConcepts,
    skippedRelationships,
  };
}

function validateNormalizationSources(
  inputNodes: readonly OntologyNode[],
  inputRelationships: readonly OntologyRelationship[],
  relationshipSources?: readonly string[],
  nodeSources?: readonly string[],
): void {
  if (relationshipSources && relationshipSources.length !== inputRelationships.length) {
    throw new Error("relationshipSources must have the same length as inputRelationships.");
  }
  if (nodeSources && nodeSources.length !== inputNodes.length) {
    throw new Error("nodeSources must have the same length as inputNodes.");
  }
}

function normalizeNodes(
  inputNodes: readonly OntologyNode[],
  aliasMap: ReadonlyMap<string, ConceptEntry>,
  unmatchedRepresentatives: ReadonlyMap<string, string>,
  unknownConcepts: Map<string, number>,
  nodeSources?: readonly string[],
): {
  nodesByIdentity: Map<string, OntologyNode>;
  endpointAliases: Map<string, NodeRef[]>;
} {
  const nodesByIdentity = new Map<string, OntologyNode>();
  const endpointAliases = new Map<string, NodeRef[]>();
  inputNodes.forEach((inputNode, index) => {
    const node = normalizeNode(inputNode, aliasMap, unmatchedRepresentatives, unknownConcepts, nodeSources?.[index] ?? PARSED_GRAPH_FILE);
    const identity = `${node.label}:${node.key}`;
    const existing = nodesByIdentity.get(identity);
    nodesByIdentity.set(identity, mergeNode(existing, node));
    addEndpointAlias(endpointAliases, inputNode.key, { label: node.label, key: node.key });
    addEndpointAlias(endpointAliases, node.key, { label: node.label, key: node.key });
  });
  return { nodesByIdentity, endpointAliases };
}

function normalizeRelationships(
  inputRelationships: readonly OntologyRelationship[],
  endpointAliases: Map<string, NodeRef[]>,
  relationshipSources?: readonly string[],
): {
  relationships: OntologyRelationship[];
  skippedRelationships: SkippedRelationshipsReport;
} {
  const relationships: OntologyRelationship[] = [];
  const skippedRelationships: SkippedRelationshipsReport = { count: 0, samples: [] };
  inputRelationships.forEach((relationship, index) => {
    const sourceFile = relationshipSources?.[index] ?? PARSED_GRAPH_FILE;
    try {
      relationships.push(normalizeRelationship(relationship, endpointAliases));
    } catch (error) {
      recordSkippedRelationship(sourceFile, relationship, error, skippedRelationships);
    }
  });
  return { relationships, skippedRelationships };
}

function normalizeRelationship(relationship: OntologyRelationship, endpointAliases: Map<string, NodeRef[]>): OntologyRelationship {
  const start = resolveEndpoint(endpointAliases, relationship.startKey, "startKey", relationship);
  const end = resolveEndpoint(endpointAliases, relationship.endKey, "endKey", relationship);
  return {
    ...relationship,
    startKey: start.key,
    endKey: end.key,
    properties: {
      ...relationship.properties,
      startLabel: start.label,
      endLabel: end.label,
    },
  };
}

function recordSkippedRelationship(
  sourceFile: string,
  relationship: OntologyRelationship,
  error: unknown,
  skippedRelationships: SkippedRelationshipsReport,
): void {
  if (sourceFile === PARSED_GRAPH_FILE) throw error;
  skippedRelationships.count += 1;
  if (skippedRelationships.samples.length < 10) {
    skippedRelationships.samples.push({
      sourceFile,
      relationship,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
