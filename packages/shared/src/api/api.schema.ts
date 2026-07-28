import { z } from "zod";
import { OntologyNodeDefinitionSchema, OntologyRelationshipDefinitionSchema } from "../ontology/ontology.schema";
import { GraphNodeSchema, GraphRelSchema } from "../graph/graph.schema";

export const EvidenceSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  relationships: z.array(GraphRelSchema),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const QueryRequestSchema = z.object({
  question: z.string().min(1),
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

export const QueryResponseSchema = z.object({
  answer: z.string(),
  evidence: EvidenceSchema,
  cypher: z.string(),
});
export type QueryResponse = z.infer<typeof QueryResponseSchema>;

export const GraphStatsResponseSchema = z.object({
  nodes: z.record(z.string(), z.number().int().nonnegative()),
  relationships: z.record(z.string(), z.number().int().nonnegative()),
});
export type GraphStatsResponse = z.infer<typeof GraphStatsResponseSchema>;

export const NeighborsQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).default(1),
});
export type NeighborsQuery = z.infer<typeof NeighborsQuerySchema>;

export const NeighborsResponseSchema = EvidenceSchema;
export type NeighborsResponse = z.infer<typeof NeighborsResponseSchema>;

export const GraphSamplesQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(5),
});
export type GraphSamplesQuery = z.infer<typeof GraphSamplesQuerySchema>;

export const GraphSamplesResponseSchema = EvidenceSchema.extend({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
});
export type GraphSamplesResponse = z.infer<typeof GraphSamplesResponseSchema>;

export const GraphSearchQuerySchema = z.object({
  q: z.string().default(""),
});
export type GraphSearchQuery = z.infer<typeof GraphSearchQuerySchema>;

export const GraphSearchResponseSchema = z.array(GraphNodeSchema);
export type GraphSearchResponse = z.infer<typeof GraphSearchResponseSchema>;

export const OntologyResponseSchema = z.object({
  nodes: z.array(OntologyNodeDefinitionSchema),
  relationships: z.array(OntologyRelationshipDefinitionSchema),
});
export type OntologyResponse = z.infer<typeof OntologyResponseSchema>;
