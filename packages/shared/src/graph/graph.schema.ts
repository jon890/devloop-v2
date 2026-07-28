import { z } from "zod";
import { NodeLabelSchema, RelationshipTypeSchema } from "../ontology/ontology.schema";

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
