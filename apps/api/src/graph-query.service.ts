import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  GraphNode,
  GraphRel,
  GraphSearchResponse,
  GraphStatsResponse,
  NeighborsResponse,
  QueryRequest,
  QueryResponse,
} from '@devloop/shared';
import {
  QueryRequestSchema,
  GraphSearchQuerySchema,
  NeighborsQuerySchema,
} from '@devloop/shared';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { LLM_CLI, LlmCli } from './llm-cli';
import { Neo4jService } from './neo4j.service';

const FULLTEXT_INDEXES = ['task_subject_fulltext', 'wiki_subject_fulltext', 'concept_name_fulltext'] as const;
const AnchorResponseSchema = z.object({ terms: z.array(z.string().min(1)).min(1) });
const CypherResponseSchema = z.object({ cypher: z.string().trim().min(1) });
const AnswerResponseSchema = z.object({ answer: z.string().trim().min(1) });
const EVIDENCE_NODE_LIMIT = 30;

@Injectable()
export class GraphQueryService {
  constructor(
    private readonly neo4jService: Neo4jService,
    @Inject(LLM_CLI) private readonly llmCli: LlmCli,
  ) {}

  async stats(): Promise<GraphStatsResponse> {
    return this.neo4jService.executeRead(async (session) => {
      const nodeResult = await session.run(
        'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY label',
      );
      const relResult = await session.run('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY type');
      return {
        nodes: Object.fromEntries(
          nodeResult.records.map((record) => [record.get('label'), toSafeNumber(record.get('count'))]),
        ),
        relationships: Object.fromEntries(
          relResult.records.map((record) => [record.get('type'), toSafeNumber(record.get('count'))]),
        ),
      };
    });
  }

  async search(rawQ = ''): Promise<GraphSearchResponse> {
    const { q } = GraphSearchQuerySchema.parse({ q: rawQ });
    if (!q.trim()) return [];
    const results = await this.fulltextSearch(q, 25);
    return uniqueNodes(results);
  }

