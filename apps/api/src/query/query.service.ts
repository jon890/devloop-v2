import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { GraphNode, GraphRel, NeighborsResponse, QueryRequest, QueryResponse } from "@devloop/shared";
import { QueryRequestSchema } from "@devloop/shared";
import neo4j from "neo4j-driver";
import { API_CONFIG, type ApiConfig } from "../config";
import { LLM_CLI, LlmCli } from "../llm-cli";
import { Neo4jService } from "../neo4j.service";
import {
  ANCHOR_CANDIDATE_LIMIT,
  ANCHOR_LABEL_QUOTAS,
  ANSWER_EVIDENCE_PROMPT_BUDGET,
  ANSWER_EVIDENCE_RELATIONSHIP_RESERVE,
  EVIDENCE_NODE_CEILING,
  EVIDENCE_SERIALIZED_BUDGET,
  FULLTEXT_INDEXES,
  TASK_COMMENT_FETCH_LIMIT,
} from "./query.const";
import { AnchorResponseContract, AnswerResponseContract, CypherResponseContract, type StructuredResponseContract } from "./query.schema";

export interface FulltextMatch {
  node: GraphNode;
  score: number;
}

interface AnchorCandidate {
  node: GraphNode;
  decisionCount?: number | null;
}

@Injectable()
export class QueryService {
  constructor(
    private readonly neo4jService: Neo4jService,
    @Inject(LLM_CLI) private readonly llmCli: LlmCli,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

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

    const searchResults = await Promise.allSettled(terms.map((term) => this.fulltextSearch(term, ANCHOR_CANDIDATE_LIMIT)));
    const fulfilledSearchResults = searchResults.flatMap((result, index) => {
      if (result.status === "fulfilled") return [result.value];
      diagnostics.push(`anchor 검색 실패(${terms[index]}): ${formatError(result.reason)}`);
      return [];
    });
    let promotedSearchResults: FulltextMatch[][];
    try {
      promotedSearchResults = await this.promoteCommentHits(fulfilledSearchResults);
    } catch (error) {
      diagnostics.push(`댓글 히트 승격 실패: ${formatError(error)}`);
      // 원본으로 되돌리지 않는다. 되돌리면 Comment 가 앵커 목록에 남아 라벨 정원이 없는 채로
      // 슬롯을 잠식한다. 승격하지 못한 댓글 히트는 버리는 것이 이 단계의 규칙이다.
      promotedSearchResults = dropCommentHits(fulfilledSearchResults);
    }
    const anchors = rankAnchorCandidates(promotedSearchResults, ANCHOR_CANDIDATE_LIMIT);
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
        answer: failureAnswer("Cypher 생성에 실패했습니다.", terms, anchors.length, [`생성 오류: ${formatError(error)}`, ...diagnostics]),
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
          answer: failureAnswer(`Cypher 실행에 실패했고 재생성도 완료하지 못했습니다: ${execution.error}`, terms, anchors.length, [
            `재생성 오류: ${formatError(error)}`,
            ...diagnostics,
          ]),
          evidence: refineQueryEvidence(emptyEvidence(), emptyEvidence(), anchors),
          cypher: execution.cypher,
        };
      }
    }
    if (final.ok !== true) {
      return {
        answer: failureAnswer(`Cypher 실행에 실패했습니다: ${final.error}`, terms, anchors.length, diagnostics),
        evidence: refineQueryEvidence(emptyEvidence(), emptyEvidence(), anchors),
        cypher: final.cypher,
      };
    }

    let supportingEvidence = emptyEvidence();
    if (isAggregationCypher(final.cypher)) {
      try {
        const evidenceCypher = await this.generateEvidenceCypher(question, final.cypher, final.rows, anchorCandidates);
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
      return {
        answer: normalizeTaskCitations(answer, final.evidence.nodes),
        evidence,
        cypher: final.cypher,
      };
    } catch (error) {
      return {
        answer: synthesisFallbackAnswer(final.rows, terms, final.cypher, [`답변 합성 실패: ${formatError(error)}`, ...diagnostics]),
        evidence,
        cypher: final.cypher,
      };
    }
  }

  async fulltextSearch(q: string, limit: number): Promise<FulltextMatch[]> {
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
          q: escapeLuceneQuery(q),
          perIndexLimit: neo4j.int(limit),
        },
      );
      return result.records.map((record) => ({
        node: this.neo4jService.nodeToGraphNode(record.get("node")),
        score: toSafeNumber(record.get("score") as number),
      }));
    });
  }

  /**
   * 검색 결과의 `Comment` 히트를 부모 업무로 바꿔 넣는다.
   *
   * 댓글을 앵커 목록에 그대로 두면 Cypher 생성 프롬프트가 새 라벨을 다루는 법을 알아야 하고
   * 앵커 슬롯 8개를 댓글이 잠식한다. 프롬프트까지 함께 바뀌면 회수 실패가 줄었을 때 텍스트 확보
   * 덕인지 프롬프트 덕인지 가를 수 없다.
   *
   * 부모 조회는 검색어 개수만큼 반복하지 않고 전체 결과에서 한 번에 모아 한 질의로 처리한다.
   */
  private async promoteCommentHits(resultSets: FulltextMatch[][]): Promise<FulltextMatch[][]> {
    const commentIds = [
      ...new Set(resultSets.flatMap((matches) => matches.filter((match) => match.node.label === "Comment").map((match) => match.node.id))),
    ];
    if (commentIds.length === 0) return resultSets;
    const parents = await this.commentParentTasks(commentIds);
    return resultSets.map((matches) => promoteCommentAnchors(matches, parents));
  }

  private async commentParentTasks(commentIds: string[]): Promise<Map<string, GraphNode>> {
    return this.neo4jService.executeRead(async (session) => {
      const result = await session.run(
        `
        MATCH (c:Comment)<-[:HAS_COMMENT]-(t:Task)
        WHERE elementId(c) IN $commentIds
        RETURN elementId(c) AS commentId, t AS task
        `,
        { commentIds },
      );
      const parents = new Map<string, GraphNode>();
      for (const record of result.records) {
        const commentId = String(record.get("commentId"));
        if (!parents.has(commentId)) parents.set(commentId, this.neo4jService.nodeToGraphNode(record.get("task")));
      }
      return parents;
    });
  }

  private async countTaskDecisions(anchors: GraphNode[]): Promise<Map<string, number>> {
    const taskIds = anchors.filter((anchor) => anchor.label === "Task").map((anchor) => anchor.id);
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
      return new Map(result.records.map((record) => [String(record.get("taskId")), toSafeNumber(record.get("decisionCount"))]));
    });
  }

  private async extractAnchorTerms(question: string): Promise<string[]> {
    const prompt = [
      "질문에서 Neo4j fulltext 검색 anchor로 쓸 핵심 용어를 추출하라.",
      "각 핵심 용어가 기술 외래어 또는 제품명이면 같은 대상을 가리키는 한국어·영어 표기 변형을 양방향으로 생성하라.",
      "한국어로 적힌 기술 용어에는 원어 영어 표기와 널리 쓰이는 영어 제품명 표기를 포함하고, 영어 용어에는 통용되는 한국어 음역 표기를 포함하라.",
      "예: 게이트웨이 → gateway, API Gateway / 쿠버네티스 → kubernetes, Kubernetes / ingress → 잉그레스.",
      "원문 핵심 용어와 생성한 모든 표기 변형을 각각 독립된 검색어로 terms 배열에 넣고, 중복은 제거하라.",
      "일반적인 조사·서술어·의문 표현은 제외하라.",
      `질문: ${question}`,
    ].join("\n");
    return (
      await this.completeStructured(prompt, AnchorResponseContract, {
        timeoutMs: 60_000,
        model: this.config.llm.queryModel,
      })
    ).terms;
  }

  private async generateCypher(
    question: string,
    anchorCandidates: AnchorCandidate[],
    retry?: { previousCypher: string; error: string },
  ): Promise<string> {
    const prompt = [
      "Neo4j 지식그래프 질문을 읽기 전용 Cypher 하나로 변환하라.",
      "반환 행은 50개를 넘기지 마라.",
      "쓰기 구문 CREATE, MERGE, SET, DELETE, REMOVE, DROP, LOAD CSV, CALL dbms/admin/apoc 는 금지한다.",
      "아래 허용 속성만 사용하고, 목록에 없는 속성(예: Wiki.title)은 절대 만들지 마라.",
      ontologySummary(),
      "질문이 이유·배경·결정 계열(왜, 이유, 사유, 배경, 어떻게 결정, why)이거나 모호한 지칭으로 변경·선택의 근거를 묻는다면, fulltext 1위 후보 하나만 정답으로 확정하지 마라.",
      "이유·배경·결정 질의에서는 후보 Task들의 실제 정수 key를 number 목록으로 만들고, MATCH (d:Decision)-[:DECIDED_IN]->(t:Task) WHERE t.number IN [...] 형태로 후보 전체의 Decision을 조회하라. 특정 Task 한 건의 {number: ...} 패턴으로 먼저 좁히지 마라.",
      "각 Task 후보의 decisionCount는 Decision이 있는 후보를 놓치지 않기 위한 탐색 신호다. 개수만으로 정답을 확정하지 말고, 조회한 d.summary와 EVIDENCED_BY Comment를 질문과 비교해 가장 관련성 높은 결정을 답하게 하라.",
      '이유·결정 질의 few-shot 질문: "그 구성 요소를 뺀 건 왜였지?"',
      "few-shot 후보: Task key 123 / decisionCount 0 / 장애 대응, Task key 117 / decisionCount 6 / 구성 요소 제거, Task key 109 / decisionCount 1 / 주변 정리.",
      "few-shot Cypher: MATCH (d:Decision)-[decided:DECIDED_IN]->(t:Task) WHERE t.number IN [123, 117, 109] OPTIONAL MATCH (d)-[evidenced:EVIDENCED_BY]->(comment:Comment) RETURN t, d, decided, evidenced, comment LIMIT 50",
      "태그 차원 조합 집계는 한 차원의 Concept로 Task를 필터링하고 같은 Task의 다른 TAGGED 관계를 별도로 MATCH해 다른 차원의 Concept별로 묶는 패턴이다.",
      "예시 질문: 유형 태그가 개선인 Task를 컴포넌트 Concept별로 집계해줘",
      '예시 Cypher: MATCH (t:Task)-[typeTag:TAGGED]->(:Concept {name:"개선"}) WHERE typeTag.dimension = "0" MATCH (t)-[groupTag:TAGGED]->(c:Concept) WHERE groupTag.dimension = "2" RETURN c.name, count(t)',
      "집계 질의의 Cypher는 집계 결과 행만 반환하라. 집계 뒤 근거 node/path를 재확장하거나 근거 수집용 LIMIT를 같은 쿼리에 넣지 마라. LIMIT는 집계 그룹에 적용한다.",
      "비집계 질의는 가능하면 node, relationship, path를 RETURN해서 근거 그래프를 포함하라.",
      "질문이 검증·조치·경과·근거를 묻거나 특정 Task 번호를 지목하면, **지목된 모든 Task 의 댓글을 함께** 확장하라. 한 Task 의 number 목록을 만들어 MATCH (t:Task) WHERE t.number IN [...] OPTIONAL MATCH (t)-[hasComment:HAS_COMMENT]->(comment:Comment) 형태로 쓴다. 업무 하나만 댓글 확장하면 다른 업무의 근거 댓글이 아예 조회되지 않는다.",
      "실측 사례 — 497의 변경이 499에서 어떻게 검증됐는지 묻는 질문에 499의 댓글만 확장해 497의 근거 댓글 2건을 놓쳤다. 두 업무를 number 목록에 함께 넣어야 한다.",
      "**Task 를 셋 이상 지목하면 OPTIONAL MATCH 를 여러 개 이어 붙이지 마라.** 그러면 한 Task 의 조합이 행을 독점해 다른 Task 노드가 LIMIT 밖으로 밀려 아예 반환되지 않는다. 확장마다 WITH ... collect(DISTINCT ...)[..N] 으로 접어 **Task 하나당 한 행**을 만들어라. 그러면 LIMIT 이 Task 수만 제한한다.",
      "다수 Task few-shot Cypher: MATCH (t:Task) WHERE t.number IN [483, 494, 496] OPTIONAL MATCH (t)-[:HAS_COMMENT]->(comment:Comment) WITH t, collect(DISTINCT comment)[..4] AS comments OPTIONAL MATCH (d:Decision)-[:DECIDED_IN]->(t) WITH t, comments, collect(DISTINCT d)[..3] AS decisions RETURN t, comments, decisions ORDER BY t.number LIMIT 50",
      "collect 로 접은 배열도 근거로 인정된다. 배열 안의 node 를 근거 그래프가 그대로 읽는다.",
      "fulltext 검색으로 찾은 순위화된 anchor 후보를 우선 사용하라. 관련 anchor는 label과 key에 맞는 실제 노드로 제한하고, display를 질문 용어 해석에 활용하라.",
      `Anchor candidates (label/key/display; Task includes decisionCount): ${JSON.stringify(anchorSummaries(anchorCandidates))}`,
      retry ? `이전 Cypher는 오류가 났다. 오류를 반영해 한 번만 고쳐라.\nPrevious: ${retry.previousCypher}\nError: ${retry.error}` : "",
      `Question: ${question}`,
    ].join("\n\n");
    return (
      await this.completeStructured(prompt, CypherResponseContract, {
        timeoutMs: 90_000,
        model: this.config.llm.queryModel,
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
      "집계 답변의 결과 행을 바꾸지 않는 읽기 전용 근거 수집 전용 Cypher 하나를 작성하라.",
      "반환 행은 50개를 넘기지 마라.",
      "답변용 집계 Cypher를 다시 집계하거나 그 결과 행을 대체하지 마라. 관련 node, relationship, path만 별도로 반환하라.",
      "쓰기 구문 CREATE, MERGE, SET, DELETE, REMOVE, DROP, LOAD CSV, CALL dbms/admin/apoc 는 금지한다.",
      "아래 허용 속성과 관계 방향만 사용하라.",
      ontologySummary(),
      `Question: ${question}`,
      `Answer Cypher: ${answerCypher}`,
      `Complete aggregate rows: ${JSON.stringify(rows, jsonSafeReplacer)}`,
      `Anchor candidates (label/key/display; Task includes decisionCount): ${JSON.stringify(anchorSummaries(anchorCandidates))}`,
    ].join("\n\n");
    return (
      await this.completeStructured(prompt, CypherResponseContract, {
        timeoutMs: 90_000,
        model: this.config.llm.queryModel,
      })
    ).cypher.trim();
  }

  private async executeGeneratedCypher(
    cypher: string,
  ): Promise<
    { ok: true; cypher: string; rows: Record<string, unknown>[]; evidence: NeighborsResponse } | { ok: false; cypher: string; error: string }
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

    // 근거에 온 업무의 댓글을 결정적으로 끌어온다. 남은 회수 실패가 전부 "업무는 왔는데 그 댓글만
    // 빠졌다" 였고, 필수 근거 29건 중 14건이 댓글이다. LLM 을 한 번 더 부르지 않고 그래프 조회로 채운다.
    const taskComments = await this.fetchTaskComments(refined.nodes);
    const enriched = mergeEvidence(supportingEvidence, taskComments);

    const withComments = refineQueryEvidence(answerEvidence, enriched, anchors);
    const nodeIds = withComments.nodes.map((node) => node.id);
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
    return refineQueryEvidence(answerEvidence, mergeEvidence(enriched, relationshipsBetweenNodes), anchors);
  }

  /**
   * 주어진 근거 노드 중 Task 의 댓글을 가져온다. 한 업무가 댓글로 예산을 독식하지 않게
   * 업무당 상한을 둔다 (Task 127 은 댓글이 20건이다).
   */
  private async fetchTaskComments(nodes: GraphNode[]): Promise<NeighborsResponse> {
    const taskIds = nodes.filter((node) => node.label === "Task").map((node) => node.id);
    if (taskIds.length === 0) return emptyEvidence();

    return this.neo4jService.executeRead(async (session) => {
      const result = await session.run(
        `
        MATCH (task:Task)
        WHERE elementId(task) IN $taskIds
        CALL (task) {
          MATCH (task)-[hasComment:HAS_COMMENT]->(comment:Comment)
          RETURN hasComment, comment
          ORDER BY comment.createdAt
          LIMIT $perTask
        }
        RETURN task, hasComment, comment
        `,
        { taskIds, perTask: neo4j.int(TASK_COMMENT_FETCH_LIMIT) },
      );
      return this.neo4jService.evidenceFromResult(result);
    });
  }

  private async synthesizeAnswer(question: string, rows: Record<string, unknown>[], evidence: NeighborsResponse): Promise<string> {
    const prompt = [
      "질문과 Cypher 결과, 근거 그래프를 바탕으로 한국어 답변을 작성하라.",
      "Task를 인용할 때는 번호만 #123처럼 쓰지 말고 반드시 Task #123 형식으로 써라.",
      "여러 Task 후보의 Decision이 함께 조회되었다면 행 순서나 fulltext 1위만으로 단정하지 말고, Task subject·Decision summary·Comment excerpt를 질문과 비교해 가장 관련성 높은 근거로 답하라.",
      `Question: ${question}`,
      `Rows: ${JSON.stringify(rows, jsonSafeReplacer)}`,
      "Evidence 의 omittedNodes·omittedRelationships 는 분량 때문에 프롬프트에서 빠진 근거 수다. 0이 아니면 근거가 더 있다는 뜻이므로, 관계가 비어 있다고 관계가 없다고 단정하지 마라.",
      `Evidence: ${buildAnswerEvidencePayload(evidence)}`,
    ].join("\n\n");
    return (
      await this.completeStructured(prompt, AnswerResponseContract, {
        timeoutMs: 90_000,
        model: this.config.llm.queryModel,
      })
    ).answer;
  }

  /**
   * 응답 형식은 프롬프트로 부탁하지 않고 `outputSchema` 로 서버에 넘긴다.
   *
   * **형식 위반 재시도는 두지 않는다.** 서버가 형식을 보장하므로 검증 실패는 계약이 깨진 것이고,
   * 재시도로 덮으면 그 결함이 드러나지 않은 채 호출만 두 배가 된다. 검증은 그대로 남긴다 —
   * 지우면 계약이 깨진 날 조용히 넘어간다.
   */
  private async completeStructured<T>(
    prompt: string,
    contract: StructuredResponseContract<T>,
    options: { timeoutMs: number; model?: string },
  ): Promise<T> {
    const result = await this.llmCli.complete(prompt, { ...options, outputSchema: contract.outputSchema });
    return contract.schema.parse(parseJson(result.text));
  }
}

