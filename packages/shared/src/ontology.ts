import { z } from 'zod';

export const NODE_LABELS = [
  'Project',
  'Task',
  'Wiki',
  'Person',
  'Comment',
  'Concept',
  'Decision',
] as const;

export const NodeLabelSchema = z.enum(NODE_LABELS);
export type NodeLabel = z.infer<typeof NodeLabelSchema>;

export const NODE_KEY_PROPERTIES = {
  Project: 'code',
  Task: 'number',
  Wiki: 'pageId',
  Person: 'memberId',
  Comment: 'commentId',
  Concept: 'name',
  Decision: 'id',
} as const satisfies Record<NodeLabel, string>;

export type NodeKeyProperty = (typeof NODE_KEY_PROPERTIES)[NodeLabel];

export const RELATIONSHIP_TYPES = [
  'CONTAINS',
  'ASSIGNED_TO',
  'AUTHORED',
  'COMMENTED',
  'HAS_COMMENT',
  'TAGGED',
  'REFERENCES',
  'CHILD_OF',
  'MENTIONS',
  'DOCUMENTS',
  'DEPENDS_ON',
  'DECIDED_IN',
  'EVIDENCED_BY',
  'AFFECTS',
  'RELATES_TO',
] as const;

export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const CONCEPT_KINDS = ['product', 'component', 'type', 'tech', 'code-ref'] as const;
export const ConceptKindSchema = z.enum(CONCEPT_KINDS);
export type ConceptKind = z.infer<typeof ConceptKindSchema>;

export const RELATES_TO_KINDS = ['precedes', 'causes', 'follows-up'] as const;
export const RelatesToKindSchema = z.enum(RELATES_TO_KINDS);
export type RelatesToKind = z.infer<typeof RelatesToKindSchema>;

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
