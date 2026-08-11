import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CURRENT_EXTRACTION_POINTER_FILE,
  EXTRACTED_FILE,
  EXTRACTION_GENERATIONS_DIRECTORY,
  EXTRACTION_MANIFEST_FILE,
  MEMORY_SCHEMA_VERSION,
  type MemoryRecord,
} from "@devloop/shared";
import { publishExtractionGeneration } from "./extraction-generation-publisher";
import { canonicalString, sha256 } from "./evidence-serialization";
import { buildMemoryWiki, CURRENT_WIKI_POINTER_FILE, MEMORY_KIND_DIRECTORIES, WIKI_GENERATIONS_DIRECTORY, WIKI_INDEX_FILE } from "./wiki-builder";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "memory-wiki-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sourceRef(id: string, url = `https://example.com/${id}`): MemoryRecord["sourceRefs"][number] {
  return { sourceType: "dooray-task", sourceId: id, title: `${id} 원문`, url };
}

function memory(idSeed: string, title: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: `mem-${idSeed.repeat(64).slice(0, 64)}`,
    title,
    kind: "decision",
    status: "active",
    confidence: "high",
    summary: `${title} 요약`,
    why: `${title} 이유`,
    doNot: ["원문 없이 복제하지 않는다."],
    scope: { project: "tc-ocr", repositories: ["ocr-api"], modules: ["memory"], paths: ["apps/pipeline/src/memory"] },
    validFrom: "2026-08-11",
    validUntil: null,
    lastVerified: "2026-08-11",
    relatedTerms: ["memory"],
    sourceRefs: [sourceRef(`${idSeed}-source`)],
    ...overrides,
  };
}

async function publishExtraction(dataDir: string, records: readonly MemoryRecord[], complete = true): Promise<void> {
  await publishExtractionGeneration(
    dataDir,
    {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      project: "tc-ocr",
      sourceGenerationId: `src-${"a".repeat(64)}`,
      sourceManifestHash: `sha256:${"b".repeat(64)}`,
      selection: { mode: "all" },
      successfulPacketIds: ["packet-a"],
      failedPacketIds: complete ? [] : ["packet-b"],
      model: "gpt-5.6-luna",
      effort: "low",
      promptVersion: "test",
      complete,
    },
    records,
  );
}

async function readTree(directory: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else output.set(path.relative(directory, absolute), await readFile(absolute, "utf8"));
    }
  }
  await walk(directory);
  return output;
}

