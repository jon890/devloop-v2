import type {
  GraphNode,
  GraphRel,
  GraphSamplesResponse,
  GraphSearchResponse,
  GraphStatsResponse,
  NeighborsResponse,
  OntologyResponse,
  QueryResponse,
} from "@devloop/shared";
import { ONTOLOGY_NODE_DEFINITIONS, ONTOLOGY_RELATIONSHIP_DEFINITIONS } from "@devloop/shared";

const nodes: Record<string, GraphNode> = {
  "task-483": {
    id: "task-483",
    label: "Task",
    key: "483",
    display: "OCR 모델 서버 무중단 배포 전환",
    properties: { number: 483, workflowClass: "closed", createdAt: "2026-05-12" },
  },
  "decision-483-1": {
    id: "decision-483-1",
    label: "Decision",
    key: "483-1",
    display: "카나리 배포를 기본 전략으로 채택",
    properties: { decidedAt: "2026-05-19" },
  },
  "concept-model-server": {
    id: "concept-model-server",
    label: "Concept",
    key: "모델 서버",
    display: "모델 서버",
    properties: { kind: "component" },
  },
  "concept-canary": {
    id: "concept-canary",
    label: "Concept",
    key: "카나리 배포",
    display: "카나리 배포",
    properties: { kind: "tech" },
  },
  "person-minseo": {
    id: "person-minseo",
    label: "Person",
    key: "member-17",
    display: "김민서",
    properties: { name: "김민서" },
  },
  "comment-483-12": {
    id: "comment-483-12",
    label: "Comment",
    key: "483-12",
    display: "오류율 1% 기준으로 자동 롤백합니다.",
    properties: { createdAt: "2026-05-19" },
  },
  "wiki-deploy": {
    id: "wiki-deploy",
    label: "Wiki",
    key: "wiki-42",
    display: "모델 서버 배포 운영 가이드",
    properties: { pageId: "42" },
  },
  "task-491": {
    id: "task-491",
    label: "Task",
    key: "491",
    display: "배포 모니터링 대시보드 개선",
    properties: { number: 491, workflowClass: "closed" },
  },
  "project-tc-ocr": {
    id: "project-tc-ocr",
    label: "Project",
    key: "tc-ocr",
    display: "TC OCR",
    properties: { code: "tc-ocr" },
  },
};

const rels: Record<string, GraphRel> = {
  "rel-task-decision": {
    id: "rel-task-decision",
    type: "DECIDED_IN",
    startId: "decision-483-1",
    endId: "task-483",
    properties: {},
  },
  "rel-decision-server": {
    id: "rel-decision-server",
    type: "AFFECTS",
    startId: "decision-483-1",
    endId: "concept-model-server",
    properties: {},
  },
  "rel-decision-canary": {
    id: "rel-decision-canary",
    type: "AFFECTS",
    startId: "decision-483-1",
    endId: "concept-canary",
    properties: {},
  },
  "rel-task-person": {
    id: "rel-task-person",
    type: "ASSIGNED_TO",
    startId: "task-483",
    endId: "person-minseo",
    properties: {},
  },
  "rel-decision-comment": {
    id: "rel-decision-comment",
    type: "EVIDENCED_BY",
    startId: "decision-483-1",
    endId: "comment-483-12",
    properties: {},
  },
  "rel-wiki-server": {
    id: "rel-wiki-server",
    type: "DOCUMENTS",
    startId: "wiki-deploy",
    endId: "concept-model-server",
    properties: {},
  },
  "rel-task-followup": {
    id: "rel-task-followup",
    type: "RELATES_TO",
    startId: "task-483",
    endId: "task-491",
    properties: { kind: "follows-up" },
  },
  "rel-project-task": {
    id: "rel-project-task",
    type: "CONTAINS",
    startId: "project-tc-ocr",
    endId: "task-483",
    properties: {},
  },
};

const evidenceNodeIds = ["task-483", "decision-483-1", "concept-model-server", "concept-canary", "person-minseo", "comment-483-12"];

