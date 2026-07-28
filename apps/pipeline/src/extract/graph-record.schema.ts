import { OntologyNodeSchema, OntologyRelationshipSchema, type NodeLabel, type OntologyNode, type OntologyRelationship } from "@devloop/shared";
import { z } from "zod";

export const GraphRecordSchema = z.union([OntologyNodeSchema, OntologyRelationshipSchema]);
export type GraphRecord = z.infer<typeof GraphRecordSchema>;

export function nodeRef(label: NodeLabel, key: string | number): string {
  return `${label}:${String(key)}`;
}

export function isOntologyNode(record: GraphRecord): record is OntologyNode {
  return "label" in record;
}

export function isOntologyRelationship(record: GraphRecord): record is OntologyRelationship {
  return "type" in record;
}