describe("Memory wiki builder", () => {
  it("같은 extracted 입력에서 Markdown과 index byte를 결정적으로 만들고 모든 URL을 보존한다", async () => {
    const firstDataDir = await temporaryDirectory();
    const secondDataDir = await temporaryDirectory();
    const records = [
      memory("b", "동일 제목", {
        sourceRefs: [sourceRef("b-source", "https://example.com/b?from=task"), sourceRef("b-comment", "https://example.com/b#comment")],
      }),
      memory("a", "동일 제목", { kind: "constraint", sourceRefs: [sourceRef("a-source", "https://example.com/a")] }),
    ];
    await publishExtraction(firstDataDir, records);
    await publishExtraction(secondDataDir, [...records].reverse());

    const first = await buildMemoryWiki({ project: "tc-ocr", dataDir: firstDataDir });
    const second = await buildMemoryWiki({ project: "tc-ocr", dataDir: secondDataDir });

    assert.equal(first.wikiGenerationId, second.wikiGenerationId);
    const firstTree = await readTree(path.join(firstDataDir, "memory", "tc-ocr", WIKI_GENERATIONS_DIRECTORY, first.wikiGenerationId));
    const secondTree = await readTree(path.join(secondDataDir, "memory", "tc-ocr", WIKI_GENERATIONS_DIRECTORY, second.wikiGenerationId));
    assert.deepEqual(firstTree, secondTree);
    const combined = [...firstTree.values()].join("\n");
    assert.match(combined, /https:\/\/example\.com\/a/);
    assert.match(combined, /https:\/\/example\.com\/b\?from=task/);
    assert.match(combined, /https:\/\/example\.com\/b#comment/);
    assert.equal([...firstTree.keys()].filter((value) => value.endsWith(".md") && value.includes("동일-제목-")).length, 2);
  });

  it("incomplete extraction은 기본 거부하고 allow-incomplete에서는 complete=false index를 만든다", async () => {
    const dataDir = await temporaryDirectory();
    await publishExtraction(dataDir, [memory("c", "부분 추출")], false);

    await assert.rejects(buildMemoryWiki({ project: "tc-ocr", dataDir }), /allow-incomplete/);
    const result = await buildMemoryWiki({ project: "tc-ocr", dataDir, allowIncomplete: true });
    const pointer = JSON.parse(await readFile(path.join(dataDir, "memory", "tc-ocr", CURRENT_WIKI_POINTER_FILE), "utf8")) as { generationId: string };
    const index = JSON.parse(
      await readFile(path.join(dataDir, "memory", "tc-ocr", WIKI_GENERATIONS_DIRECTORY, pointer.generationId, WIKI_INDEX_FILE), "utf8"),
    ) as {
      complete: boolean;
    };
    assert.equal(result.complete, false);
    assert.equal(index.complete, false);
  });

  it("Memory kind는 data-schema 계약의 plural directory로 쓴다", async () => {
    const dataDir = await temporaryDirectory();
    await publishExtraction(dataDir, [
      memory("d", "결정", { kind: "decision" }),
      memory("e", "제약", { kind: "constraint" }),
      memory("f", "장애", { kind: "incident" }),
      memory("1", "실패", { kind: "failed-attempt" }),
      memory("2", "교훈", { kind: "lesson" }),
    ]);

    const result = await buildMemoryWiki({ project: "tc-ocr", dataDir });
    const tree = await readTree(path.join(dataDir, "memory", "tc-ocr", WIKI_GENERATIONS_DIRECTORY, result.wikiGenerationId));
    for (const directory of Object.values(MEMORY_KIND_DIRECTORIES)) {
      assert.equal(
        [...tree.keys()].some((value) => value.startsWith(`${directory}/`) && value.endsWith(".md")),
        true,
      );
    }
  });

  it("buildMemoryWiki는 project path segment를 읽기 전에 검증한다", async () => {
    await assert.rejects(buildMemoryWiki({ project: "../../outside", dataDir: await temporaryDirectory() }), /project는/);
  });

  it("Memory title 개행은 builder 입력 검증에서 거부한다", async () => {
    const dataDir = await temporaryDirectory();
    const projectDirectory = path.join(dataDir, "memory", "tc-ocr");
    const generationId = `ext-${"d".repeat(64)}`;
    const generationDirectory = path.join(projectDirectory, EXTRACTION_GENERATIONS_DIRECTORY, generationId);
    await mkdir(generationDirectory, { recursive: true });
    const invalidRecord = { ...memory("d", "깨진\n제목"), title: "깨진\n제목" };
    const extractedText = `${canonicalString(invalidRecord)}\n`;
    const manifest = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      project: "tc-ocr",
      sourceGenerationId: `src-${"a".repeat(64)}`,
      sourceManifestHash: `sha256:${"b".repeat(64)}`,
      selection: { mode: "all" },
      successfulPacketIds: ["packet-a"],
      failedPacketIds: [],
      resultContentHash: sha256(extractedText),
      model: "gpt-5.6-luna",
      effort: "low",
      promptVersion: "test",
      complete: true,
      extractionGenerationId: generationId,
    };
    await writeFile(path.join(generationDirectory, EXTRACTION_MANIFEST_FILE), `${canonicalString(manifest)}\n`, "utf8");
    await writeFile(path.join(generationDirectory, EXTRACTED_FILE), extractedText, "utf8");
    await writeFile(
      path.join(projectDirectory, CURRENT_EXTRACTION_POINTER_FILE),
      `${canonicalString({ schemaVersion: MEMORY_SCHEMA_VERSION, generationId })}\n`,
      "utf8",
    );

    await assert.rejects(buildMemoryWiki({ project: "tc-ocr", dataDir }), /title은 한 줄/);
  });
});
