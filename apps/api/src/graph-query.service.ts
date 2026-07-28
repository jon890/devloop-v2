import { BadRequestException, Injectable } from "@nestjs/common";
import type { GraphSearchResponse, GraphStatsResponse, NeighborsResponse } from "@devloop/shared";
import { GraphSearchQuerySchema, NeighborsQuerySchema, NodeLabelSchema, RelationshipTypeSchema } from "@devloop/shared";
import { Neo4jService } from "./neo4j.service";
import { QueryService, uniqueNodes } from "./query/query.service";

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

  async samples(rawLabel = "", rawRelationship = ""): Promise<NeighborsResponse> {
    if (rawLabel) {
      const parsedLabel = NodeLabelSchema.safeParse(rawLabel);
      if (!parsedLabel.success) {
        throw new BadRequestException("label must be a known ontology node label.");
      }
      return this.neo4jService.executeRead(async (session) => {
        const result = await session.run(`MATCH (node:${parsedLabel.data}) RETURN node LIMIT 5`);
        return this.neo4jService.evidenceFromResult(result);
      });
    }

    if (rawRelationship) {
      const parsedRelationship = RelationshipTypeSchema.safeParse(rawRelationship);
      if (!parsedRelationship.success) {
        throw new BadRequestException("relationship must be a known ontology relationship type.");
      }
      return this.neo4jService.executeRead(async (session) => {
        const result = await session.run(
          `MATCH (start)-[relationship:${parsedRelationship.data}]->(end) ` + "RETURN start, relationship, end LIMIT 5",
        );
        return this.neo4jService.evidenceFromResult(result);
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
