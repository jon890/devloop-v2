import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import {
  CORE_CONCEPTS,
  ConceptDictionarySchema,
  NODE_KEY_PROPERTIES,
  NODE_LABELS,
  OntologyNodeSchema,
  OntologyRelationshipSchema,
  RELATIONSHIP_TYPES,
  type ConceptDictionary,
  type ConceptEntry,
  type NodeLabel,
  type OntologyNode,
  type OntologyRelationship,
  type RelationshipType,
} from '@devloop/shared';

interface LoadOptions {
  project: string;
  dataDir: string;
}

interface NormalizedGraph {
  nodes: OntologyNode[];
  relationships: OntologyRelationship[];
  unknownConcepts: Map<string, number>;
}

interface NodeRef {
  label: NodeLabel;
  key: string;
}

interface RelationshipRow {
  startKey: string;
  endKey: string;
  startLabel: unknown;
  endLabel: unknown;
  properties: Record<string, unknown>;
}

const CONCEPT_LABEL: NodeLabel = 'Concept';
const RELATIONSHIP_IDENTITY_PROPERTIES: Partial<Record<RelationshipType, string>> = {
  ASSIGNED_TO: 'role',
  TAGGED: 'dimension',
  RELATES_TO: 'kind',
};

function parseArgs(args: readonly string[]): LoadOptions {
  const project = readFlag(args, '--project') ?? 'tc-ocr';
  const dataDir =
    readFlag(args, '--data-dir') ??
    process.env.PIPELINE_DATA_DIR ??
    resolve(__dirname, '../../data');

  return { project, dataDir: resolve(dataDir) };
}

function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value?.trim() || undefined;
}

function neo4jCredentials(): { user: string; password: string } {
  const envUser = process.env.NEO4J_USER;
  const envPassword = process.env.NEO4J_PASSWORD;
  if (envUser && envPassword) {
    return { user: envUser, password: envPassword };
  }

  const [user = 'neo4j', password = 'devloop-password'] = (
    process.env.NEO4J_AUTH ?? 'neo4j/devloop-password'
  ).split('/', 2);
  return { user, password };
}

