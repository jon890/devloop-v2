import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CURRENT_EXTRACTION_POINTER_FILE,
  EXTRACTED_FILE,
  EXTRACTION_GENERATIONS_DIRECTORY,
  EXTRACTION_MANIFEST_FILE,
  EXTRACTION_RUN_REPORT_FILE,
  EXTRACTION_RUNS_DIRECTORY,
  MEMORY_SCHEMA_VERSION,
  type EvidencePacket,
} from "@devloop/shared";
import type { LlmCli, LlmOptions, LlmResult } from "../llm";
import { hashCanonical, packetWithContentHash } from "./evidence-serialization";
import { readExtractionCache, writeExtractionCache, type ExtractionCacheIdentity } from "./experience-cache";
import { ExperienceDraftSchema, type ExperienceDraft } from "./experience-extraction.schema";
import {
  extractExperienceWithLlmForTest,
  MEMORY_EXTRACTION_EFFORT,
  MEMORY_EXTRACTION_MODEL,
  type ExtractExperienceResult,
} from "./experience-extractor";
import { EXPERIENCE_OUTPUT_JSON_SCHEMA, EXPERIENCE_PROMPT_VERSION } from "./experience-prompt";
import { publishSourceGeneration, type SourceManifest } from "./source-generation-publisher";

const temporaryDirectories: string[] = [];
const SOURCE_GENERATION_ID = `src-${"a".repeat(64)}`;

function collectSchemaKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectSchemaKeys(child, keys);
  }
  return keys;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "memory-extractor-"));
  temporaryDirectories.push(directory);
  return directory;
}

function packet(id: string, sourceKind: "dooray-task" | "dooray-wiki" = "dooray-task"): EvidencePacket {
  const sourceId = `${id}-source`;
  const sourceRefKey = `${sourceKind}:${sourceId}`;
  return packetWithContentHash({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id,
    project: "tc-ocr",
    sourceKind,
    title: `${id} title`,
    scope: { project: "tc-ocr", repositories: [], paths: [] },
    segments: [{ sourceRefKey, text: `${id}의 직접 근거` }],
    sourceRefs: [{ sourceType: sourceKind, sourceId, title: `${id} source`, url: `https://example.com/${sourceId}` }],
  });
}

async function publishSource(dataDir: string, packets: readonly EvidencePacket[]): Promise<void> {
  const manifest: SourceManifest = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    project: "tc-ocr",
    sourceGenerationId: SOURCE_GENERATION_ID,
    dooray: { contentHash: `sha256:${"b".repeat(64)}`, tasks: packets.length, comments: 0, wikis: 0 },
    gitRepositories: [],
  };
  await publishSourceGeneration(dataDir, manifest, packets);
}

function draft(sourceRefKey: string): ExperienceDraft {
  return {
    title: `고정 모델을 사용한다 ${sourceRefKey}`,
    kind: "constraint",
    status: "active",
    confidence: "high",
    summary: "Memory 추출 모델을 고정한다.",
    why: "비용과 cache 비교 조건을 흔들리지 않게 한다.",
    doNot: ["다른 모델로 fallback하지 않는다."],
    scope: { project: "tc-ocr", repositories: [], modules: ["memory"], paths: [] },
    validFrom: "2026-08-11",
    validUntil: null,
    lastVerified: "2026-08-11",
    relatedTerms: ["luna", "cache"],
    sourceRefKeys: [sourceRefKey],
  };
}

class FakeLlm implements LlmCli {
  readonly calls: Array<{ prompt: string; options: LlmOptions | undefined }> = [];
  maxActive = 0;
  private active = 0;

  constructor(private readonly outputs: Array<string | Error>) {}

  async complete(prompt: string, options?: LlmOptions): Promise<LlmResult> {
    this.calls.push({ prompt, options });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    if (output === undefined) throw new Error("예상하지 않은 LLM 호출");
    return { text: output, elapsedMs: 1 };
  }
}