export function uniqueNodes(nodes: GraphNode[]): GraphNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

function normalizeTaskCitations(answer: string, answerNodes: GraphNode[]): string {
  const taskNumbers = new Set(answerNodes.filter((node) => node.label === "Task").map((node) => String(node.key)));
  return answer.replace(
    /(?:(?:Task|업무)[ \t]+)?(?<![\w/])(?<!Task\n)(?<!Task\r\n)(?<!업무\n)(?<!업무\r\n)#(\d+)(?![\w.]|번)/gi,
    (reference, taskNumber: string) => (taskNumbers.has(taskNumber) ? `Task #${taskNumber}` : reference),
  );
}

/**
 * 부모 조회가 실패했을 때 쓰는 안전 기본값이다. `Comment` 히트만 버리고 나머지는 그대로 둔다.
 *
 * `ANCHOR_LABEL_QUOTAS` 에 `Comment` 항목이 없어 `max` 가 없으므로, 앵커 목록에 `Comment` 가
 * 남으면 backfill 이 제한 없이 채워 슬롯을 잠식한다.
 */
export function dropCommentHits(resultSets: FulltextMatch[][]): FulltextMatch[][] {
  return resultSets.map((matches) => matches.filter((match) => match.node.label !== "Comment"));
}

/**
 * 한 검색 결과에서 `Comment` 히트를 부모 업무로 치환한다.
 *
 * `rankAnchorCandidates` 가 배열 위치를 순위로 써서 역수로 융합하므로(`1 / (60 + rank + 1)`),
 * 승격한 업무는 **댓글이 있던 자리에 그대로 들어가야** 융합에서 제 무게를 갖는다.
 *
 * - 같은 업무의 댓글이 여러 건 걸리면 가장 높은 순위 한 자리로 합치고 점수는 큰 값을 남긴다
 * - 승격한 업무가 이미 결과에 있으면 더 높은 순위 자리를 남긴다
 * - 부모를 못 찾은 댓글 히트는 버린다. 앵커 목록에 `Comment` 를 남기지 않는다
 */
