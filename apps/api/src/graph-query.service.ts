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
const ANCHOR_CANDIDATE_LIMIT = 8;
const ANCHOR_LABEL_QUOTAS: Partial<
  Record<GraphNode['label'], { min?: number; max?: number }>
> = {
  Task: { max: 5 },
  Wiki: { min: 2, max: 3 },
  Concept: { max: 2 },
};
const EVIDENCE_NODE_LIMIT = 30;

interface FulltextMatch {
  node: GraphNode;
  score: number;
}

interface AnchorCandidate {
  node: GraphNode;
  decisionCount?: number | null;
}

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
    return uniqueNodes(results.map(({ node }) => node)).slice(0, 25);
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
    terms = uniqueTerms([...terms, question]);

    const searchResults = await Promise.allSettled(
      terms.map((term) => this.fulltextSearch(term, ANCHOR_CANDIDATE_LIMIT)),
    );
    const fulfilledSearchResults = searchResults.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      diagnostics.push(`anchor 검색 실패(${terms[index]}): ${formatError(result.reason)}`);
      return [];
    });
    const anchors = rankAnchorCandidates(fulfilledSearchResults, ANCHOR_CANDIDATE_LIMIT);
    let decisionCounts: ReadonlyMap<string, number> | undefined;
    try {
      decisionCounts = await this.countTaskDecisions(anchors);
    } catch (error) {
      diagnostics.push(`anchor Decision 연결 수 조회 실패: ${formatError(error)}`);
    }
    const anchorCandidates = withDecisionCounts(anchors, decisionCounts);

    let cypher: string;
    try {
      cypher = await this.generateCypher(question, anchorCandidates);
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
        const retryCypher = await this.generateCypher(question, anchorCandidates, {
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
        const evidenceCypher = await this.generateEvidenceCypher(
          question,
          final.cypher,
          final.rows,
          anchorCandidates,
        );
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

  private async fulltextSearch(q: string, limit: number): Promise<FulltextMatch[]> {
    return this.neo4jService.executeRead(async (session) => {
      const result = await session.run(
        `
        UNWIND $indexes AS indexName
        CALL db.index.fulltext.queryNodes(indexName, $q, {limit: $perIndexLimit})
        YIELD node, score
        WITH node, max(score) AS score
        RETURN node, score
        ORDER BY score DESC
        `,
        {
          indexes: [...FULLTEXT_INDEXES],
          q,
          perIndexLimit: neo4j.int(limit),
        },
      );
      return result.records.map((record) => ({
        node: this.neo4jService.nodeToGraphNode(record.get('node')),
        score: toSafeNumber(record.get('score') as number),
      }));
    });
  }

  private async countTaskDecisions(anchors: GraphNode[]): Promise<Map<string, number>> {
    const taskIds = anchors
      .filter((anchor) => anchor.label === 'Task')
      .map((anchor) => anchor.id);
    if (taskIds.length === 0) return new Map();

    return this.neo4jService.executeRead(async (session) => {
      const result = await session.run(
        `
        MATCH (t:Task)
        WHERE elementId(t) IN $taskIds
        OPTIONAL MATCH (d:Decision)-[:DECIDED_IN]->(t)
        RETURN elementId(t) AS taskId, count(DISTINCT d) AS decisionCount
        `,
        { taskIds },
      );
      return new Map(
        result.records.map((record) => [
          String(record.get('taskId')),
          toSafeNumber(record.get('decisionCount')),
        ]),
      );
    });
  }

  private async extractAnchorTerms(question: string): Promise<string[]> {
    const prompt = [
      '질문에서 Neo4j fulltext 검색 anchor로 쓸 핵심 용어를 추출하라.',
      '각 핵심 용어가 기술 외래어 또는 제품명이면 같은 대상을 가리키는 한국어·영어 표기 변형을 양방향으로 생성하라.',
      '한국어로 적힌 기술 용어에는 원어 영어 표기와 널리 쓰이는 영어 제품명 표기를 포함하고, 영어 용어에는 통용되는 한국어 음역 표기를 포함하라.',
      '예: 게이트웨이 → gateway, API Gateway / 쿠버네티스 → kubernetes, Kubernetes / ingress → 잉그레스.',
      '원문 핵심 용어와 생성한 모든 표기 변형을 각각 독립된 검색어로 terms 배열에 넣고, 중복은 제거하라.',
      '일반적인 조사·서술어·의문 표현은 제외하라.',
      '응답은 반드시 JSON 하나만 출력한다.',
      '형식: {"terms":["원문 핵심 용어","영어 또는 한국어 표기 변형"]}',
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
    anchorCandidates: AnchorCandidate[],
    retry?: { previousCypher: string; error: string },
  ): Promise<string> {
    const prompt = [
      'Neo4j 지식그래프 질문을 읽기 전용 Cypher 하나로 변환하라.',
      '응답은 반드시 JSON 하나만 출력한다. 형식: {"cypher":"MATCH ... RETURN ... LIMIT 50"}',
      '쓰기 구문 CREATE, MERGE, SET, DELETE, REMOVE, DROP, LOAD CSV, CALL dbms/admin/apoc 는 금지한다.',
      '아래 허용 속성만 사용하고, 목록에 없는 속성(예: Wiki.title)은 절대 만들지 마라.',
      ontologySummary(),
      '질문이 이유·배경·결정 계열(왜, 이유, 사유, 배경, 어떻게 결정, why)이거나 모호한 지칭으로 변경·선택의 근거를 묻는다면, fulltext 1위 후보 하나만 정답으로 확정하지 마라.',
      '이유·배경·결정 질의에서는 후보 Task들의 실제 정수 key를 number 목록으로 만들고, MATCH (d:Decision)-[:DECIDED_IN]->(t:Task) WHERE t.number IN [...] 형태로 후보 전체의 Decision을 조회하라. 특정 Task 한 건의 {number: ...} 패턴으로 먼저 좁히지 마라.',
      '각 Task 후보의 decisionCount는 Decision이 있는 후보를 놓치지 않기 위한 탐색 신호다. 개수만으로 정답을 확정하지 말고, 조회한 d.summary와 EVIDENCED_BY Comment를 질문과 비교해 가장 관련성 높은 결정을 답하게 하라.',
      '이유·결정 질의 few-shot 질문: "그 구성 요소를 뺀 건 왜였지?"',
      'few-shot 후보: Task key 123 / decisionCount 0 / 장애 대응, Task key 117 / decisionCount 6 / 구성 요소 제거, Task key 109 / decisionCount 1 / 주변 정리.',
      'few-shot Cypher: MATCH (d:Decision)-[decided:DECIDED_IN]->(t:Task) WHERE t.number IN [123, 117, 109] OPTIONAL MATCH (d)-[evidenced:EVIDENCED_BY]->(comment:Comment) RETURN t, d, decided, evidenced, comment LIMIT 50',
      '태그 차원 조합 집계는 한 차원의 Concept로 Task를 필터링하고 같은 Task의 다른 TAGGED 관계를 별도로 MATCH해 다른 차원의 Concept별로 묶는 패턴이다.',
      '예시 질문: 유형 태그가 개선인 Task를 컴포넌트 Concept별로 집계해줘',
      '예시 Cypher: MATCH (t:Task)-[typeTag:TAGGED]->(:Concept {name:"개선"}) WHERE typeTag.dimension = "0" MATCH (t)-[groupTag:TAGGED]->(c:Concept) WHERE groupTag.dimension = "2" RETURN c.name, count(t)',
      '집계 질의의 Cypher는 집계 결과 행만 반환하라. 집계 뒤 근거 node/path를 재확장하거나 근거 수집용 LIMIT를 같은 쿼리에 넣지 마라. LIMIT는 집계 그룹에 적용한다.',
      '비집계 질의는 가능하면 node, relationship, path를 RETURN해서 근거 그래프를 포함하라.',
      'fulltext 검색으로 찾은 순위화된 anchor 후보를 우선 사용하라. 관련 anchor는 label과 key에 맞는 실제 노드로 제한하고, display를 질문 용어 해석에 활용하라.',
      `Anchor candidates (label/key/display; Task includes decisionCount): ${JSON.stringify(anchorSummaries(anchorCandidates))}`,
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
    anchorCandidates: AnchorCandidate[],
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
      `Anchor candidates (label/key/display; Task includes decisionCount): ${JSON.stringify(anchorSummaries(anchorCandidates))}`,
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
      '여러 Task 후보의 Decision이 함께 조회되었다면 행 순서나 fulltext 1위만으로 단정하지 말고, Task subject·Decision summary·Comment excerpt를 질문과 비교해 가장 관련성 높은 근거로 답하라.',
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

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

export function rankAnchorCandidates(
  resultSets: FulltextMatch[][],
  limit = ANCHOR_CANDIDATE_LIMIT,
): GraphNode[] {
  const ranked = new Map<
    string,
    { node: GraphNode; reciprocalRank: number; bestScore: number; firstSeen: number }
  >();
  let firstSeen = 0;
  for (const resultSet of resultSets) {
    resultSet.forEach(({ node, score }, rank) => {
      const existing = ranked.get(node.id);
      if (existing) {
        existing.reciprocalRank += 1 / (60 + rank + 1);
        existing.bestScore = Math.max(existing.bestScore, score);
        return;
      }
      ranked.set(node.id, {
        node,
        reciprocalRank: 1 / (60 + rank + 1),
        bestScore: score,
        firstSeen,
      });
      firstSeen += 1;
    });
  }
  const sorted = [...ranked.values()].sort(
    (left, right) =>
      right.reciprocalRank - left.reciprocalRank ||
      right.bestScore - left.bestScore ||
      left.firstSeen - right.firstSeen,
  );
  const selectedIds = new Set<string>();
  const labelCounts = new Map<GraphNode['label'], number>();
  const select = ({ node }: (typeof sorted)[number]): void => {
    if (selectedIds.has(node.id) || selectedIds.size >= limit) return;
    selectedIds.add(node.id);
    labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
  };

  for (const [label, { min = 0 }] of Object.entries(ANCHOR_LABEL_QUOTAS) as Array<
    [GraphNode['label'], { min?: number; max?: number }]
  >) {
    sorted
      .filter(({ node }) => node.label === label)
      .slice(0, Math.min(min, limit))
      .forEach(select);
  }
  for (const candidate of sorted) {
    const max = ANCHOR_LABEL_QUOTAS[candidate.node.label]?.max;
    if (max !== undefined && (labelCounts.get(candidate.node.label) ?? 0) >= max) continue;
    select(candidate);
  }
  return sorted.filter(({ node }) => selectedIds.has(node.id)).map(({ node }) => node);
}

function emptyEvidence(): NeighborsResponse {
  return { nodes: [], relationships: [] };
}

function withDecisionCounts(
  anchors: GraphNode[],
  decisionCounts?: ReadonlyMap<string, number>,
): AnchorCandidate[] {
  return anchors.map((node) =>
    node.label === 'Task'
      ? { node, decisionCount: decisionCounts ? decisionCounts.get(node.id) ?? 0 : null }
      : { node },
  );
}

function anchorSummaries(
  candidates: AnchorCandidate[],
): Array<Pick<GraphNode, 'label' | 'key' | 'display'> & { decisionCount?: number | null }> {
  return candidates.map(({ node: { label, key, display }, decisionCount }) =>
    label === 'Task'
      ? { label, key, display, decisionCount: decisionCount ?? null }
      : { label, key, display },
  );
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
    'Task: number(int), subject, workflowClass, createdAt, bodyExcerpt',
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
