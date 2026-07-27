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

export type OntologyNodeDefinition = {
  label: NodeLabel;
  key: NodeKeyProperty;
  properties: readonly string[];
  description: string;
};

export const ONTOLOGY_NODE_DEFINITIONS = [
  {
    label: 'Project',
    key: 'code',
    properties: ['code', 'name'],
    description: 'Dooray 프로젝트를 나타내며 업무와 위키 페이지의 소속 경계를 제공한다.',
  },
  {
    label: 'Task',
    key: 'number',
    properties: ['number', 'subject', 'workflowClass', 'createdAt', 'url', 'bodyExcerpt'],
    description: 'Dooray 업무를 나타내며 진행 흐름, 본문 요약, 참조 링크의 중심 노드가 된다.',
  },
  {
    label: 'Wiki',
    key: 'pageId',
    properties: ['pageId', 'subject', 'parentId'],
    description: 'Dooray 위키 페이지를 나타내며 문서 계층과 개념 설명의 출처가 된다.',
  },
  {
    label: 'Person',
    key: 'memberId',
    properties: ['memberId', 'name'],
    description: '업무 담당자, 작성자, 댓글 작성자를 나타내는 사람 노드다.',
  },
  {
    label: 'Comment',
    key: 'commentId',
    properties: ['commentId', 'excerpt', 'createdAt'],
    description: 'Dooray 업무 댓글을 나타내며 결정 근거와 대화 맥락을 보존한다.',
  },
  {
    label: 'Concept',
    key: 'name',
    properties: ['name', 'kind'],
    description: '제품, 컴포넌트, 유형, 기술, 코드 참조 같은 표준화된 개념을 나타낸다.',
  },
  {
    label: 'Decision',
    key: 'id',
    properties: ['id', 'summary', 'decidedAt'],
    description: '업무와 댓글에서 추출한 의사결정을 나타내며 배경과 근거 질의의 핵심 노드다.',
  },
] as const satisfies readonly OntologyNodeDefinition[];

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

export const ONTOLOGY_RELATIONSHIP_DEFINITIONS = [
  {
    type: 'CONTAINS',
    directions: [
      { from: 'Project', to: 'Task' },
      { from: 'Project', to: 'Wiki' },
    ],
    description: '프로젝트가 포함하는 업무와 위키 페이지를 연결한다.',
  },
  {
    type: 'ASSIGNED_TO',
    directions: [{ from: 'Task', to: 'Person' }],
    description: '업무의 담당자 또는 참조자를 연결한다.',
  },
  {
    type: 'AUTHORED',
    directions: [{ from: 'Person', to: 'Task' }],
    description: '사람이 작성한 업무를 연결한다.',
  },
  {
    type: 'COMMENTED',
    directions: [{ from: 'Person', to: 'Comment' }],
    description: '사람이 작성한 댓글을 연결한다.',
  },
  {
    type: 'HAS_COMMENT',
    directions: [{ from: 'Task', to: 'Comment' }],
    description: '업무와 그 업무에 달린 댓글을 연결한다.',
  },
  {
    type: 'TAGGED',
    directions: [{ from: 'Task', to: 'Concept' }],
    description: '업무에 부여된 유형, 제품, 컴포넌트 차원의 태그 개념을 연결한다.',
    properties: ['dimension'],
  },
  {
    type: 'REFERENCES',
    directions: [{ from: 'Task', to: 'Task' }],
    description: '업무 본문이나 댓글에서 참조한 다른 업무를 연결한다.',
  },
  {
    type: 'CHILD_OF',
    directions: [
      { from: 'Task', to: 'Task' },
      { from: 'Wiki', to: 'Wiki' },
    ],
    description: '업무 또는 위키 페이지의 부모-자식 계층을 연결한다.',
  },
  {
    type: 'MENTIONS',
    directions: [
      { from: 'Task', to: 'Concept' },
      { from: 'Wiki', to: 'Concept' },
    ],
    description: '업무나 위키 본문에서 언급된 개념을 연결한다.',
  },
  {
    type: 'DOCUMENTS',
    directions: [{ from: 'Wiki', to: 'Concept' }],
    description: '위키 페이지가 설명하거나 문서화하는 개념을 연결한다.',
  },
  {
    type: 'DEPENDS_ON',
    directions: [{ from: 'Concept', to: 'Concept' }],
    description: '시스템, 컴포넌트, 기술 개념 사이의 의존 관계를 연결한다.',
  },
  {
    type: 'DECIDED_IN',
    directions: [{ from: 'Decision', to: 'Task' }],
    description: '의사결정이 내려진 업무를 연결한다.',
  },
  {
    type: 'EVIDENCED_BY',
    directions: [
      { from: 'Decision', to: 'Task' },
      { from: 'Decision', to: 'Comment' },
    ],
    description: '의사결정을 뒷받침하는 업무나 댓글 근거를 연결한다.',
  },
  {
    type: 'AFFECTS',
    directions: [{ from: 'Decision', to: 'Concept' }],
    description: '의사결정이 영향을 주는 개념을 연결한다.',
  },
  {
    type: 'RELATES_TO',
    directions: [{ from: 'Task', to: 'Task' }],
    description: '업무 사이의 선후, 인과, 후속 관계를 연결한다.',
    properties: ['kind'],
  },
] as const satisfies readonly OntologyRelationshipDefinition[];

export const CONCEPT_KINDS = ['product', 'component', 'type', 'tech', 'code-ref'] as const;
export const ConceptKindSchema = z.enum(CONCEPT_KINDS);
export type ConceptKind = z.infer<typeof ConceptKindSchema>;

export const RELATES_TO_KINDS = ['precedes', 'causes', 'follows-up'] as const;
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