export function promoteCommentAnchors(matches: FulltextMatch[], parents: ReadonlyMap<string, GraphNode>): FulltextMatch[] {
  const promoted: FulltextMatch[] = [];
  const positionById = new Map<string, number>();
  for (const match of matches) {
    let effective = match;
    if (match.node.label === "Comment") {
      const parent = parents.get(match.node.id);
      if (!parent) continue;
      effective = { node: parent, score: match.score };
    }
    const position = positionById.get(effective.node.id);
    if (position !== undefined) {
      promoted[position] = { node: promoted[position].node, score: Math.max(promoted[position].score, effective.score) };
      continue;
    }
    positionById.set(effective.node.id, promoted.length);
    promoted.push(effective);
  }
  return promoted;
}

/**
 * 우선순위로 정렬된 항목을 직렬화 길이 예산과 개수 상한 안에서 **앞에서부터** 담는다.
 *
 * 예산에 안 맞는 항목을 만나면 멈춘다 (건너뛰지 않는다). 건너뛰면 버린 항목보다 우선순위가
 * 낮은 짧은 항목이 그 자리를 채워 정렬이 뒤집힌다 — 본문 있는 Comment 를 버리고 본문 없는
 * Concept 태그를 담는 일이 생긴다. 그건 이 예산 방식이 없애려던 실패 유형이다.
 *
 * 첫 항목은 예산을 넘어도 담는다. 근거가 0건이 되는 것보다 낫다.
 */