  async neighbors(id: string, rawDepth = '1'): Promise<NeighborsResponse> {
    const { depth } = NeighborsQuerySchema.parse({ depth: rawDepth });
    if (depth > 5) {
      throw new BadRequestException('depth must be between 1 and 5.');
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

  async query(rawRequest: QueryRequest): Promise<QueryResponse> {
    const { question } = QueryRequestSchema.parse(rawRequest);
    const diagnostics: string[] = [];
    let terms: string[];
    try {
      terms = await this.extractAnchorTerms(question);
    } catch (error) {
      terms = [question];
      diagnostics.push(`anchor 용어 추출 실패: ${formatError(error)}`);
    }

    const searchResults = await Promise.allSettled(terms.map((term) => this.fulltextSearch(term, 5)));
    const anchors = uniqueNodes(
      searchResults.flatMap((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        diagnostics.push(`anchor 검색 실패(${terms[index]}): ${formatError(result.reason)}`);
        return [];
      }),
    );

    let cypher: string;
    try {
      cypher = await this.generateCypher(question, anchors);
    } catch (error) {
      const fallbackCypher = anchorFallbackCypher(anchors);
      const fallback = await this.executeGeneratedCypher(fallbackCypher);
      return {
        answer: failureAnswer(
          'Cypher 생성에 실패했습니다.',
          terms,
          anchors.length,
          [`생성 오류: ${formatError(error)}`, ...diagnostics],
        ),
        evidence: fallback.ok
          ? await this.buildQueryEvidence(fallback.evidence, emptyEvidence(), anchors)
          : refineQueryEvidence(emptyEvidence(), emptyEvidence(), anchors),
        cypher: fallbackCypher,
      };
    }

    const execution = await this.executeGeneratedCypher(cypher);
    let final = execution;
    if (execution.ok !== true) {
      try {
        const retryCypher = await this.generateCypher(question, anchors, {
          previousCypher: cypher,
          error: execution.error,
        });
        final = await this.executeGeneratedCypher(retryCypher);
      } catch (error) {
        return {
          answer: failureAnswer(
            `Cypher 실행에 실패했고 재생성도 완료하지 못했습니다: ${execution.error}`,
            terms,
            anchors.length,
            [`재생성 오류: ${formatError(error)}`, ...diagnostics],
          ),
          evidence: refineQueryEvidence(emptyEvidence(), emptyEvidence(), anchors),
          cypher: execution.cypher,
        };
      }
    }
    if (final.ok !== true) {
      return {
        answer: failureAnswer(
          `Cypher 실행에 실패했습니다: ${final.error}`,
          terms,
          anchors.length,
          diagnostics,
        ),
        evidence: refineQueryEvidence(emptyEvidence(), emptyEvidence(), anchors),
        cypher: final.cypher,
      };
    }

    let supportingEvidence = emptyEvidence();
    if (isAggregationCypher(final.cypher)) {
      try {
        const evidenceCypher = await this.generateEvidenceCypher(question, final.cypher, final.rows, anchors);
        const evidenceExecution = await this.executeGeneratedCypher(evidenceCypher);
        if (evidenceExecution.ok) {
          supportingEvidence = evidenceExecution.evidence;
        } else {
          diagnostics.push(`근거 Cypher 실행 실패: ${evidenceExecution.error}`);
        }
      } catch (error) {
        diagnostics.push(`근거 Cypher 생성 실패: ${formatError(error)}`);
      }
    }
    const evidence = await this.buildQueryEvidence(final.evidence, supportingEvidence, anchors);

    try {
      const answer = await this.synthesizeAnswer(question, final.rows, evidence);
      return { answer, evidence, cypher: final.cypher };
    } catch (error) {
      return {
        answer: synthesisFallbackAnswer(final.rows, terms, final.cypher, [
          `답변 합성 실패: ${formatError(error)}`,
          ...diagnostics,
        ]),
        evidence,
        cypher: final.cypher,
      };
    }
  }

  private async fulltextSearch(q: string, limit: number): Promise<GraphNode[]> {
    return this.neo4jService.executeRead(async (session) => {
      const result = await session.run(
        `
        UNWIND $indexes AS indexName
        CALL db.index.fulltext.queryNodes(indexName, $q, {limit: $perIndexLimit})
        YIELD node, score
        RETURN node, max(score) AS score
        ORDER BY score DESC
        LIMIT $limit
        `,
        {
          indexes: [...FULLTEXT_INDEXES],
          q,
          perIndexLimit: neo4j.int(limit),
          limit: neo4j.int(limit),
        },
      );
      return result.records.map((record) => this.neo4jService.nodeToGraphNode(record.get('node')));
    });
  }

  private async extractAnchorTerms(question: string): Promise<string[]> {
    const prompt = [
      '질문에서 Neo4j fulltext 검색 anchor로 쓸 핵심 용어를 3~7개 추출하라.',
      '응답은 반드시 JSON 하나만 출력한다.',
      '형식: {"terms":["용어"]}',
      `질문: ${question}`,
    ].join('\n');
    return (
      await this.completeStructured(prompt, AnchorResponseSchema, {
        timeoutMs: 60_000,
        model: queryLlmModel(),
      })
    ).terms;
  }

  private async generateCypher(
    question: string,
    anchors: GraphNode[],
    retry?: { previousCypher: string; error: string },
  ): Promise<string> {
    const prompt = [
      'Neo4j 지식그래프 질문을 읽기 전용 Cypher 하나로 변환하라.',
      '응답은 반드시 JSON 하나만 출력한다. 형식: {"cypher":"MATCH ... RETURN ... LIMIT 50"}',
      '쓰기 구문 CREATE, MERGE, SET, DELETE, REMOVE, DROP, LOAD CSV, CALL dbms/admin/apoc 는 금지한다.',
      '아래 허용 속성만 사용하고, 목록에 없는 속성(예: Wiki.title)은 절대 만들지 마라.',
      ontologySummary(),
      '태그 차원 조합 집계는 한 차원의 Concept로 Task를 필터링하고 같은 Task의 다른 TAGGED 관계를 별도로 MATCH해 다른 차원의 Concept별로 묶는 패턴이다.',
      '예시 질문: 유형 태그가 개선인 Task를 컴포넌트 Concept별로 집계해줘',
      '예시 Cypher: MATCH (t:Task)-[typeTag:TAGGED]->(:Concept {name:"개선"}) WHERE typeTag.dimension = "0" MATCH (t)-[groupTag:TAGGED]->(c:Concept) WHERE groupTag.dimension = "2" RETURN c.name, count(t)',
      '집계 질의의 Cypher는 집계 결과 행만 반환하라. 집계 뒤 근거 node/path를 재확장하거나 근거 수집용 LIMIT를 같은 쿼리에 넣지 마라. LIMIT는 집계 그룹에 적용한다.',
      '비집계 질의는 가능하면 node, relationship, path를 RETURN해서 근거 그래프를 포함하라.',
      'fulltext 검색으로 이미 찾은 anchor를 우선 사용하라. 관련 anchor는 label과 key에 맞는 실제 노드로 제한하고, display를 질문 용어 해석에 활용하라.',
      `Anchor nodes (label/key/display): ${JSON.stringify(anchorSummaries(anchors))}`,
      retry
        ? `이전 Cypher는 오류가 났다. 오류를 반영해 한 번만 고쳐라.\nPrevious: ${retry.previousCypher}\nError: ${retry.error}`
        : '',
      `Question: ${question}`,
    ].join('\n\n');
    return (
      await this.completeStructured(prompt, CypherResponseSchema, {
        timeoutMs: 90_000,
        model: queryLlmModel(),
      })
    ).cypher.trim();
  }

  private async generateEvidenceCypher(
    question: string,
    answerCypher: string,
    rows: Record<string, unknown>[],
    anchors: GraphNode[],
  ): Promise<string> {
    const prompt = [
      '집계 답변의 결과 행을 바꾸지 않는 읽기 전용 근거 수집 전용 Cypher 하나를 작성하라.',
      '응답은 반드시 JSON 하나만 출력한다. 형식: {"cypher":"MATCH ... RETURN nodes, relationships, paths LIMIT 50"}',
      '답변용 집계 Cypher를 다시 집계하거나 그 결과 행을 대체하지 마라. 관련 node, relationship, path만 별도로 반환하라.',
      '쓰기 구문 CREATE, MERGE, SET, DELETE, REMOVE, DROP, LOAD CSV, CALL dbms/admin/apoc 는 금지한다.',
      '아래 허용 속성과 관계 방향만 사용하라.',
      ontologySummary(),
      `Question: ${question}`,
      `Answer Cypher: ${answerCypher}`,
      `Complete aggregate rows: ${JSON.stringify(rows, jsonSafeReplacer)}`,
      `Anchor nodes (label/key/display): ${JSON.stringify(anchorSummaries(anchors))}`,
    ].join('\n\n');
    return (
      await this.completeStructured(prompt, CypherResponseSchema, {
        timeoutMs: 90_000,
        model: queryLlmModel(),
      })
    ).cypher.trim();
  }

  private async executeGeneratedCypher(
    cypher: string,
  ): Promise<
    | { ok: true; cypher: string; rows: Record<string, unknown>[]; evidence: NeighborsResponse }
    | { ok: false; cypher: string; error: string }
  > {
    try {
      assertReadOnlyCypher(cypher);
      return await this.neo4jService.executeRead(async (session) => {
        const result = await session.run(cypher);
        return {
          ok: true,
          cypher,
          rows: result.records.map((record) => record.toObject() as Record<string, unknown>),
          evidence: this.neo4jService.evidenceFromResult(result),
        };
      });
    } catch (error) {
      return { ok: false, cypher, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async buildQueryEvidence(
    answerEvidence: NeighborsResponse,
    supportingEvidence: NeighborsResponse,
    anchors: GraphNode[],
  ): Promise<NeighborsResponse> {
    const refined = refineQueryEvidence(answerEvidence, supportingEvidence, anchors);
    if (refined.nodes.length === 0) return refined;

    const nodeIds = refined.nodes.map((node) => node.id);
    const anchorIds = anchors.map((anchor) => anchor.id);
    const relationshipsBetweenNodes = await this.neo4jService.executeRead(async (session) => {
      const result = await session.run(
        `
        MATCH (start)-[relationship]-(end)
        WHERE
          (elementId(start) IN $nodeIds AND elementId(end) IN $nodeIds)
          OR (elementId(start) IN $nodeIds AND elementId(end) IN $anchorIds)
          OR (elementId(start) IN $anchorIds AND elementId(end) IN $nodeIds)
        RETURN relationship
        `,
        { nodeIds, anchorIds },
      );
      return this.neo4jService.evidenceFromResult(result);
    });
    return refineQueryEvidence(
      answerEvidence,
      mergeEvidence(supportingEvidence, relationshipsBetweenNodes),
      anchors,
    );
  }

  private async synthesizeAnswer(
    question: string,
    rows: Record<string, unknown>[],
    evidence: NeighborsResponse,
  ): Promise<string> {
    const prompt = [
      '질문과 Cypher 결과, 근거 그래프를 바탕으로 한국어 답변을 작성하라.',
      '응답은 반드시 JSON 하나만 출력한다. 형식: {"answer":"답변"}',
      `Question: ${question}`,
      `Rows: ${JSON.stringify(rows, jsonSafeReplacer)}`,
      `Evidence: ${JSON.stringify(evidence).slice(0, 20_000)}`,
    ].join('\n\n');
    return (
      await this.completeStructured(prompt, AnswerResponseSchema, {
        timeoutMs: 90_000,
        model: queryLlmModel(),
      })
    ).answer;
  }

  private async completeStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options: { timeoutMs: number; model?: string },
  ): Promise<T> {
    let retryPrompt = prompt;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.llmCli.complete(retryPrompt, options);
      try {
        return schema.parse(parseJson(result.text));
      } catch (error) {
        if (attempt === 1) {
          throw error;
        }
        retryPrompt = [
          prompt,
          '이전 응답이 JSON 계약 검증에 실패했다. 오류를 고쳐 JSON 하나만 다시 출력하라.',
          `Previous response: ${result.text.slice(0, 4_000)}`,
          `Validation error: ${formatError(error)}`,
        ].join('\n\n');
      }
    }
    throw new Error('Unreachable structured completion state.');
  }
}

function uniqueNodes(nodes: GraphNode[]): GraphNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function emptyEvidence(): NeighborsResponse {
  return { nodes: [], relationships: [] };
}

function anchorSummaries(anchors: GraphNode[]): Array<Pick<GraphNode, 'label' | 'key' | 'display'>> {
  return anchors.map(({ label, key, display }) => ({ label, key, display }));
}

function anchorFallbackCypher(anchors: GraphNode[]): string {
  if (anchors.length === 0) return 'MATCH (n) WHERE false RETURN n LIMIT 0';
  return `MATCH (n) WHERE elementId(n) IN ${JSON.stringify(anchors.map((anchor) => anchor.id))} RETURN n LIMIT 50`;
}

function isAggregationCypher(cypher: string): boolean {
  return /\b(?:count|sum|avg|min|max|collect|percentileCont|percentileDisc|stDev|stDevP)\s*\(/i.test(cypher);
}

function mergeEvidence(left: NeighborsResponse, right: NeighborsResponse): NeighborsResponse {
  return {
    nodes: uniqueNodes([...left.nodes, ...right.nodes]),
    relationships: [
      ...new Map([...left.relationships, ...right.relationships].map((relationship) => [relationship.id, relationship])).values(),
    ],
  };
}

export function refineQueryEvidence(
  answerEvidence: NeighborsResponse,
  supportingEvidence: NeighborsResponse,
  anchors: GraphNode[],
): NeighborsResponse {
  const answerNodeIds = new Set(answerEvidence.nodes.map((node) => node.id));
  const base = mergeEvidence(answerEvidence, supportingEvidence);
  const connectedNodeIds = new Set(
    base.relationships.flatMap((relationship) => [relationship.startId, relationship.endId]),
  );
  const baseNodeIds = new Set(base.nodes.map((node) => node.id));
  const connectedAnchors = anchors.filter(
    (anchor) =>
      connectedNodeIds.has(anchor.id) &&
      base.relationships.some(
        (relationship) =>
          (relationship.startId === anchor.id && baseNodeIds.has(relationship.endId)) ||
          (relationship.endId === anchor.id && baseNodeIds.has(relationship.startId)),
      ),
  );
  const nodes = uniqueNodes([...base.nodes, ...connectedAnchors])
    .sort((left, right) => compareEvidenceNodes(left, right, answerNodeIds))
    .slice(0, EVIDENCE_NODE_LIMIT);
  const selectedNodeIds = new Set(nodes.map((node) => node.id));
  const relationships = uniqueRelationships(base.relationships)
    .filter(
      (relationship) =>
        selectedNodeIds.has(relationship.startId) && selectedNodeIds.has(relationship.endId),
    )
    .sort((left, right) => compareEvidenceRelationships(left, right, answerNodeIds));
  return { nodes, relationships };
}

function compareEvidenceNodes(
  left: GraphNode,
  right: GraphNode,
  answerNodeIds: ReadonlySet<string>,
): number {
  const answerPriority = Number(!answerNodeIds.has(left.id)) - Number(!answerNodeIds.has(right.id));
  if (answerPriority !== 0) return answerPriority;

  const labelPriority = evidenceLabelPriority(left.label) - evidenceLabelPriority(right.label);
  if (labelPriority !== 0) return labelPriority;
  return left.display.localeCompare(right.display, 'ko') || left.id.localeCompare(right.id);
}

function compareEvidenceRelationships(
  left: GraphRel,
  right: GraphRel,
  answerNodeIds: ReadonlySet<string>,
): number {
  const leftAnswerEndpoints =
    Number(answerNodeIds.has(left.startId)) + Number(answerNodeIds.has(left.endId));
  const rightAnswerEndpoints =
    Number(answerNodeIds.has(right.startId)) + Number(answerNodeIds.has(right.endId));
  return rightAnswerEndpoints - leftAnswerEndpoints || left.id.localeCompare(right.id);
}

function evidenceLabelPriority(label: GraphNode['label']): number {
  if (label === 'Task') return 0;
  if (label === 'Decision') return 1;
  if (label === 'Wiki') return 2;
  if (label === 'Concept') return 3;
  return 4;
}

function uniqueRelationships(relationships: GraphRel[]): GraphRel[] {
  return [
    ...new Map(relationships.map((relationship) => [relationship.id, relationship])).values(),
  ];
}

function queryLlmModel(): string | undefined {
  return process.env.QUERY_LLM_MODEL || process.env.LLM_MODEL;
}

function failureAnswer(
  message: string,
  terms: string[],
  anchorCount: number,
  diagnostics: string[],
): string {
  const detail = diagnostics.length > 0 ? ` 세부 정보: ${diagnostics.join('; ')}` : '';
  return `${message} fulltext anchor 검색어 [${terms.join(', ')}]로 ${anchorCount}개 노드를 확인했습니다.${detail}`;
}

function synthesisFallbackAnswer(
  rows: Record<string, unknown>[],
  terms: string[],
  cypher: string,
  diagnostics: string[],
): string {
  const outcome = rows.length === 0
    ? '조회 결과를 찾지 못했습니다.'
    : `조회에서 ${rows.length}개 결과 행을 찾았지만 자연어 답변 합성에 실패했습니다.`;
  return `${outcome} fulltext anchor 검색어 [${terms.join(', ')}]와 다음 Cypher를 시도했습니다: ${cypher}. ${diagnostics.join('; ')}`.trim();
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? trimmed;
  return JSON.parse(candidate);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertReadOnlyCypher(cypher: string): void {
  const normalized = cypher.replace(/\/\/.*$/gm, ' ').replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  if (!/^(MATCH|OPTIONAL MATCH|WITH|CALL DB\.INDEX\.FULLTEXT\.QUERYNODES)\b/.test(upper)) {
    throw new BadRequestException('Cypher must start with MATCH, OPTIONAL MATCH, WITH, or fulltext query CALL.');
  }
  if (normalized.includes(';')) {
    throw new BadRequestException('Cypher must contain exactly one statement without semicolons.');
  }
  if (/\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|ALTER|LOAD\s+CSV|FOREACH)\b/i.test(normalized)) {
    throw new BadRequestException('Cypher contains a forbidden write/admin clause.');
  }
  if (/\bCALL\s+(?!DB\.INDEX\.FULLTEXT\.QUERYNODES\b)(DBMS|DB\.|APOC\.)/i.test(normalized)) {
    throw new BadRequestException('Cypher contains a forbidden write/admin clause.');
  }
}

function ontologySummary(): string {
  return [
    '허용 속성 카탈로그:',
    'Project: code, name',
    'Task: number(int), subject, workflowClass, createdAt',
    'Wiki: pageId, subject, parentId',
    'Person: memberId, name',
    'Concept: name, kind',
    'Comment: commentId, excerpt, createdAt',
    'Decision: id, summary',
    '관계와 방향:',
    'CONTAINS: Project -> Task|Wiki',
    'ASSIGNED_TO: Task -> Person',
    'AUTHORED: Person -> Task',
    'COMMENTED: Person -> Comment',
    'HAS_COMMENT: Task -> Comment',
    'TAGGED: Task -> Concept',
    'TAGGED.dimension은 문자열이며 "0"은 유형, "1"은 제품, "2"는 컴포넌트를 뜻한다.',
    '한 Task는 서로 다른 차원의 여러 Concept에 TAGGED될 수 있다.',
    'REFERENCES: Task -> Task',
    'CHILD_OF: Task -> Task; Wiki -> Wiki',
    'MENTIONS: Task|Wiki -> Concept',
    'DOCUMENTS: Wiki -> Concept',
    'DEPENDS_ON: Concept -> Concept',
    'DECIDED_IN: Decision -> Task',
    'EVIDENCED_BY: Decision -> Task|Comment',
    'AFFECTS: Decision -> Concept',
    'RELATES_TO: Task -> Task',
  ].join('\n');
}

function toSafeNumber(value: { toNumber?: () => number } | number): number {
  return typeof value === 'number' ? value : value.toNumber?.() ?? Number(value);
}

function jsonSafeReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return value;
}
