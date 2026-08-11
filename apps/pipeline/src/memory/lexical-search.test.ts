import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { MEMORY_SCHEMA_VERSION, type MemoryRecord } from "@devloop/shared";
import { searchMemory, searchWikiIndex, tokenize } from "./lexical-search";
import { normalizeSearchText, type WikiIndex } from "./wiki-builder";

function sourceRef(id: string): MemoryRecord["sourceRefs"][number] {
  return { sourceType: "dooray-task", sourceId: id, title: `${id} 원문`, url: `https://example.com/${id}` };
}

function memory(idSeed: string, title: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: `mem-${idSeed.repeat(64).slice(0, 64)}`,
    title,
    kind: "decision",
    status: "active",
    confidence: "medium",
    summary: "일반 본문 설명",
    why: "운영 이유",
    doNot: [],
    scope: { project: "tc-ocr", repositories: ["ocr-api"], modules: ["memory"], paths: ["apps/pipeline/src/memory/wiki-builder.ts"] },
    validFrom: "2026-08-11",
    validUntil: null,
    lastVerified: "2026-08-11",
    relatedTerms: [],
    sourceRefs: [sourceRef(`${idSeed}-source`)],
    ...overrides,
  };
}

function document(record: MemoryRecord): WikiIndex["documents"][number] {
  const scope = [record.scope.project, ...record.scope.repositories, ...record.scope.modules, ...record.scope.paths].join(" ");
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    status: record.status,
    confidence: record.confidence,
    summary: record.summary,
    why: record.why,
    doNot: record.doNot,
    scope: record.scope,
    relatedTerms: record.relatedTerms,
    sourceRefs: record.sourceRefs,
    markdownPath: `${record.kind}/${record.id}.md`,
    normalized: {
      title: normalizeSearchText(record.title),
      relatedTerms: record.relatedTerms.map(normalizeSearchText),
      summary: normalizeSearchText(record.summary),
      why: normalizeSearchText(record.why),
      scope: normalizeSearchText(scope),
    },
    record,
  };
}

function index(records: readonly MemoryRecord[], complete = true): WikiIndex {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    project: "tc-ocr",
    wikiGenerationId: `wiki-${"1".repeat(64)}`,
    extractionGenerationId: `ext-${"2".repeat(64)}`,
    sourceGenerationId: `src-${"3".repeat(64)}`,
    sourceManifestHash: `sha256:${"4".repeat(64)}`,
    extractionManifestHash: `sha256:${"5".repeat(64)}`,
    complete,
    documents: records.map(document),
  };
}

describe("Memory lexical search", () => {
  it("query를 lowercase Unicode normalize와 문장부호 기준으로 token화한다", () => {
    assert.deepEqual(tokenize("  Café, 운영-장애!!  "), ["café", "운영", "장애"]);
  });

  it("title과 relatedTerms 일치를 본문 약한 일치보다 높게 순위화하고 URL을 보존한다", () => {
    const result = searchWikiIndex(
      index([
        memory("a", "일반 결정", { summary: "migration 단어만 본문에 있다.", confidence: "high", sourceRefs: [sourceRef("summary-hit")] }),
        memory("b", "migration 정책", { confidence: "low", sourceRefs: [sourceRef("title-hit")] }),
        memory("c", "다른 결정", { relatedTerms: ["migration"], sourceRefs: [sourceRef("term-hit")] }),
      ]),
      { query: "migration", topK: 3 },
    );

    assert.deepEqual(
      result.results.map((entry) => entry.id),
      [`mem-${"b".repeat(64)}`, `mem-${"c".repeat(64)}`, `mem-${"a".repeat(64)}`],
    );
    assert.equal(result.results[0].sourceRefs[0]?.url, "https://example.com/title-hit");
  });

  it("scope filter와 top-k 상한을 적용하고 0건은 정상 JSON 응답으로 반환한다", () => {
    const records = [
      memory("a", "검색 대상", { scope: { project: "tc-ocr", repositories: ["ocr-api"], modules: ["memory"], paths: ["apps/pipeline/src/memory"] } }),
      memory("b", "검색 대상", { scope: { project: "tc-ocr", repositories: ["ocr-admin"], modules: ["ui"], paths: ["apps/web"] } }),
    ];

    const filtered = searchWikiIndex(index(records), {
      query: "검색",
      repository: "ocr-api",
      path: "apps/pipeline/src/memory/wiki-builder.ts",
      topK: 1000,
    });
    assert.equal(filtered.documentsScanned, 1);
    assert.equal(filtered.returned, 1);

    const empty = searchWikiIndex(index(records), { query: "없는단어", repository: "ocr-api" });
    assert.deepEqual(empty.results, []);
    assert.equal(empty.returned, 0);
  });

  it("status 감점과 경고, confidence와 ID tie-break를 적용한다", () => {
    const result = searchWikiIndex(
      index([
        memory("d", "동률 검색", { confidence: "medium" }),
        memory("a", "동률 검색", { confidence: "high" }),
        memory("c", "동률 검색", { status: "deprecated", confidence: "high" }),
      ]),
      { query: "동률", topK: 3 },
    );

    assert.deepEqual(
      result.results.map((entry) => entry.id),
      [`mem-${"a".repeat(64)}`, `mem-${"d".repeat(64)}`, `mem-${"c".repeat(64)}`],
    );
    assert.equal(result.results[0].score > result.results[2].score, true);
    assert.match(result.results[2].statusWarning ?? "", /deprecated/);
  });

  it("why만 약하게 match된 inactive record도 status penalty 때문에 숨기지 않는다", () => {
    const result = searchWikiIndex(
      index([
        memory("a", "다른 제목", { status: "deprecated", why: "legacy context only" }),
        memory("b", "다른 제목", { status: "superseded", why: "legacy context only" }),
        memory("c", "다른 제목", { status: "historical", why: "legacy context only" }),
      ]),
      { query: "legacy", topK: 3 },
    );

    assert.deepEqual(
      result.results.map((entry) => [entry.status, entry.score]),
      [
        ["historical", 1],
        ["deprecated", 1],
        ["superseded", 1],
      ],
    );
    assert.equal(result.returned, 3);
  });

  it("incomplete index는 기본 거부하고 allow-incomplete에서만 검색한다", () => {
    const fixture = index([memory("a", "부분 검색")], false);
    assert.throws(() => searchWikiIndex(fixture, { query: "부분" }), /allow-incomplete/);
    assert.equal(searchWikiIndex(fixture, { query: "부분", allowIncomplete: true }).returned, 1);
  });

  it("검색 모듈은 LLM, Neo4j, Postgres import를 갖지 않는다", async () => {
    const source = await readFile(path.resolve(__dirname, "../../src/memory/lexical-search.ts"), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*(llm|neo4j-driver|pg|neo4j)[^"']*["']/);
    assert.doesNotMatch(source, /require\(["'][^"']*(llm|neo4j-driver|pg|neo4j)[^"']*["']\)/);
  });

  it("searchMemory는 project path segment를 읽기 전에 검증한다", async () => {
    await assert.rejects(searchMemory("/tmp/no-such-data", "../../outside", { query: "q" }), /project는/);
  });
});