export function takeWithinBudget<T>(items: readonly T[], budget: number, ceiling: number): T[] {
  const taken: T[] = [];
  let used = 0;
  for (const item of items) {
    if (taken.length >= ceiling) break;
    const cost = JSON.stringify(item).length;
    if (taken.length > 0 && used + cost > budget) break;
    taken.push(item);
    used += cost;
  }
  return taken;
}

/**
 * 답변 프롬프트에 담을 근거를 만든다. 직렬화 결과를 문자 단위로 자르면 JSON 구조가 깨지므로
 * **항목을 하나씩 담아** 예산에 맞춘다.
 *
 * **노드에 예산을 먼저 준다.** 관계 비용을 전부 먼저 빼면 관계가 예산을 넘는 회차에서 노드
 * 예산이 0이 되어 첫 노드만 담기고, 그 뒤 관계도 끝점이 없어 전부 걸러진다. 예산을 관계에
 * 예약해 놓고 관계까지 버리는 이중 낭비다 — 실측으로 9회 중 3회가 그 경로였다.
 *
 * 그래서 관계에는 예산의 일부만 예약하고, 노드를 담은 뒤 남은 여유로 관계를 채운다.
 */
export function buildAnswerEvidencePayload(evidence: NeighborsResponse, budget = ANSWER_EVIDENCE_PROMPT_BUDGET): string {
  const reserve = Math.min(JSON.stringify(evidence.relationships).length, Math.floor(budget * ANSWER_EVIDENCE_RELATIONSHIP_RESERVE));
  const nodes = takeWithinBudget(evidence.nodes, budget - reserve, evidence.nodes.length);
  const selected = new Set(nodes.map((node) => node.id));
  const reachable = evidence.relationships.filter((relationship) => selected.has(relationship.startId) && selected.has(relationship.endId));
  const relationships = takeWithinBudget(reachable, Math.max(0, budget - JSON.stringify(nodes).length), reachable.length);
  return JSON.stringify({
    nodes,
    relationships,
    omittedNodes: evidence.nodes.length - nodes.length,
    omittedRelationships: evidence.relationships.length - relationships.length,
  });
}

