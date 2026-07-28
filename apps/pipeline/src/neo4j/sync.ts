import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import neo4j, { type Driver, type Integer, type Session } from "neo4j-driver";
import {
  CORE_CONCEPTS,
  ConceptDictionarySchema,
  LLM_GRAPH_FILE,
  NODE_KEY_PROPERTIES,
  NODE_LABELS,
  OntologyNodeSchema,
  OntologyRelationshipSchema,
  RELATIONSHIP_TYPES,
  STRUCTURAL_GRAPH_FILE,
  type ConceptDictionary,
  type ConceptEntry,
  type NodeLabel,
  type OntologyNode,
  type OntologyRelationship,
  type RelationshipType,
} from "@devloop/shared";
import { sanitizeLlmGraphFile } from "../infer/llm-relationship-sanitizer";
import { CONCEPT_KEY_CANONICAL_OVERRIDES, CONCEPT_KEY_MERGE_DENYLIST, CONCEPT_LABEL, RELATIONSHIP_IDENTITY_PROPERTIES } from "./load.const";
import { neo4jCredentials } from "./neo4j-config";

interface LoadOptions {
  project: string;
  dataDir: string;
}

interface SkippedRelationshipSample {
  sourceFile: string;
  relationship: OntologyRelationship;
  error: string;
}

interface SkippedRelationshipsReport {
  count: number;
  samples: SkippedRelationshipSample[];
}

interface NormalizedGraph {
  nodes: OntologyNode[];
  relationships: OntologyRelationship[];
  unknownConcepts: Map<string, number>;
  skippedRelationships: SkippedRelationshipsReport;
}

interface PreparedLoadGraph {
  graph: NormalizedGraph;
  droppedRelationships: unknown;
}

interface SourcedRecord {
  value: unknown;
  sourceFile: string;
}

interface NodeRef {
  label: NodeLabel;
  key: string;
}

interface RelationshipRow {
  startKey: DatabaseKey;
  endKey: DatabaseKey;
  startLabel: unknown;
  endLabel: unknown;
  properties: Record<string, unknown>;
}

interface RelationshipMergeScope {
  session: Session;
  type: RelationshipType;
  startLabel: NodeLabel;
  endLabel: NodeLabel;
  startKeyProperty: string;
  endKeyProperty: string;
}

type DatabaseKey = string | Integer;
type ConceptSource = "llm" | "structural";

export { CONCEPT_KEY_MERGE_DENYLIST } from "./load.const";

function parseArgs(args: readonly string[]): LoadOptions {
  const project = readFlag(args, "--project") ?? "tc-ocr";
  const dataDir = readFlag(args, "--data-dir") ?? process.env.PIPELINE_DATA_DIR ?? resolve(__dirname, "../../data");

  return { project, dataDir: resolve(dataDir) };
}

function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value?.trim() || undefined;
}

async function loadConceptDictionary(dataDir: string, project: string): Promise<ConceptDictionary> {
  const path = resolve(dataDir, "concepts", `${project}.json`);
  try {
    const raw = await readFile(path, "utf8");
    return ConceptDictionarySchema.parse([...CORE_CONCEPTS, ...JSON.parse(raw)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ConceptDictionarySchema.parse(CORE_CONCEPTS);
    }
    throw error;
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeConceptKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
}

function conceptLookupKeys(value: string): string[] {
  const normalized = normalizeText(value);
  const conceptKey = normalizeConceptKey(value);
  if (!conceptKey || CONCEPT_KEY_MERGE_DENYLIST.has(conceptKey)) {
    return [normalized];
  }
  return [...new Set([normalized, conceptKey])];
}

export function buildConceptAliasMap(dictionary: ConceptDictionary): Map<string, ConceptEntry> {
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
    if (CONCEPT_KEY_MERGE_DENYLIST.has(conceptKey)) {
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

    const canonical = CONCEPT_KEY_CANONICAL_OVERRIDES.get(conceptKey);
    const selected = owners.find((entry) => entry.canonical === canonical);
    if (!selected) {
      throw conceptDictionaryConflict(conceptKey, owners);
    }
    aliases.set(conceptKey, selected);
  }
  return aliases;
}

function conceptDictionaryConflict(key: string, owners: readonly ConceptEntry[]): Error {
  return new Error(
    `Concept key "${key}" has conflicting canonical entries: ` +
      `${owners.map((entry) => entry.canonical).join(", ")}. ` +
      "Merge the entries in the concept dictionary or add a canonical override.",
  );
}

function conceptEntry(value: string, aliasMap: ReadonlyMap<string, ConceptEntry>): ConceptEntry | undefined {
  return conceptLookupKeys(value)
    .map((key) => aliasMap.get(key))
    .find((candidate): candidate is ConceptEntry => candidate !== undefined);
}

function conceptSource(sourceFile: string): ConceptSource {
  if (sourceFile === LLM_GRAPH_FILE) {
    return "llm";
  }
  if (sourceFile === STRUCTURAL_GRAPH_FILE) {
    return "structural";
  }
  throw new Error(`Unsupported Concept source file "${sourceFile}". ` + `Expected ${LLM_GRAPH_FILE} or ${STRUCTURAL_GRAPH_FILE}.`);
}

async function readJsonlRecords(graphDir: string): Promise<SourcedRecord[]> {
  const entries = await readdir(graphDir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => resolve(graphDir, entry.name))
    .sort();

  const records: SourcedRecord[] = [];
  for (const file of jsonlFiles) {
    const content = await readFile(file, "utf8");
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line, index) => {
        try {
          records.push({ value: JSON.parse(line), sourceFile: basename(file) });
        } catch (error) {
          throw new Error(`${file}:${index + 1} invalid JSONL record: ${(error as Error).message}`);
        }
      });
  }

  return records;
}

