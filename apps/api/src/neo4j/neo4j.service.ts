import {
  Injectable,
  InternalServerErrorException,
  OnApplicationShutdown,
} from "@nestjs/common";
import type { GraphNode, GraphRel } from "@devloop/shared";
import {
  NODE_KEY_PROPERTIES,
  NODE_LABELS,
  RELATIONSHIP_TYPES,
} from "@devloop/shared";
import neo4j, {
  Driver,
  Integer,
  Node,
  Path,
  Relationship,
  Session,
  auth,
  int,
  isInt,
} from "neo4j-driver";

type NeoValue =
  | null
  | string
  | number
  | boolean
  | Integer
  | Date
  | NeoValue[]
  | { [key: string]: NeoValue };

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

  constructor() {
    const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
    const user =
      process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "neo4j";
    const password =
      process.env.NEO4J_PASSWORD ??
      process.env.NEO4J_PASS ??
      parseNeo4jAuthPassword() ??
      "devloop-password";
    this.driver = neo4j.driver(uri, auth.basic(user, password));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.driver.close();
  }

  readSession(): Session {
    return this.driver.session({
      database: process.env.NEO4J_DATABASE ?? "neo4j",
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
    const label = NODE_LABELS.find((candidate) =>
      node.labels.includes(candidate),
    );
    if (!label) {
      throw new InternalServerErrorException(
        `Unknown node label: ${node.labels.join(", ")}`,
      );
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
      throw new InternalServerErrorException(
        `Unknown relationship type: ${rel.type}`,
      );
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

function collectEvidence(
  value: unknown,
  nodes: Map<string, GraphNode>,
  relationships: Map<string, GraphRel>,
  mapper: Neo4jService,
): void {
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
    for (const item of value)
      collectEvidence(item, nodes, relationships, mapper);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectEvidence(item, nodes, relationships, mapper);
    }
  }
}

function sanitizeProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      sanitizeValue(value),
    ]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (isInt(value))
    return value.inSafeRange() ? value.toNumber() : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, NeoValue>).map(([key, nested]) => [
        key,
        sanitizeValue(nested),
      ]),
    );
  }
  return value;
}

function displayFor(
  label: GraphNode["label"],
  properties: Record<string, unknown>,
  key: string,
): string {
  if (label === "Task") return String(properties.subject ?? key);
  if (label === "Wiki") return String(properties.subject ?? key);
  if (label === "Person") return String(properties.name ?? key);
  if (label === "Concept") return String(properties.name ?? key);
  if (label === "Project") return String(properties.name ?? key);
  if (label === "Decision") return String(properties.summary ?? key);
  if (label === "Comment") return String(properties.excerpt ?? key);
  return key;
}

function parseNeo4jAuthPassword(): string | undefined {
  const authValue = process.env.NEO4J_AUTH;
  if (!authValue) return undefined;
  const separator = authValue.indexOf("/");
  return separator >= 0 ? authValue.slice(separator + 1) : undefined;
}

function integerToString(value: Integer): string {
  return int(value).toString();
}