export function rankAnchorCandidates(resultSets: FulltextMatch[][], limit = ANCHOR_CANDIDATE_LIMIT): GraphNode[] {
  const ranked = new Map<string, { node: GraphNode; reciprocalRank: number; bestScore: number; firstSeen: number }>();
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
    (left, right) => right.reciprocalRank - left.reciprocalRank || right.bestScore - left.bestScore || left.firstSeen - right.firstSeen,
  );
  const selectedIds = new Set<string>();
  const labelCounts = new Map<GraphNode["label"], number>();
  const select = ({ node }: (typeof sorted)[number]): void => {
    if (selectedIds.has(node.id) || selectedIds.size >= limit) return;
    selectedIds.add(node.id);
    labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
  };

  for (const [label, { min = 0 }] of Object.entries(ANCHOR_LABEL_QUOTAS) as Array<[GraphNode["label"], { min?: number; max?: number }]>) {
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
  for (const candidate of sorted) {
    select(candidate);
  }
  return sorted.filter(({ node }) => selectedIds.has(node.id)).map(({ node }) => node);
}

function escapeLuceneQuery(query: string): string {
  return query.replace(/([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
}

function emptyEvidence(): NeighborsResponse {
  return { nodes: [], relationships: [] };
}

function withDecisionCounts(anchors: GraphNode[], decisionCounts?: ReadonlyMap<string, number>): AnchorCandidate[] {
  return anchors.map((node) =>
    node.label === "Task" ? { node, decisionCount: decisionCounts ? (decisionCounts.get(node.id) ?? 0) : null } : { node },
  );
}

function anchorSummaries(candidates: AnchorCandidate[]): Array<Pick<GraphNode, "label" | "key" | "display"> & { decisionCount?: number | null }> {
  return candidates.map(({ node: { label, key, display }, decisionCount }) =>
    label === "Task" ? { label, key, display, decisionCount: decisionCount ?? null } : { label, key, display },
  );
}

function anchorFallbackCypher(anchors: GraphNode[]): string {
  if (anchors.length === 0) return "MATCH (n) WHERE false RETURN n LIMIT 0";
  return `MATCH (n) WHERE elementId(n) IN ${JSON.stringify(anchors.map((anchor) => anchor.id))} RETURN n LIMIT 50`;
}

/**
 * "집계 결과 행만 반환하고 노드를 안 주는 질의" 인지 본다. 그런 질의는 근거를 별도 Cypher 로 다시 모은다.
 *
 * **`collect` 는 여기에 넣지 않는다.** 다수 업무 조회에서 확장을 접으라고 프롬프트가 지시하므로
 * `collect` 는 이제 일반 질의에도 쓰인다. 넣어 두면 그런 질의가 집계로 오판정돼 LLM 호출이 한 번 더 늘고
 * 근거를 다시 모으는 우회로를 탄다 — 실측으로 36회 중 32회가 `collect` 만으로 오판정됐고 진짜 집계는 0건이었다.
 */
export function isAggregationCypher(cypher: string): boolean {
  return /\b(?:count|sum|avg|min|max|percentileCont|percentileDisc|stDev|stDevP)\s*\(/i.test(cypher);
}

function mergeEvidence(left: NeighborsResponse, right: NeighborsResponse): NeighborsResponse {
  return {
    nodes: uniqueNodes([...left.nodes, ...right.nodes]),
    relationships: [...new Map([...left.relationships, ...right.relationships].map((relationship) => [relationship.id, relationship])).values()],
  };
}

export function refineQueryEvidence(
  answerEvidence: NeighborsResponse,
  supportingEvidence: NeighborsResponse,
  anchors: GraphNode[],
): NeighborsResponse {
  const answerNodeIds = new Set(answerEvidence.nodes.map((node) => node.id));
  const base = mergeEvidence(answerEvidence, supportingEvidence);
  const connectedNodeIds = new Set(base.relationships.flatMap((relationship) => [relationship.startId, relationship.endId]));
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
  const nodes = takeWithinBudget(
    uniqueNodes([...base.nodes, ...connectedAnchors]).sort((left, right) => compareEvidenceNodes(left, right, answerNodeIds)),
    EVIDENCE_SERIALIZED_BUDGET,
    EVIDENCE_NODE_CEILING,
  );
  const selectedNodeIds = new Set(nodes.map((node) => node.id));
  const relationships = uniqueRelationships(base.relationships)
    .filter((relationship) => selectedNodeIds.has(relationship.startId) && selectedNodeIds.has(relationship.endId))
    .sort((left, right) => compareEvidenceRelationships(left, right, answerNodeIds));
  return { nodes, relationships };
}

function compareEvidenceNodes(left: GraphNode, right: GraphNode, answerNodeIds: ReadonlySet<string>): number {
  const answerPriority = Number(!answerNodeIds.has(left.id)) - Number(!answerNodeIds.has(right.id));
  if (answerPriority !== 0) return answerPriority;

  const labelPriority = evidenceLabelPriority(left.label) - evidenceLabelPriority(right.label);
  if (labelPriority !== 0) return labelPriority;
  return left.display.localeCompare(right.display, "ko") || left.id.localeCompare(right.id);
}

function compareEvidenceRelationships(left: GraphRel, right: GraphRel, answerNodeIds: ReadonlySet<string>): number {
  const leftAnswerEndpoints = Number(answerNodeIds.has(left.startId)) + Number(answerNodeIds.has(left.endId));
  const rightAnswerEndpoints = Number(answerNodeIds.has(right.startId)) + Number(answerNodeIds.has(right.endId));
  return rightAnswerEndpoints - leftAnswerEndpoints || left.id.localeCompare(right.id);
}

// Comment 는 결정의 근거와 조치 내용을 담는 노드다. 평가 세트의 필수 근거 29건 중 14건이 댓글인데
// 예전에는 Concept 뒤 최하위여서 예산이 찰 때 가장 먼저 버려졌다. Concept 은 태그성 노드라 본문이 없다.
function evidenceLabelPriority(label: GraphNode["label"]): number {
  if (label === "Task") return 0;
  if (label === "Decision") return 1;
  if (label === "Comment") return 2;
  if (label === "Wiki") return 3;
  if (label === "Concept") return 4;
  return 5;
}

function uniqueRelationships(relationships: GraphRel[]): GraphRel[] {
  return [...new Map(relationships.map((relationship) => [relationship.id, relationship])).values()];
}

function failureAnswer(message: string, terms: string[], anchorCount: number, diagnostics: string[]): string {
  const detail = diagnostics.length > 0 ? ` 세부 정보: ${diagnostics.join("; ")}` : "";
  return `${message} fulltext anchor 검색어 [${terms.join(", ")}]로 ${anchorCount}개 노드를 확인했습니다.${detail}`;
}

function synthesisFallbackAnswer(rows: Record<string, unknown>[], terms: string[], cypher: string, diagnostics: string[]): string {
  const outcome =
    rows.length === 0 ? "조회 결과를 찾지 못했습니다." : `조회에서 ${rows.length}개 결과 행을 찾았지만 자연어 답변 합성에 실패했습니다.`;
  return `${outcome} fulltext anchor 검색어 [${terms.join(", ")}]와 다음 Cypher를 시도했습니다: ${cypher}. ${diagnostics.join("; ")}`.trim();
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
  const normalized = cypher
    .replace(/\/\/.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  const upper = normalized.toUpperCase();
  if (!/^(MATCH|OPTIONAL MATCH|WITH|CALL DB\.INDEX\.FULLTEXT\.QUERYNODES)\b/.test(upper)) {
    throw new BadRequestException("Cypher must start with MATCH, OPTIONAL MATCH, WITH, or fulltext query CALL.");
  }
  if (normalized.includes(";")) {
    throw new BadRequestException("Cypher must contain exactly one statement without semicolons.");
  }
  if (/\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|ALTER|LOAD\s+CSV|FOREACH)\b/i.test(normalized)) {
    throw new BadRequestException("Cypher contains a forbidden write/admin clause.");
  }
  if (/\bCALL\s+(?!DB\.INDEX\.FULLTEXT\.QUERYNODES\b)(DBMS|DB\.|APOC\.)/i.test(normalized)) {
    throw new BadRequestException("Cypher contains a forbidden write/admin clause.");
  }
}

function ontologySummary(): string {
  return [
    "허용 속성 카탈로그:",
    "Project: code, name",
    "Task: number(int), subject, workflowClass, createdAt, bodyExcerpt",
    "Wiki: pageId, subject, parentId",
    "Person: memberId, name",
    "Concept: name, kind",
    "Comment: commentId, excerpt, createdAt",
    "Decision: id, summary",
    "관계와 방향:",
    "CONTAINS: Project -> Task|Wiki",
    "ASSIGNED_TO: Task -> Person",
    "AUTHORED: Person -> Task",
    "COMMENTED: Person -> Comment",
    "HAS_COMMENT: Task -> Comment",
    "TAGGED: Task -> Concept",
    'TAGGED.dimension은 문자열이며 "0"은 유형, "1"은 제품, "2"는 컴포넌트를 뜻한다.',
    "한 Task는 서로 다른 차원의 여러 Concept에 TAGGED될 수 있다.",
    "REFERENCES: Task -> Task",
    "CHILD_OF: Task -> Task; Wiki -> Wiki",
    "MENTIONS: Task|Wiki -> Concept",
    "DOCUMENTS: Wiki -> Concept",
    "DOCUMENTS는 MENTIONS의 강한 형태이며, 개념을 다루는 문서를 찾을 때는 [:MENTIONS|DOCUMENTS]로 두 관계를 함께 MATCH하라.",
    "DEPENDS_ON: Concept -> Concept",
    "DECIDED_IN: Decision -> Task",
    "EVIDENCED_BY: Decision -> Task|Comment",
    "AFFECTS: Decision -> Concept",
    "RELATES_TO: Task -> Task",
  ].join("\n");
}

function toSafeNumber(value: { toNumber?: () => number } | number): number {
  return typeof value === "number" ? value : (value.toNumber?.() ?? Number(value));
}

function jsonSafeReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return value;
}
