import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptAliasMap, normalizeConceptKey } from "../resolve/concept-alias";
import { normalizeGraph } from "../resolve/resolve";
import type { ResolveResult } from "../resolve/resolve.schema";
import { buildLoadSummary } from "./sync";

test("Concept 강화 키는 대소문자·공백·구두점 차이를 제거한다", () => {
  assert.equal(normalizeConceptKey("OCR.API"), "ocrapi");
  assert.equal(normalizeConceptKey("OCR API"), "ocrapi");
  assert.equal(normalizeConceptKey("Document AI"), "documentai");
  assert.equal(normalizeConceptKey("DocumentAI"), "documentai");
  assert.equal(normalizeConceptKey("Request-Key"), "requestkey");
  assert.equal(normalizeConceptKey("requestkey"), "requestkey");
});

test("강화 키로 사전 Concept을 canonical 노드 하나로 병합한다", () => {
  const aliasMap = buildConceptAliasMap([{ canonical: "OCR.API", kind: "component", aliases: [] }]);
  const graph = normalizeGraph(
    [
      {
        label: "Concept",
        key: "OCR.API",
        properties: { name: "OCR.API", kind: "component" },
      },
      {
        label: "Concept",
        key: "OCR API",
        properties: {
          name: "OCR API",
          kind: "component",
          sourceDocId: "Task:1",
        },
      },
    ],
    [],
    aliasMap,
    undefined,
    ["parsed.jsonl", "inferred.jsonl"],
  );

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].key, "OCR.API");
  assert.equal(graph.nodes[0].properties.source, "llm");
  assert.equal(graph.nodes[0].properties.dictMatched, true);
});

test("사전 exact 매칭은 강화 키 매칭보다 우선한다", () => {
  const aliasMap = buildConceptAliasMap([
    { canonical: "Document AI", kind: "component", aliases: [] },
    { canonical: "DocumentAI", kind: "product", aliases: [] },
  ]);
  const graph = normalizeGraph(
    [
      {
        label: "Concept",
        key: "Document AI",
        properties: { name: "Document AI", kind: "component" },
      },
    ],
    [],
    aliasMap,
    undefined,
    ["inferred.jsonl"],
  );

  assert.equal(graph.nodes[0].key, "Document AI");
  assert.equal(graph.nodes[0].properties.kind, "component");
});

test("해결되지 않은 강화 키의 사전 canonical 충돌은 조치를 안내하며 실패한다", () => {
  assert.throws(
    () =>
      buildConceptAliasMap([
        { canonical: "Unapproved Key", kind: "tech", aliases: [] },
        { canonical: "Unapproved-Key", kind: "tech", aliases: [] },
      ]),
    /Merge the entries in the concept dictionary or add a canonical override/,
  );
});

// 회귀 테스트 — `sync-neo4j` 표준출력의 `unknownConcepts` 는 기준 커밋(plan001-resolve-graph-stage)과
// 같이 객체 형태여야 한다. `resolve-report.json`(resolve-graph 산출물)은 튜플 배열을 쓰지만, 이 둘은
// 서로 다른 계약이다 — sync-neo4j 표준출력 스키마를 이번 리팩토링에서 조용히 바꾸면 안 된다.
// Neo4j 접속 없이 판정하기 위해 `buildLoadSummary` 를 직접 호출한다.
test("buildLoadSummary 는 unknownConcepts 를 정렬된 객체로 낸다 (튜플 배열이 아니다)", () => {
  const resolved: ResolveResult = {
    nodes: [
      { label: "Task", key: "1", properties: { number: 1 } },
      { label: "Task", key: "2", properties: { number: 2 } },
    ],
    relationships: [],
    unknownConcepts: new Map([
      ["b", 1],
      ["a", 2],
    ]),
    skippedRelationships: { count: 0, samples: [] },
    droppedRelationships: { count: 0, documents: [] },
    rewrittenRelationships: 0,
  };
  const stats = { nodes: { Task: 2 }, relationships: {} };

  const summary = buildLoadSummary({ project: "sample", dataDir: "/data" }, resolved, stats) as {
    unknownConcepts: unknown;
    loaded: { nodes: number; relationships: number };
  };

  assert.deepEqual(summary.unknownConcepts, { a: 2, b: 1 });
  assert.equal(Array.isArray(summary.unknownConcepts), false);
  assert.deepEqual(summary.loaded, { nodes: 2, relationships: 0 });
});

test("부당 병합 denylist는 API 경로와 일반 이름을 분리한다", () => {
  const aliasMap = buildConceptAliasMap([{ canonical: "analysis", kind: "code-ref", aliases: [] }]);
  const graph = normalizeGraph(
    [
      {
        label: "Concept",
        key: "/analysis",
        properties: { name: "/analysis", kind: "code-ref" },
      },
      {
        label: "Concept",
        key: "analysis",
        properties: { name: "analysis", kind: "code-ref" },
      },
    ],
    [],
    aliasMap,
    undefined,
    ["inferred.jsonl", "inferred.jsonl"],
  );

  assert.deepEqual(graph.nodes.map((node) => node.key).sort(), ["/analysis", "analysis"]);
});