function parseGraphRecords(records: readonly SourcedRecord[]): {
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
    const node = normalizeNode(inputNode, aliasMap, unmatchedRepresentatives, unknownConcepts, nodeSources?.[index] ?? STRUCTURAL_GRAPH_FILE);
    const identity = `${node.label}:${node.key}`;
    const existing = nodesByIdentity.get(identity);
    nodesByIdentity.set(identity, mergeNode(existing, node));
    addEndpointAlias(endpointAliases, inputNode.key, { label: node.label, key: node.key });
    addEndpointAlias(endpointAliases, node.key, { label: node.label, key: node.key });
  });
  return { nodesByIdentity, endpointAliases };
}

function addDictionaryEndpointAliases(
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
    const sourceFile = relationshipSources?.[index] ?? STRUCTURAL_GRAPH_FILE;
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
  if (sourceFile === STRUCTURAL_GRAPH_FILE) throw error;
  skippedRelationships.count += 1;
  if (skippedRelationships.samples.length < 10) {
    skippedRelationships.samples.push({
      sourceFile,
      relationship,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildUnmatchedConceptRepresentatives(
  inputNodes: readonly OntologyNode[],
  inputRelationships: readonly OntologyRelationship[],
  aliasMap: ReadonlyMap<string, ConceptEntry>,
  nodeSources?: readonly string[],
): Map<string, string> {
  const groups = new Map<string, Map<string, { occurrences: number; referenceKey: string }>>();

  inputNodes.forEach((node, index) => {
    addUnmatchedConceptCandidate(groups, node, aliasMap, nodeSources?.[index] ?? STRUCTURAL_GRAPH_FILE);
  });

  const referenceCounts = conceptReferenceCounts(inputRelationships);
  return selectUnmatchedRepresentatives(groups, referenceCounts);
}

function addUnmatchedConceptCandidate(
  groups: Map<string, Map<string, { occurrences: number; referenceKey: string }>>,
  node: OntologyNode,
  aliasMap: ReadonlyMap<string, ConceptEntry>,
  sourceFile: string,
): void {
  if (node.label !== CONCEPT_LABEL || conceptEntry(node.key, aliasMap)) {
    return;
  }
  const source = conceptSource(sourceFile);
  if (source === "structural") {
    throw new Error(`Structural Concept "${node.key}" is missing from the concept dictionary.`);
  }

  const key = normalizeConceptKey(node.key);
  if (!key || CONCEPT_KEY_MERGE_DENYLIST.has(key)) {
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

function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function normalizeNode(
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

function normalizedKey(label: NodeLabel, key: string): string | number {
  if (label !== "Task") return key;
  const number = Number(key);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Task key must be a safe integer: ${key}`);
  }
  return number;
}

function databaseKey(label: NodeLabel, key: string): DatabaseKey {
  const normalized = normalizedKey(label, key);
  return typeof normalized === "number" ? neo4j.int(normalized) : normalized;
}

function mergeNode(existing: OntologyNode | undefined, incoming: OntologyNode): OntologyNode {
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
      // 'llm'은 이 Concept이 llm.jsonl에 한 번이라도 등장했음을 뜻한다.
      source: existing.properties.source === "llm" || incoming.properties.source === "llm" ? "llm" : "structural",
      dictMatched: existing.properties.dictMatched === true || incoming.properties.dictMatched === true,
    },
  };
}

function addEndpointAlias(index: Map<string, NodeRef[]>, key: string, ref: NodeRef): void {
  const qualifiedKey = `${ref.label}:${key}`;
  for (const alias of [key, normalizeText(key), qualifiedKey, normalizeText(qualifiedKey)]) {
    const refs = index.get(alias) ?? [];
    if (!refs.some((existing) => existing.label === ref.label && existing.key === ref.key)) {
      refs.push(ref);
    }
    index.set(alias, refs);
  }
}

function resolveEndpoint(index: Map<string, NodeRef[]>, key: string, field: "startKey" | "endKey", relationship: OntologyRelationship): NodeRef {
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

async function mergeNodes(session: Session, nodes: readonly OntologyNode[]): Promise<void> {
  for (const label of NODE_LABELS) {
    const keyProperty = NODE_KEY_PROPERTIES[label];
    const rows = nodes
      .filter((node) => node.label === label)
      .map((node) => ({
        key: databaseKey(label, node.key),
        properties: sanitizeProperties({
          ...node.properties,
          [keyProperty]: databaseKey(label, node.key),
        }),
      }));
    if (rows.length === 0) {
      continue;
    }

    await session.run(
      `
      UNWIND $rows AS row
      MERGE (n:${label} { ${keyProperty}: row.key })
      SET n += row.properties
      `,
      { rows },
    );
  }
}

async function mergeRelationships(session: Session, relationships: readonly OntologyRelationship[]): Promise<void> {
  for (const type of RELATIONSHIP_TYPES) {
    const rows = relationships
      .filter((relationship) => relationship.type === type)
      .map((relationship) => ({
        startKey: relationship.startKey,
        endKey: relationship.endKey,
        startLabel: relationship.properties.startLabel,
        endLabel: relationship.properties.endLabel,
        properties: sanitizeProperties(relationship.properties),
      }));
    if (rows.length === 0) {
      continue;
    }

    for (const startLabel of NODE_LABELS) {
      for (const endLabel of NODE_LABELS) {
        const scopedRows = rows.filter((row) => row.startLabel === startLabel && row.endLabel === endLabel);
        if (scopedRows.length === 0) {
          continue;
        }
        const startKeyProperty = NODE_KEY_PROPERTIES[startLabel];
        const endKeyProperty = NODE_KEY_PROPERTIES[endLabel];
        await mergeRelationshipRows(session, type, startLabel, endLabel, startKeyProperty, endKeyProperty, scopedRows);
      }
    }
  }
}

async function mergeRelationshipRows(
  session: Session,
  type: RelationshipType,
  startLabel: NodeLabel,
  endLabel: NodeLabel,
  startKeyProperty: string,
  endKeyProperty: string,
  rows: readonly RelationshipRow[],
): Promise<void> {
  const scope: RelationshipMergeScope = {
    session,
    type,
    startLabel,
    endLabel,
    startKeyProperty,
    endKeyProperty,
  };
  const preparedRows = prepareRelationshipRows(rows, startLabel, endLabel);
  const identityProperty = RELATIONSHIP_IDENTITY_PROPERTIES[type];

  if (!identityProperty) {
    await mergeRowsWithoutIdentity(scope, preparedRows);
    return;
  }

  const { rowsWithIdentity, rowsWithoutIdentity } = splitRowsByIdentity(preparedRows, identityProperty);

  if (rowsWithoutIdentity.length > 0) {
    await mergeRowsWithoutIdentity(scope, rowsWithoutIdentity);
  }
  if (rowsWithIdentity.length > 0) {
    await mergeRowsWithIdentity(scope, identityProperty, rowsWithIdentity);
  }
}

function prepareRelationshipRows(
  rows: readonly RelationshipRow[],
  startLabel: NodeLabel,
  endLabel: NodeLabel,
): Array<{ startKey: DatabaseKey; endKey: DatabaseKey; properties: Record<string, unknown> }> {
  return rows.map((row) => ({
    startKey: databaseKey(startLabel, String(row.startKey)),
    endKey: databaseKey(endLabel, String(row.endKey)),
    properties: stripResolverProperties(row.properties),
  }));
}

function splitRowsByIdentity(
  rows: readonly { startKey: DatabaseKey; endKey: DatabaseKey; properties: Record<string, unknown> }[],
  identityProperty: string,
): {
  rowsWithIdentity: Array<{ startKey: DatabaseKey; endKey: DatabaseKey; properties: Record<string, unknown> }>;
  rowsWithoutIdentity: Array<{ startKey: DatabaseKey; endKey: DatabaseKey; properties: Record<string, unknown> }>;
} {
  return {
    rowsWithIdentity: rows.filter((row) => row.properties[identityProperty] !== undefined && row.properties[identityProperty] !== null),
    rowsWithoutIdentity: rows.filter((row) => row.properties[identityProperty] === undefined || row.properties[identityProperty] === null),
  };
}

async function mergeRowsWithIdentity(
  scope: RelationshipMergeScope,
  identityProperty: string,
  rows: readonly { startKey: DatabaseKey; endKey: DatabaseKey; properties: Record<string, unknown> }[],
): Promise<void> {
  await scope.session.run(
    `
    UNWIND $rows AS row
    MATCH (start:${scope.startLabel} { ${scope.startKeyProperty}: row.startKey })
    MATCH (end:${scope.endLabel} { ${scope.endKeyProperty}: row.endKey })
    MERGE (start)-[r:${scope.type} { ${identityProperty}: row.identity }]->(end)
    SET r += row.properties
    `,
    {
      rows: rows.map((row) => ({
        ...row,
        identity: row.properties[identityProperty],
      })),
    },
  );
}

async function mergeRowsWithoutIdentity(
  scope: RelationshipMergeScope,
  rows: readonly { startKey: DatabaseKey; endKey: DatabaseKey; properties: Record<string, unknown> }[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await scope.session.run(
    `
    UNWIND $rows AS row
    MATCH (start:${scope.startLabel} { ${scope.startKeyProperty}: row.startKey })
    MATCH (end:${scope.endLabel} { ${scope.endKeyProperty}: row.endKey })
    MERGE (start)-[r:${scope.type}]->(end)
    SET r += row.properties
    `,
    { rows },
  );
}

async function migrateTaskNumberType(session: Session): Promise<void> {
  await session.run(`
    MATCH (task:Task)
    WHERE valueType(task.number) STARTS WITH 'STRING'
       OR valueType(task.number) STARTS WITH 'FLOAT'
    WITH task, toInteger(task.number) AS integerNumber
    WHERE integerNumber IS NOT NULL
    SET task.number = integerNumber
  `);
}

async function removeLegacyUnknownTagDimensions(session: Session, project: string): Promise<void> {
  await session.run(
    `
    MATCH (:Project { code: $project })-[:CONTAINS]->(task:Task)
    MATCH (task)-[tagged:TAGGED { dimension: 'unknown' }]->()
    DELETE tagged
    `,
    { project },
  );
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
}

function stripResolverProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const { startLabel: _startLabel, endLabel: _endLabel, ...rest } = properties;
  return rest;
}

async function collectStats(session: Session): Promise<{
  nodes: Record<string, number>;
  relationships: Record<string, number>;
}> {
  const nodeResult = await session.run(`
      MATCH (n)
      UNWIND labels(n) AS label
      RETURN label, count(*) AS count
      ORDER BY label
    `);
  const relationshipResult = await session.run(`
      MATCH ()-[r]->()
      RETURN type(r) AS type, count(*) AS count
      ORDER BY type
    `);

  return {
    nodes: Object.fromEntries(nodeResult.records.map((record) => [record.get("label"), record.get("count").toNumber()])),
    relationships: Object.fromEntries(relationshipResult.records.map((record) => [record.get("type"), record.get("count").toNumber()])),
  };
}

async function loadGraph(options: LoadOptions): Promise<void> {
  const prepared = await prepareLoadGraph(options);
  await writeGraphToNeo4j(options, prepared.graph, (stats) => {
    console.log(
      JSON.stringify(
        {
          project: options.project,
          dataDir: options.dataDir,
          loaded: {
            nodes: prepared.graph.nodes.length,
            relationships: prepared.graph.relationships.length,
          },
          stats,
          unknownConcepts: Object.fromEntries([...prepared.graph.unknownConcepts.entries()].sort()),
          droppedRelationships: prepared.droppedRelationships,
          skippedRelationships: prepared.graph.skippedRelationships,
        },
        null,
        2,
      ),
    );
  });
}

async function prepareLoadGraph(options: LoadOptions): Promise<PreparedLoadGraph> {
  const graphDir = resolve(options.dataDir, "graph", options.project);
  const dictionary = await loadConceptDictionary(options.dataDir, options.project);
  const aliasMap = buildConceptAliasMap(dictionary);
  const llmSanitization = await sanitizeLlmGraphFile(options.dataDir, options.project);
  const records = await readJsonlRecords(graphDir);
  const parsed = parseGraphRecords(records);
  const graph = normalizeGraph(parsed.nodes, parsed.relationships, aliasMap, parsed.relationshipSources, parsed.nodeSources);
  return {
    graph,
    droppedRelationships: llmSanitization.droppedRelationships,
  };
}

async function writeGraphToNeo4j(
  options: LoadOptions,
  graph: NormalizedGraph,
  onStatsCollected: (stats: { nodes: Record<string, number>; relationships: Record<string, number> }) => void,
): Promise<{
  nodes: Record<string, number>;
  relationships: Record<string, number>;
}> {
  const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
  const { user, password } = neo4jCredentials();
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database: "neo4j" });

  try {
    await migrateTaskNumberType(session);
    await removeLegacyUnknownTagDimensions(session, options.project);
    await mergeNodes(session, graph.nodes);
    await mergeRelationships(session, graph.relationships);
    const stats = await collectStats(session);
    onStatsCollected(stats);
    return stats;
  } finally {
    await session.close();
    await driver.close();
  }
}

if (require.main === module) {
  void loadGraph(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