export const mockQueryResponse: QueryResponse = {
  answer:
    "모델 서버의 무중단 배포에는 카나리 전략을 적용하기로 결정했습니다. 김민서 님이 담당하며, 신규 버전의 오류율이 1%를 넘으면 자동 롤백하는 기준을 함께 두었습니다. 따라서 배포 승인 전에는 카나리 구간의 오류율과 자동 롤백 설정을 먼저 확인하는 것이 좋습니다.",
  evidence: {
    nodes: evidenceNodeIds.map((id) => nodes[id]),
    relationships: [
      rels["rel-task-decision"],
      rels["rel-decision-server"],
      rels["rel-decision-canary"],
      rels["rel-task-person"],
      rels["rel-decision-comment"],
    ],
  },
  cypher: `MATCH (d:Decision)-[:DECIDED_IN]->(t:Task)-[:ASSIGNED_TO]->(p:Person)\nWHERE t.number = '483'\nOPTIONAL MATCH (d)-[:AFFECTS]->(c:Concept)\nOPTIONAL MATCH (d)-[:EVIDENCED_BY]->(e:Comment)\nRETURN d, t, p, c, e`,
};

export const mockStatsResponse: GraphStatsResponse = {
  nodes: { Project: 1, Task: 490, Wiki: 47, Person: 32, Comment: 1842, Concept: 126, Decision: 84 },
  relationships: {
    CONTAINS: 537,
    ASSIGNED_TO: 612,
    MENTIONS: 1278,
    DOCUMENTS: 183,
    DECIDED_IN: 84,
    EVIDENCED_BY: 109,
    RELATES_TO: 231,
  },
};

const neighborIds: Record<string, { nodes: string[]; rels: string[] }> = {
  "task-483": {
    nodes: ["task-483", "project-tc-ocr", "task-491"],
    rels: ["rel-project-task", "rel-task-followup"],
  },
  "concept-model-server": {
    nodes: ["concept-model-server", "wiki-deploy"],
    rels: ["rel-wiki-server"],
  },
};

export function mockNeighbors(nodeId: string): NeighborsResponse {
  const selection = neighborIds[nodeId] ?? {
    nodes: [nodeId, "wiki-deploy"],
    rels: nodeId === "wiki-deploy" ? ["rel-wiki-server"] : [],
  };

  return {
    nodes: selection.nodes.map((id) => nodes[id]).filter(Boolean),
    relationships: selection.rels.map((id) => rels[id]).filter(Boolean),
  };
}

export function mockSearchGraph(query: string): GraphSearchResponse {
  const normalized = query.trim().toLocaleLowerCase("ko-KR");
  if (!normalized) return [];
  return Object.values(nodes)
    .filter((node) => `${node.display} ${node.key}`.toLocaleLowerCase("ko-KR").includes(normalized))
    .slice(0, 25);
}

export function mockGraphSamples(kind: "label" | "relationship", value: string, offset = 0, limit = 5): GraphSamplesResponse {
  if (kind === "label") {
    const matchingNodes = Object.values(nodes).filter((node) => node.label === value);
    return {
      nodes: matchingNodes.slice(offset, offset + limit),
      relationships: [],
      total: matchingNodes.length,
      offset,
      limit,
    };
  }

  const matchingRelationships = Object.values(rels).filter((relationship) => relationship.type === value);
  const relationships = matchingRelationships.slice(offset, offset + limit);
  const nodeIds = new Set(relationships.flatMap((relationship) => [relationship.startId, relationship.endId]));
  return {
    nodes: Object.values(nodes).filter((node) => nodeIds.has(node.id)),
    relationships,
    total: matchingRelationships.length,
    offset,
    limit,
  };
}

export const mockOntologyResponse: OntologyResponse = {
  nodes: ONTOLOGY_NODE_DEFINITIONS.map((node) => ({
    ...node,
    properties: [...node.properties],
  })),
  relationships: ONTOLOGY_RELATIONSHIP_DEFINITIONS.map((relationship) => ({
    ...relationship,
    directions: relationship.directions.map((direction) => ({ ...direction })),
    properties: "properties" in relationship ? [...relationship.properties] : undefined,
  })),
};
