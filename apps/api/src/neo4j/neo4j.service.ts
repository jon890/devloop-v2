import { Inject, Injectable, InternalServerErrorException, OnApplicationShutdown } from "@nestjs/common";
import type { GraphNode, GraphRel } from "@devloop/shared";
import { NODE_KEY_PROPERTIES, NODE_LABELS, RELATIONSHIP_TYPES } from "@devloop/shared";
import neo4j, { Driver, Integer, Node, Path, Relationship, Session, auth, int, isInt } from "neo4j-driver";
import { API_CONFIG, type ApiConfig } from "../config";
import { COMMENT_DISPLAY_LIMIT } from "./neo4j.const";

type NeoValue = null | string | number | boolean | Integer | Date | NeoValue[] | { [key: string]: NeoValue };

interface NeoRecordLike {
  keys: readonly PropertyKey[];
  get(key: PropertyKey): unknown;
}

interface NeoResultLike {
  records: NeoRecordLike[];
}

@Injectable()
export class Neo4jService implements OnApplicationShutdown {
  private readonly driver: Driver;
  private readonly database: string;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.database = config.neo4j.database;
    this.driver = neo4j.driver(config.neo4j.uri, auth.basic(config.neo4j.user, config.neo4j.password));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.driver.close();
  }

  readSession(): Session {
    return this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.READ,
    });
  }

  async executeRead<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const session = this.readSession();
    try {
      return await work(session);
    } finally {
      await session.close();
    }
  }

  nodeToGraphNode(node: Node): GraphNode {
    const label = NODE_LABELS.find((candidate) => node.labels.includes(candidate));
    if (!label) {
      throw new InternalServerErrorException(`Unknown node label: ${node.labels.join(", ")}`);
    }
    const properties = sanitizeProperties(node.properties);
    const keyProperty = NODE_KEY_PROPERTIES[label];
    const key = String(properties[keyProperty] ?? node.elementId);
    return {
      id: node.elementId,
      label,
      key,
      display: displayFor(label, properties, key),
      properties,
    };
  }

  relationshipToGraphRel(rel: Relationship): GraphRel {
    const type = RELATIONSHIP_TYPES.find((candidate) => candidate === rel.type);
    if (!type) {
      throw new InternalServerErrorException(`Unknown relationship type: ${rel.type}`);
    }
    return {
      id: rel.elementId,
      type,
      startId: rel.startNodeElementId ?? integerToString(rel.start),
      endId: rel.endNodeElementId ?? integerToString(rel.end),
      properties: sanitizeProperties(rel.properties),
    };
  }

  evidenceFromResult(result: NeoResultLike): {
    nodes: GraphNode[];
    relationships: GraphRel[];
  } {
    const nodes = new Map<string, GraphNode>();
    const relationships = new Map<string, GraphRel>();
    for (const record of result.records) {
      for (const key of record.keys) {
        collectEvidence(record.get(key), nodes, relationships, this);
      }
    }
    return {
      nodes: [...nodes.values()],
      relationships: [...relationships.values()],
    };
  }
}

function collectEvidence(value: unknown, nodes: Map<string, GraphNode>, relationships: Map<string, GraphRel>, mapper: Neo4jService): void {
  if (!value) return;
  if (value instanceof Node) {
    const node = mapper.nodeToGraphNode(value);
    nodes.set(node.id, node);
    return;
  }
  if (value instanceof Relationship) {
    const rel = mapper.relationshipToGraphRel(value);
    relationships.set(rel.id, rel);
    return;
  }
  if (value instanceof Path) {
    collectEvidence(value.start, nodes, relationships, mapper);
    collectEvidence(value.end, nodes, relationships, mapper);
    for (const segment of value.segments) {
      collectEvidence(segment.start, nodes, relationships, mapper);
      collectEvidence(segment.relationship, nodes, relationships, mapper);
      collectEvidence(segment.end, nodes, relationships, mapper);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidence(item, nodes, relationships, mapper);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectEvidence(item, nodes, relationships, mapper);
    }
  }
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, sanitizeValue(value)]));
}

function sanitizeValue(value: unknown): unknown {
  if (isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, NeoValue>).map(([key, nested]) => [key, sanitizeValue(nested)]));
  }
  return value;
}

export function displayFor(label: GraphNode["label"], properties: Record<string, unknown>, key: string): string {
  if (label === "Task") return String(properties.subject ?? key);
  if (label === "Wiki") return String(properties.subject ?? key);
  if (label === "Person") return String(properties.name ?? key);
  if (label === "Concept") return String(properties.name ?? key);
  if (label === "Project") return String(properties.name ?? key);
  if (label === "Decision") return String(properties.summary ?? key);
  if (label === "Comment") return truncateDisplay(String(properties.excerpt ?? key));
  return key;
}

/**
 * `Comment` 의 `excerpt` 는 최대 6,000자다. 목록 표시에 그 전체를 넣지 않는다.
 *
 * 저장한 본문은 길게 두고 표시만 짧게 하는 것이다. 근거 노드의 `excerpt` 속성은 그대로 길어야
 * 답변이 인용할 수 있으므로 여기서 자르는 값은 `display` 뿐이다.
 */
function truncateDisplay(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= COMMENT_DISPLAY_LIMIT ? collapsed : `${collapsed.slice(0, COMMENT_DISPLAY_LIMIT)}…`;
}

function integerToString(value: Integer): string {
  return int(value).toString();
}