async function extractionFiles(dataDir: string, result: ExtractExperienceResult): Promise<{ manifest: string; extracted: string }> {
  const directory = path.join(dataDir, "memory", "tc-ocr", EXTRACTION_GENERATIONS_DIRECTORY, result.extractionGenerationId);
  return {
    manifest: await readFile(path.join(directory, EXTRACTION_MANIFEST_FILE), "utf8"),
    extracted: await readFile(path.join(directory, EXTRACTED_FILE), "utf8"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Experience output schema", () => {
  it("Responses strict schema 요청에서 지원하지 않는 string/array 제약 키를 싣지 않는다", () => {
    const keys = collectSchemaKeys(EXPERIENCE_OUTPUT_JSON_SCHEMA);
    assert.equal(keys.has("minLength"), false);
    assert.equal(keys.has("uniqueItems"), false);
  });

  it("sourceRefKeys 중복은 request schema가 아니라 Zod post-validation에서 거부한다", () => {
    const value = draft("dooray-task:a");
    assert.throws(() => ExperienceDraftSchema.parse({ ...value, sourceRefKeys: ["dooray-task:a", "dooray-task:a"] }), /중복/);
  });
});

describe("Experience extractor", () => {
  it("Luna low와 structured schema를 한 번씩 순차 호출하고 현재 packet provenance만 저장한다", async () => {
    const dataDir = await temporaryDirectory();
    const packets = [packet("packet-b", "dooray-wiki"), packet("packet-a")];
    await publishSource(dataDir, packets);
    const ordered = [...packets].sort((left, right) => left.id.localeCompare(right.id));
    const fake = new FakeLlm(ordered.map((value) => JSON.stringify({ memories: [draft(value.segments[0].sourceRefKey)] })));
    const originalModel = process.env.LLM_MODEL;
    const originalQueryModel = process.env.QUERY_LLM_MODEL;
    const originalProvider = process.env.LLM_PROVIDER;
    const originalEffort = process.env.LLM_REASONING_EFFORT;
    process.env.LLM_MODEL = "gpt-5.5";
    process.env.QUERY_LLM_MODEL = "gpt-5.6-terra";
    process.env.LLM_PROVIDER = "claude";
    process.env.LLM_REASONING_EFFORT = "high";
    try {
      const result = await extractExperienceWithLlmForTest({ project: "tc-ocr", dataDir }, fake);

      assert.equal(result.complete, true);
      assert.equal(result.calls, 2);
      assert.equal(result.cacheHits, 0);
      assert.equal(fake.maxActive, 1, "concurrency는 1이어야 한다");
      assert.deepEqual(new Set(fake.calls.map((call) => call.options?.model)), new Set(["gpt-5.6-luna"]));
      assert.deepEqual(new Set(fake.calls.map((call) => call.options?.effort)), new Set(["low"]));
      assert.equal(
        fake.calls.every((call) => call.options?.outputSchema === EXPERIENCE_OUTPUT_JSON_SCHEMA),
        true,
      );
      assert.equal(
        fake.calls.every((call) => call.prompt.includes("Never create a source key")),
        true,
      );

      const records = (await extractionFiles(dataDir, result)).extracted
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { sourceRefs: Array<{ sourceId: string; url: string }> });
      assert.equal(records.length, 2);
      assert.deepEqual(
        new Set(records.flatMap((record) => record.sourceRefs.map((ref) => ref.sourceId))),
        new Set(packets.map((value) => value.sourceRefs[0].sourceId)),
      );
      assert.equal(
        records.every((record) => record.sourceRefs.every((ref) => ref.url.startsWith("https://example.com/"))),
        true,
      );
    } finally {
      if (originalModel === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = originalModel;
      if (originalQueryModel === undefined) delete process.env.QUERY_LLM_MODEL;
      else process.env.QUERY_LLM_MODEL = originalQueryModel;
      if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = originalProvider;
      if (originalEffort === undefined) delete process.env.LLM_REASONING_EFFORT;
      else process.env.LLM_REASONING_EFFORT = originalEffort;
    }
  });

  it("cache 재실행은 같은 immutable generation을 가리키고 새 run report에 calls 0을 기록한다", async () => {
    const dataDir = await temporaryDirectory();
    const evidence = packet("packet-a");
    await publishSource(dataDir, [evidence]);
    const first = await extractExperienceWithLlmForTest(
      { project: "tc-ocr", dataDir },
      new FakeLlm([JSON.stringify({ memories: [draft(evidence.segments[0].sourceRefKey)] })]),
    );
    const firstFiles = await extractionFiles(dataDir, first);
    const secondFake = new FakeLlm([]);
    const second = await extractExperienceWithLlmForTest({ project: "tc-ocr", dataDir }, secondFake);
    const secondFiles = await extractionFiles(dataDir, second);

    assert.equal(second.extractionGenerationId, first.extractionGenerationId);
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.calls, 0);
    assert.equal(second.cacheHits, 1);
    assert.equal(secondFake.calls.length, 0);
    assert.deepEqual(secondFiles, firstFiles);
    const report = JSON.parse(
      await readFile(path.join(dataDir, "memory", "tc-ocr", EXTRACTION_RUNS_DIRECTORY, second.runId, EXTRACTION_RUN_REPORT_FILE), "utf8"),
    ) as { calls: number; cacheHits: number; errors: unknown[] };
    assert.deepEqual({ calls: report.calls, cacheHits: report.cacheHits, errors: report.errors }, { calls: 0, cacheHits: 1, errors: [] });
    const pointer = JSON.parse(await readFile(path.join(dataDir, "memory", "tc-ocr", CURRENT_EXTRACTION_POINTER_FILE), "utf8")) as {
      generationId: string;
    };
    assert.equal(pointer.generationId, first.extractionGenerationId);
  });

  for (const [name, mutate, expected] of [
    ["unknown source ref", (value: Record<string, unknown>) => ({ ...value, sourceRefKeys: ["dooray-task:unknown"] }), /존재하지 않는 sourceRefKeys/],
    ["invalid enum", (value: Record<string, unknown>) => ({ ...value, kind: "convention" }), /Invalid enum value/],
    ["empty summary", (value: Record<string, unknown>) => ({ ...value, summary: "" }), /too_small|at least 1 character/],
  ] as const) {
    it(`${name} draft는 packet 실패로 기록하고 complete=false로 publication한다`, async () => {
      const dataDir = await temporaryDirectory();
      const evidence = packet(`packet-${name.replaceAll(" ", "-")}`);
      await publishSource(dataDir, [evidence]);
      const output = { memories: [mutate(draft(evidence.segments[0].sourceRefKey))] };
      const result = await extractExperienceWithLlmForTest({ project: "tc-ocr", dataDir }, new FakeLlm([JSON.stringify(output)]));

      assert.equal(result.complete, false);
      assert.equal(result.failedPackets, 1);
      assert.equal(result.memories, 0);
      const report = JSON.parse(await readFile(path.join(result.runDirectory, EXTRACTION_RUN_REPORT_FILE), "utf8")) as {
        errors: Array<{ packetId: string; error: string }>;
      };
      assert.equal(report.errors[0]?.packetId, evidence.id);
      assert.match(report.errors[0]?.error ?? "", expected);
    });
  }

  it("packet 일부만 실패하면 성공 Memory를 보존하면서 complete=false와 원래 오류를 기록한다", async () => {
    const dataDir = await temporaryDirectory();
    const first = packet("packet-a");
    const second = packet("packet-b", "dooray-wiki");
    await publishSource(dataDir, [first, second]);
    const fake = new FakeLlm([JSON.stringify({ memories: [draft(first.segments[0].sourceRefKey)] }), new Error("upstream luna unavailable")]);

    const result = await extractExperienceWithLlmForTest({ project: "tc-ocr", dataDir }, fake);

    assert.equal(result.complete, false);
    assert.equal(result.succeededPackets, 1);
    assert.equal(result.failedPackets, 1);
    assert.equal(result.memories, 1);
    const report = JSON.parse(await readFile(path.join(result.runDirectory, EXTRACTION_RUN_REPORT_FILE), "utf8")) as {
      errors: Array<{ error: string }>;
    };
    assert.equal(report.errors[0]?.error, "upstream luna unavailable");
  });

  it("cache hit도 provenance를 다시 검증하며 invalid cache에서 LLM fallback이나 repair를 호출하지 않는다", async () => {
    const dataDir = await temporaryDirectory();
    const evidence = packet("packet-a");
    await publishSource(dataDir, [evidence]);
    const identity: ExtractionCacheIdentity = {
      contentHash: evidence.contentHash,
      promptVersion: EXPERIENCE_PROMPT_VERSION,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      model: MEMORY_EXTRACTION_MODEL,
      effort: MEMORY_EXTRACTION_EFFORT,
    };
    await writeExtractionCache(dataDir, "tc-ocr", identity, {
      memories: [draft("dooray-task:unknown")],
    });
    const fake = new FakeLlm([]);

    const result = await extractExperienceWithLlmForTest({ project: "tc-ocr", dataDir }, fake);

    assert.equal(result.complete, false);
    assert.equal(result.cacheHits, 1);
    assert.equal(result.calls, 0);
    assert.equal(fake.calls.length, 0);
  });

  it("부분 selection은 실패가 없어도 complete=false이고 sourceKind별 ID 앞 n개를 고른다", async () => {
    const dataDir = await temporaryDirectory();
    const packets = [packet("task-b"), packet("wiki-b", "dooray-wiki"), packet("task-a"), packet("wiki-a", "dooray-wiki")];
    await publishSource(dataDir, packets);
    const fake = new FakeLlm([
      JSON.stringify({ memories: [draft("dooray-task:task-a-source")] }),
      JSON.stringify({ memories: [draft("dooray-wiki:wiki-a-source")] }),
    ]);

    const result = await extractExperienceWithLlmForTest({ project: "tc-ocr", dataDir, samplePerSource: 1 }, fake);

    assert.equal(result.complete, false);
    assert.equal(result.selectedPackets, 2);
    assert.equal(fake.calls[0]?.prompt.includes('"id":"task-a"'), true);
    assert.equal(fake.calls[1]?.prompt.includes('"id":"wiki-a"'), true);
  });
});

