import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  GraphNode,
  GraphSearchResponse,
  GraphStatsResponse,
  NeighborsResponse,
  QueryRequest,
  QueryResponse,
} from '@devloop/shared';
import {
  NODE_KEY_PROPERTIES,
  NODE_LABELS,
  RELATIONSHIP_TYPES,
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
const CypherResponseSchema = z.object({ cypher: z.string().min(1) });
const AnswerResponseSchema = z.object({ answer: z.string().min(1) });

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
    const terms = await this.extractAnchorTerms(question);
    const anchors = uniqueNodes((await Promise.all(terms.map((term) => this.fulltextSearch(term, 5)))).flat());
    const cypher = await this.generateCypher(question, anchors);
    const execution = await this.executeGeneratedCypher(cypher);
    const final =
      execution.ok === true
        ? execution
        : await this.executeGeneratedCypher(
            await this.generateCypher(question, anchors, { previousCypher: cypher, error: execution.error }),
          );
    if (final.ok !== true) {
      return {
        answer: `Cypher 실행에 실패했습니다: ${final.error}`,
        evidence: { nodes: anchors, relationships: [] },
        cypher: final.cypher,
      };
    }

    const answer = await this.synthesizeAnswer(question, final.rows, final.evidence);
    return { answer, evidence: final.evidence, cypher: final.cypher };
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
        model: process.env.LLM_MODEL,
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
      '가능하면 node, relationship, path 를 RETURN 해서 근거 그래프를 포함하라.',
      ontologySummary(),
      `Anchor nodes: ${JSON.stringify(anchors)}`,
      retry
        ? `이전 Cypher는 오류가 났다. 오류를 반영해 한 번만 고쳐라.\nPrevious: ${retry.previousCypher}\nError: ${retry.error}`
        : '',
      `Question: ${question}`,
    ].join('\n\n');
    return (
      await this.completeStructured(prompt, CypherResponseSchema, {
        timeoutMs: 90_000,
        model: process.env.LLM_MODEL,
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

  private async synthesizeAnswer(
    question: string,
    rows: Record<string, unknown>[],
    evidence: NeighborsResponse,
  ): Promise<string> {
    const prompt = [
      '질문과 Cypher 결과, 근거 그래프를 바탕으로 한국어 답변을 작성하라.',
      '응답은 반드시 JSON 하나만 출력한다. 형식: {"answer":"답변"}',
      `Question: ${question}`,
      `Rows: ${JSON.stringify(rows, jsonSafeReplacer).slice(0, 20_000)}`,
      `Evidence: ${JSON.stringify(evidence).slice(0, 20_000)}`,
    ].join('\n\n');
    return (
      await this.completeStructured(prompt, AnswerResponseSchema, {
        timeoutMs: 90_000,
        model: process.env.LLM_MODEL,
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
  const nodeLines = NODE_LABELS.map((label) => `${label} key=${NODE_KEY_PROPERTIES[label]}`).join(', ');
  const relLines = RELATIONSHIP_TYPES.join(', ');
  return `Ontology nodes: ${nodeLines}\nRelationship types: ${relLines}`;
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
