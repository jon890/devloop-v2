import { z } from "zod";
import { CONCEPT_KINDS, NODE_KEY_PROPERTIES, NODE_LABELS, RELATES_TO_KINDS, RELATIONSHIP_TYPES } from "./ontology.const";

export const NodeLabelSchema = z.enum(NODE_LABELS);
export type NodeLabel = z.infer<typeof NodeLabelSchema>;

export type NodeKeyProperty = (typeof NODE_KEY_PROPERTIES)[NodeLabel];

export type OntologyNodeDefinition = {
  label: NodeLabel;
  key: NodeKeyProperty;
  properties: readonly string[];
  description: string;
};

export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export type OntologyRelationshipDirection = {
  from: NodeLabel;
  to: NodeLabel;
};

export type OntologyRelationshipDefinition = {
  type: RelationshipType;
  directions: readonly OntologyRelationshipDirection[];
  description: string;
  properties?: readonly string[];
};

export const ConceptKindSchema = z.enum(CONCEPT_KINDS);
export type ConceptKind = z.infer<typeof ConceptKindSchema>;

export const RelatesToKindSchema = z.enum(RELATES_TO_KINDS);
export type RelatesToKind = z.infer<typeof RelatesToKindSchema>;

export const OntologyNodeDefinitionSchema = z.object({
  label: NodeLabelSchema,
  key: z.string().min(1),
  properties: z.array(z.string().min(1)),
  description: z.string().min(1),
});

export const OntologyRelationshipDirectionSchema = z.object({
  from: NodeLabelSchema,
  to: NodeLabelSchema,
});

export const OntologyRelationshipDefinitionSchema = z.object({
  type: RelationshipTypeSchema,
  directions: z.array(OntologyRelationshipDirectionSchema).min(1),
  description: z.string().min(1),
  properties: z.array(z.string().min(1)).optional(),
});

export const OntologyNodeSchema = z.object({
  label: NodeLabelSchema,
  key: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
});
export type OntologyNode = z.infer<typeof OntologyNodeSchema>;

export const OntologyRelationshipSchema = z.object({
  type: RelationshipTypeSchema,
  startKey: z.string().min(1),
  endKey: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).default({}),
});
export type OntologyRelationship = z.infer<typeof OntologyRelationshipSchema>;