async function loadConceptDictionary(dataDir: string, project: string): Promise<ConceptDictionary> {
  const path = resolve(dataDir, 'concepts', `${project}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return ConceptDictionarySchema.parse([...CORE_CONCEPTS, ...JSON.parse(raw)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ConceptDictionarySchema.parse(CORE_CONCEPTS);
    }
    throw error;
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildConceptAliasMap(dictionary: ConceptDictionary): Map<string, ConceptEntry> {
  const aliases = new Map<string, ConceptEntry>();
  for (const entry of dictionary) {
    for (const name of [entry.canonical, ...entry.aliases]) {
      aliases.set(normalizeText(name), entry);
    }
  }
  return aliases;
}

async function readJsonlRecords(graphDir: string): Promise<unknown[]> {
  const entries = await readdir(graphDir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => resolve(graphDir, entry.name))
    .sort();

  const records: unknown[] = [];
  for (const file of jsonlFiles) {
    const content = await readFile(file, 'utf8');
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line, index) => {
        try {
          records.push(JSON.parse(line));
        } catch (error) {
          throw new Error(`${file}:${index + 1} invalid JSONL record: ${(error as Error).message}`);
        }
      });
  }

  return records;
}

function parseGraphRecords(records: readonly unknown[]): {
  nodes: OntologyNode[];
  relationships: OntologyRelationship[];
} {
  const nodes: OntologyNode[] = [];
  const relationships: OntologyRelationship[] = [];

  for (const record of records) {
    const node = OntologyNodeSchema.safeParse(record);
    if (node.success) {
      nodes.push(node.data);
      continue;
    }

    const relationship = OntologyRelationshipSchema.safeParse(record);
    if (relationship.success) {
      relationships.push(relationship.data);
      continue;
    }

    throw new Error(`Unsupported graph record: ${JSON.stringify(record)}`);
  }

  return { nodes, relationships };
}

export function normalizeGraph(
  inputNodes: readonly OntologyNode[],
  inputRelationships: readonly OntologyRelationship[],
  aliasMap: Map<string, ConceptEntry>,
): NormalizedGraph {
  const unknownConcepts = new Map<string, number>();
  const nodesByIdentity = new Map<string, OntologyNode>();
  const endpointAliases = new Map<string, NodeRef[]>();

  for (const inputNode of inputNodes) {
    const node = normalizeNode(inputNode, aliasMap, unknownConcepts);
    const identity = `${node.label}:${node.key}`;
    const existing = nodesByIdentity.get(identity);
    nodesByIdentity.set(identity, mergeNode(existing, node));

    addEndpointAlias(endpointAliases, inputNode.key, { label: node.label, key: node.key });
    addEndpointAlias(endpointAliases, node.key, { label: node.label, key: node.key });
  }

  for (const entry of aliasMap.values()) {
    const ref = nodesByIdentity.has(`${CONCEPT_LABEL}:${entry.canonical}`)
      ? { label: CONCEPT_LABEL, key: entry.canonical }
      : undefined;
    if (!ref) {
      continue;
    }
    addEndpointAlias(endpointAliases, entry.canonical, ref);
    for (const alias of entry.aliases) {
      addEndpointAlias(endpointAliases, alias, ref);
    }
  }

  const relationships = inputRelationships.map((relationship) => {
    const start = resolveEndpoint(endpointAliases, relationship.startKey, 'startKey', relationship);
    const end = resolveEndpoint(endpointAliases, relationship.endKey, 'endKey', relationship);
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
  });

  return {
    nodes: [...nodesByIdentity.values()],
    relationships,
    unknownConcepts,
  };
}

function normalizeNode(
  node: OntologyNode,
  aliasMap: Map<string, ConceptEntry>,
  unknownConcepts: Map<string, number>,
): OntologyNode {
  if (node.label !== CONCEPT_LABEL) {
    return {
      ...node,
      properties: { ...node.properties, [NODE_KEY_PROPERTIES[node.label]]: node.key },
    };
  }

  const normalized = normalizeText(node.key);
  const entry = aliasMap.get(normalized);
  if (!entry) {
    unknownConcepts.set(normalized, (unknownConcepts.get(normalized) ?? 0) + 1);
    return {
      label: CONCEPT_LABEL,
      key: normalized,
      properties: {
        ...node.properties,
        name: normalized,
      },
    };
  }

  return {
    label: CONCEPT_LABEL,
    key: entry.canonical,
    properties: {
      ...node.properties,
      name: entry.canonical,
      kind: entry.kind,
    },
  };
}

function mergeNode(existing: OntologyNode | undefined, incoming: OntologyNode): OntologyNode {
  if (!existing) {
    return incoming;
  }
  return {
    label: existing.label,
    key: existing.key,
    properties: {
      ...existing.properties,
      ...incoming.properties,
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

function resolveEndpoint(
  index: Map<string, NodeRef[]>,
  key: string,
  field: 'startKey' | 'endKey',
  relationship: OntologyRelationship,
): NodeRef {
  const refs = index.get(key) ?? index.get(normalizeText(key)) ?? [];
  if (refs.length === 0) {
    throw new Error(
      `Missing ${field} node "${key}" for ${relationship.type} relationship ` +
        `(${relationship.startKey} -> ${relationship.endKey}).`,
    );
  }
  if (refs.length > 1) {
    const candidates = refs.map((ref) => `${ref.label}:${ref.key}`).join(', ');
    throw new Error(
      `Ambiguous ${field} node "${key}" for ${relationship.type} relationship: ${candidates}.`,
    );
  }
  return refs[0];
}

async function mergeNodes(session: Session, nodes: readonly OntologyNode[]): Promise<void> {
  for (const label of NODE_LABELS) {
    const keyProperty = NODE_KEY_PROPERTIES[label];
    const rows = nodes
      .filter((node) => node.label === label)
      .map((node) => ({
        key: node.key,
        properties: sanitizeProperties({ ...node.properties, [keyProperty]: node.key }),
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

async function mergeRelationships(
  session: Session,
  relationships: readonly OntologyRelationship[],
): Promise<void> {
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
        const scopedRows = rows.filter(
          (row) => row.startLabel === startLabel && row.endLabel === endLabel,
        );
        if (scopedRows.length === 0) {
          continue;
        }
        const startKeyProperty = NODE_KEY_PROPERTIES[startLabel];
        const endKeyProperty = NODE_KEY_PROPERTIES[endLabel];
        await mergeRelationshipRows(
          session,
          type,
          startLabel,
          endLabel,
          startKeyProperty,
          endKeyProperty,
          scopedRows,
        );
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
  const preparedRows = rows.map((row) => ({
    startKey: row.startKey,
    endKey: row.endKey,
    properties: stripResolverProperties(row.properties),
  }));
  const identityProperty = RELATIONSHIP_IDENTITY_PROPERTIES[type];

  if (!identityProperty) {
    await mergeRowsWithoutIdentity(
      session,
      type,
      startLabel,
      endLabel,
      startKeyProperty,
      endKeyProperty,
      preparedRows,
    );
    return;
  }

  const rowsWithIdentity = preparedRows.filter(
    (row) => row.properties[identityProperty] !== undefined && row.properties[identityProperty] !== null,
  );
  const rowsWithoutIdentity = preparedRows.filter(
    (row) => row.properties[identityProperty] === undefined || row.properties[identityProperty] === null,
  );

  if (rowsWithoutIdentity.length > 0) {
    await mergeRowsWithoutIdentity(
      session,
      type,
      startLabel,
      endLabel,
      startKeyProperty,
      endKeyProperty,
      rowsWithoutIdentity,
    );
  }
  if (rowsWithIdentity.length > 0) {
    await session.run(
      `
      UNWIND $rows AS row
      MATCH (start:${startLabel} { ${startKeyProperty}: row.startKey })
      MATCH (end:${endLabel} { ${endKeyProperty}: row.endKey })
      MERGE (start)-[r:${type} { ${identityProperty}: row.identity }]->(end)
      SET r += row.properties
      `,
      {
        rows: rowsWithIdentity.map((row) => ({
          ...row,
          identity: row.properties[identityProperty],
        })),
      },
    );
  }
}

async function mergeRowsWithoutIdentity(
  session: Session,
  type: RelationshipType,
  startLabel: NodeLabel,
  endLabel: NodeLabel,
  startKeyProperty: string,
  endKeyProperty: string,
  rows: readonly { startKey: string; endKey: string; properties: Record<string, unknown> }[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await session.run(
    `
    UNWIND $rows AS row
    MATCH (start:${startLabel} { ${startKeyProperty}: row.startKey })
    MATCH (end:${endLabel} { ${endKeyProperty}: row.endKey })
    MERGE (start)-[r:${type}]->(end)
    SET r += row.properties
    `,
    { rows },
  );
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined && value !== null),
  );
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
    nodes: Object.fromEntries(
      nodeResult.records.map((record) => [record.get('label'), record.get('count').toNumber()]),
    ),
    relationships: Object.fromEntries(
      relationshipResult.records.map((record) => [record.get('type'), record.get('count').toNumber()]),
    ),
  };
}

async function loadGraph(options: LoadOptions): Promise<void> {
  const graphDir = resolve(options.dataDir, 'graph', options.project);
  const dictionary = await loadConceptDictionary(options.dataDir, options.project);
  const aliasMap = buildConceptAliasMap(dictionary);
  const records = await readJsonlRecords(graphDir);
  const parsed = parseGraphRecords(records);
  const graph = normalizeGraph(parsed.nodes, parsed.relationships, aliasMap);

  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const { user, password } = neo4jCredentials();
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database: 'neo4j' });

  try {
    await mergeNodes(session, graph.nodes);
    await mergeRelationships(session, graph.relationships);
    const stats = await collectStats(session);

    console.log(
      JSON.stringify(
        {
          project: options.project,
          dataDir: options.dataDir,
          loaded: {
            nodes: graph.nodes.length,
            relationships: graph.relationships.length,
          },
          stats,
          unknownConcepts: Object.fromEntries([...graph.unknownConcepts.entries()].sort()),
        },
        null,
        2,
      ),
    );
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
