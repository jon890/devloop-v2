import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import neo4j, { type Driver, type Integer, type Session } from "neo4j-driver";
import {
  CORE_CONCEPTS,
  ConceptDictionarySchema,
  INFERRED_GRAPH_FILE,
  NODE_KEY_PROPERTIES,
  NODE_LABELS,
  PARSED_GRAPH_FILE,
  RELATIONSHIP_TYPES,
  type ConceptDictionary,
  type NodeLabel,
  type OntologyNode,
  type OntologyRelationship,
  type RelationshipType,
} from "@devloop/shared";
import { buildEndpointIndex, readDroppedRelationships } from "../infer/llm-relationship-sanitizer";
import { normalizedKey } from "../resolve/node-merge";
import { resolveGraph } from "../resolve/resolve";
import type { ResolveResult, SourcedRecord } from "../resolve/resolve.schema";
import { RELATIONSHIP_IDENTITY_PROPERTIES } from "./sync.const";
import { neo4jCredentials } from "./neo4j-config";

interface LoadOptions {
  project: string;
  dataDir: string;
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

function databaseKey(label: NodeLabel, key: string): DatabaseKey {
  const normalized = normalizedKey(label, key);
  return typeof normalized === "number" ? neo4j.int(normalized) : normalized;
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
  const resolved = await prepareLoadGraph(options);
  await writeGraphToNeo4j(options, resolved, (stats) => {
    console.log(
      JSON.stringify(
        {
          project: options.project,
          dataDir: options.dataDir,
          loaded: {
            nodes: resolved.nodes.length,
            relationships: resolved.relationships.length,
          },
          stats,
          unknownConcepts: Object.fromEntries([...resolved.unknownConcepts.entries()].sort()),
          droppedRelationships: resolved.droppedRelationships,
          skippedRelationships: resolved.skippedRelationships,
        },
        null,
        2,
      ),
    );
  });
}

async function prepareLoadGraph(options: LoadOptions): Promise<ResolveResult> {
  const graphDir = resolve(options.dataDir, "graph", options.project);
  const dictionary = await loadConceptDictionary(options.dataDir, options.project);
  const endpointIndex = await buildEndpointIndex(options.dataDir, options.project);
  const reportPath = resolve(graphDir, "inference-dropped-relationships.json");
  const previousDropped = await readDroppedRelationships(reportPath);
  const records = await readJsonlRecords(graphDir);
  const parsed = records.filter((record) => record.sourceFile === PARSED_GRAPH_FILE);
  const inferred = records.filter((record) => record.sourceFile === INFERRED_GRAPH_FILE);
  return resolveGraph({ parsed, inferred, dictionary, endpointIndex, previousDropped });
}

async function writeGraphToNeo4j(
  options: LoadOptions,
  graph: ResolveResult,
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