describe("Experience extraction cache identity", () => {
  it("content, prompt, schema, model, effort가 하나라도 바뀌면 cache miss다", async () => {
    const dataDir = await temporaryDirectory();
    const output = { memories: [] };
    const identity: ExtractionCacheIdentity = {
      contentHash: `sha256:${"1".repeat(64)}`,
      promptVersion: EXPERIENCE_PROMPT_VERSION,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      model: MEMORY_EXTRACTION_MODEL,
      effort: MEMORY_EXTRACTION_EFFORT,
    };
    await writeExtractionCache(dataDir, "tc-ocr", identity, output);
    assert.deepEqual(await readExtractionCache(dataDir, "tc-ocr", identity), output);

    const variants: ExtractionCacheIdentity[] = [
      { ...identity, contentHash: `sha256:${"2".repeat(64)}` },
      { ...identity, promptVersion: `${identity.promptVersion}-next` },
      { ...identity, schemaVersion: identity.schemaVersion + 1 },
      { ...identity, model: `${identity.model}-other` },
      { ...identity, effort: "medium" },
    ];
    for (const variant of variants) assert.equal(await readExtractionCache(dataDir, "tc-ocr", variant), undefined);
    assert.equal(new Set(variants.map((variant) => hashCanonical(variant))).size, variants.length);
  });
});
