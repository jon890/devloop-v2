import { z } from 'zod';
import { NodeLabelSchema, RelationshipTypeSchema } from './ontology';

export const GraphNodeSchema = z.object({
  id: z.string(),
  label: NodeLabelSchema,
  key: z.string(),
  display: z.string(),
  properties: z.record(z.string(), z.unknown()),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphRelSchema = z.object({
  id: z.string(),
  type: RelationshipTypeSchema,
  startId: z.string(),
  endId: z.string(),
  properties: z.record(z.string(), z.unknown()),
});
export type GraphRel = z.infer<typeof GraphRelSchema>;

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

export const GraphSearchQuerySchema = z.object({
  q: z.string().default(''),
});
export type GraphSearchQuery = z.infer<typeof GraphSearchQuerySchema>;

export const GraphSearchResponseSchema = z.array(GraphNodeSchema);
export type GraphSearchResponse = z.infer<typeof GraphSearchResponseSchema>;
