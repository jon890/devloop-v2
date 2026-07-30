import "reflect-metadata";
import { resolve } from "node:path";
import neo4j, { type Driver, type Integer, type Session } from "neo4j-driver";
import {
  NODE_KEY_PROPERTIES,
  NODE_LABELS,
  RELATIONSHIP_TYPES,
  type NodeLabel,
  type OntologyNode,
  type OntologyRelationship,
  type RelationshipType,
} from "@devloop/shared";
import { DEFAULT_PROJECT, readDataDirFlag, readFlag } from "../cli-options";
import { type PipelineConfig, withPipelineConfig } from "../config";
import { readResolveInput } from "../resolve/io";
import { normalizedKey } from "../resolve/node-merge";
import { resolveGraph } from "../resolve/resolve";
import type { ResolveResult } from "../resolve/resolve.schema";
import { RELATIONSHIP_IDENTITY_PROPERTIES } from "./sync.const";
import { neo4jCredentials, requireNeo4jConfig } from "./neo4j-config";

export interface LoadOptions {
  project: string;
  dataDir: string;
  config: PipelineConfig;
}

export interface LoadStats {
  nodes: Record<string, number>;
  relationships: Record<string, number>;
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

function parseArgs(args: readonly string[], config: PipelineConfig): Omit<LoadOptions, "config"> {
  const project = readFlag(args, "--project") ?? DEFAULT_PROJECT;
  const dataDir = readDataDirFlag(args, config) ?? resolve(__dirname, "../../data");

  return { project, dataDir: resolve(dataDir) };
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

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
}

function stripResolverProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const { startLabel: _startLabel, endLabel: _endLabel, ...rest } = properties;
  return rest;
}

async function collectStats(session: Session): Promise<LoadStats> {
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

/**
 * `sync-neo4j` 표준출력 요약을 조립한다. Neo4j 접속 없이 테스트하기 위해 `loadGraph` 에서
 * 떼어낸 순수 함수다 — `sync.test.ts` 가 이 함수만 호출해 출력 스키마(`unknownConcepts` 가
 * 객체 형태인지 등)를 DB 없이 고정한다.
 */
export function buildLoadSummary(options: Pick<LoadOptions, "project" | "dataDir">, resolved: ResolveResult, stats: LoadStats): unknown {
  return {
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
  };
}

export async function loadGraph(options: LoadOptions): Promise<void> {
  requireNeo4jConfig(options.config, "sync-neo4j");
  const resolved = await prepareLoadGraph(options);
  await writeGraphToNeo4j(options, resolved, (stats) => {
    console.log(JSON.stringify(buildLoadSummary(options, resolved, stats), null, 2));
  });
}

async function prepareLoadGraph(options: LoadOptions): Promise<ResolveResult> {
  const input = await readResolveInput(options.dataDir, options.project);
  return resolveGraph(input);
}

async function writeGraphToNeo4j(
  options: LoadOptions,
  graph: ResolveResult,
  onStatsCollected: (stats: { nodes: Record<string, number>; relationships: Record<string, number> }) => void,
): Promise<{
  nodes: Record<string, number>;
  relationships: Record<string, number>;
}> {
  const dbConfig = requireNeo4jConfig(options.config, "sync-neo4j");
  const uri = dbConfig.neo4j.uri;
  const { user, password } = neo4jCredentials(dbConfig);
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database: "neo4j" });

  try {
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
  void withPipelineConfig((config) => loadGraph({ ...parseArgs(process.argv.slice(2), config), config })).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
