import { BadRequestException, Injectable } from "@nestjs/common";
import type { GraphSamplesResponse, GraphSearchResponse, GraphStatsResponse, NeighborsResponse } from "@devloop/shared";
import {
  GraphSamplesQuerySchema,
  GraphSearchQuerySchema,
  NeighborsQuerySchema,
  NODE_KEY_PROPERTIES,
  NodeLabelSchema,
  RelationshipTypeSchema,
} from "@devloop/shared";
import { int } from "neo4j-driver";
import { Neo4jService } from "./neo4j.service";
import { QueryService, uniqueNodes } from "./query/query.service";

const RELATIONSHIP_ENDPOINT_SORT = (alias: "start" | "end") =>
  `coalesce(toString(${alias}.code), toString(${alias}.number), toString(${alias}.pageId), ` +
  `toString(${alias}.memberId), toString(${alias}.commentId), toString(${alias}.name), toString(${alias}.id))`;

@Injectable()
export class GraphQueryService {
  constructor(
    private readonly neo4jService: Neo4jService,
    private readonly queryService: QueryService,
  ) {}

  async stats(): Promise<GraphStatsResponse> {
    return this.neo4jService.executeRead(async (session) => {
      const nodeResult = await session.run("MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY label");
      const relResult = await session.run("MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY type");
      return {
        nodes: Object.fromEntries(nodeResult.records.map((record) => [record.get("label"), toSafeNumber(record.get("count"))])),
        relationships: Object.fromEntries(relResult.records.map((record) => [record.get("type"), toSafeNumber(record.get("count"))])),
      };
    });
  }

  async search(rawQ = ""): Promise<GraphSearchResponse> {
    const { q } = GraphSearchQuerySchema.parse({ q: rawQ });
    if (!q.trim()) return [];
    const results = await this.queryService.fulltextSearch(q, 25);
    return uniqueNodes(results.map(({ node }) => node)).slice(0, 25);
  }

  async samples(rawLabel = "", rawRelationship = "", rawOffset = "0", rawLimit = "5"): Promise<GraphSamplesResponse> {
    const parsedPagination = GraphSamplesQuerySchema.safeParse({
      offset: rawOffset,
      limit: rawLimit,
    });
    if (!parsedPagination.success) {
      throw new BadRequestException("offset must be a non-negative safe integer and limit must be an integer between 1 and 100.");
    }
    const { offset, limit } = parsedPagination.data;

    if (rawLabel) {
      const parsedLabel = NodeLabelSchema.safeParse(rawLabel);
      if (!parsedLabel.success) {
        throw new BadRequestException("label must be a known ontology node label.");
      }
      return this.neo4jService.executeRead(async (session) => {
        const match = `MATCH (node:${parsedLabel.data})`;
        const countResult = await session.run(`${match} RETURN count(*) AS total`);
        const result = await session.run(
          `${match} RETURN node ` + `ORDER BY node.${NODE_KEY_PROPERTIES[parsedLabel.data]}, elementId(node) ` + "SKIP $offset LIMIT $limit",
          { offset: int(offset), limit: int(limit) },
        );
        return {
          ...this.neo4jService.evidenceFromResult(result),
          total: resultTotal(countResult),
          offset,
          limit,
        };
      });
    }

    if (rawRelationship) {
      const parsedRelationship = RelationshipTypeSchema.safeParse(rawRelationship);
      if (!parsedRelationship.success) {
        throw new BadRequestException("relationship must be a known ontology relationship type.");
      }
      return this.neo4jService.executeRead(async (session) => {
        const match = `MATCH (start)-[relationship:${parsedRelationship.data}]->(end)`;
        const countResult = await session.run(`${match} RETURN count(*) AS total`);
        const result = await session.run(
          `${match} RETURN start, relationship, end ` +
            `ORDER BY ${RELATIONSHIP_ENDPOINT_SORT("start")}, elementId(start), ` +
            `${RELATIONSHIP_ENDPOINT_SORT("end")}, elementId(end), elementId(relationship) ` +
            "SKIP $offset LIMIT $limit",
          { offset: int(offset), limit: int(limit) },
        );
        return {
          ...this.neo4jService.evidenceFromResult(result),
          total: resultTotal(countResult),
          offset,
          limit,
        };
      });
    }

    throw new BadRequestException("label or relationship query is required.");
  }

  async neighbors(id: string, rawDepth = "1"): Promise<NeighborsResponse> {
    const { depth } = NeighborsQuerySchema.parse({ depth: rawDepth });
    if (depth > 5) {
      throw new BadRequestException("depth must be between 1 and 5.");
    }
    return this.neo4jService.executeRead(async (session) => {
      const result = await session.run(
        `
        MATCH (n)
        WHERE elementId(n) = $id
        OPTIONAL MATCH path = (n)-[*1..${depth}]-(m)
        RETURN n, collect(path) AS paths
        `,
        { id },
      );
      return this.neo4jService.evidenceFromResult(result);
    });
  }
}

function toSafeNumber(value: { toNumber?: () => number } | number): number {
  return typeof value === "number" ? value : (value.toNumber?.() ?? Number(value));
}

function resultTotal(result: { records: { get(key: string): { toNumber?: () => number } | number }[] }): number {
  return toSafeNumber(result.records[0]?.get("total") ?? 0);
}