test("사전 밖 Concept에도 부당 병합 denylist를 적용한다", () => {
  const graph = normalizeGraph(
    [
      {
        label: "Concept",
        key: "/analysis",
        properties: { name: "/analysis", kind: "code-ref" },
      },
      {
        label: "Concept",
        key: "analysis",
        properties: { name: "analysis", kind: "code-ref" },
      },
      {
        label: "Concept",
        key: "cloud.toast.com",
        properties: { name: "cloud.toast.com", kind: "domain" },
      },
      {
        label: "Concept",
        key: "*.cloud.toast.com",
        properties: { name: "*.cloud.toast.com", kind: "domain" },
      },
    ],
    [],
    new Map(),
    undefined,
    ["inferred.jsonl", "inferred.jsonl", "inferred.jsonl", "inferred.jsonl"],
  );

  assert.deepEqual(graph.nodes.map((node) => node.key).sort(), ["*.cloud.toast.com", "/analysis", "analysis", "cloud.toast.com"]);
});

test("사전 밖 Concept은 관계 참조가 가장 많은 표기로 병합하고 원래 끝점도 해석한다", () => {
  const graph = normalizeGraph(
    [
      {
        label: "Task",
        key: "1",
        properties: { number: 1 },
      },
      {
        label: "Concept",
        key: "fastapi",
        properties: { name: "fastapi", kind: "tech" },
      },
      {
        label: "Concept",
        key: "fast api",
        properties: { name: "fast api", kind: "tech" },
      },
    ],
    [
      {
        type: "MENTIONS",
        startKey: "Task:1",
        endKey: "Concept:fastapi",
        properties: {},
      },
      {
        type: "DOCUMENTS",
        startKey: "Task:1",
        endKey: "Concept:fastapi",
        properties: {},
      },
      {
        type: "MENTIONS",
        startKey: "Task:1",
        endKey: "Concept:fast api",
        properties: {},
      },
    ],
    new Map(),
    ["inferred.jsonl", "inferred.jsonl", "inferred.jsonl"],
    ["parsed.jsonl", "inferred.jsonl", "inferred.jsonl"],
  );

  assert.deepEqual(
    graph.nodes.filter((node) => node.label === "Concept").map((node) => node.key),
    ["fastapi"],
  );
  assert.ok(graph.relationships.every((relationship) => relationship.endKey === "fastapi"));
  assert.equal(graph.skippedRelationships.count, 0);
});

test("사전 밖 Concept의 연결 수와 등장 수가 같으면 사전순 대표를 고른다", () => {
  const graph = normalizeGraph(
    [
      {
        label: "Concept",
        key: "secretkey",
        properties: { name: "secretkey", kind: "tech" },
      },
      {
        label: "Concept",
        key: "secret key",
        properties: { name: "secret key", kind: "tech" },
      },
    ],
    [],
    new Map(),
    undefined,
    ["inferred.jsonl", "inferred.jsonl"],
  );

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].key, "secret key");
});

test("태그 alias는 별도 canonical 없이 같은 Concept 관계 끝점으로 해석한다", () => {
  const aliasMap = buildConceptAliasMap([
    {
      canonical: "Document AI",
      kind: "product",
      aliases: ["DocumentAI", "1: DocumentAI"],
    },
  ]);
  const graph = normalizeGraph(
    [
      {
        label: "Task",
        key: "1",
        properties: { number: 1 },
      },
      {
        label: "Concept",
        key: "1: DocumentAI",
        properties: { name: "1: DocumentAI", kind: "product" },
      },
      {
        label: "Concept",
        key: "DocumentAI",
        properties: { name: "DocumentAI", kind: "product" },
      },
    ],
    [
      {
        type: "TAGGED",
        startKey: "Task:1",
        endKey: "Concept:1: DocumentAI",
        properties: { dimension: "1" },
      },
      {
        type: "MENTIONS",
        startKey: "Task:1",
        endKey: "Concept:DocumentAI",
        properties: {},
      },
    ],
    aliasMap,
    ["parsed.jsonl", "inferred.jsonl"],
    ["parsed.jsonl", "parsed.jsonl", "inferred.jsonl"],
  );

  assert.equal(graph.nodes.filter((node) => node.label === "Concept").length, 1);
  assert.ok(graph.relationships.every((relationship) => relationship.endKey === "Document AI"));
  assert.equal(graph.skippedRelationships.count, 0);
});

test("LLM Concept의 사전 매칭 여부와 출처를 독립적으로 기록한다", () => {
  const aliasMap = buildConceptAliasMap([{ canonical: "Request-Key", kind: "tech", aliases: [] }]);
  const graph = normalizeGraph(
    [
      {
        label: "Concept",
        key: "requestkey",
        properties: {
          name: "requestkey",
          kind: "tech",
          sourceDocId: "Task:1",
        },
      },
      {
        label: "Concept",
        key: "unlisted.concept",
        properties: {
          name: "unlisted.concept",
          kind: "tech",
          sourceDocId: "Task:2",
        },
      },
    ],
    [],
    aliasMap,
    undefined,
    ["inferred.jsonl", "inferred.jsonl"],
  );

  const matched = graph.nodes.find((node) => node.key === "Request-Key");
  const unmatched = graph.nodes.find((node) => node.key === "unlisted.concept");
  assert.equal(matched?.properties.source, "llm");
  assert.equal(matched?.properties.dictMatched, true);
  assert.equal(unmatched?.properties.source, "llm");
  assert.equal(unmatched?.properties.dictMatched, false);
});

test("structural Concept은 사전에 없는 상태로 저장하지 않는다", () => {
  assert.throws(
    () =>
      normalizeGraph(
        [
          {
            label: "Concept",
            key: "unlisted.concept",
            properties: { name: "unlisted.concept", kind: "tech" },
          },
        ],
        [],
        new Map(),
      ),
    /Structural Concept "unlisted\.concept" is missing from the concept dictionary/,
  );
});
