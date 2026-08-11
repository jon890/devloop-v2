import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { MEMORY_SCHEMA_VERSION } from "@devloop/shared";
import { parseBuildArgs, parseExtractArgs, parseNormalizeArgs, parseSearchArgs, runMemoryCli } from "./cli";
import { canonicalString } from "./evidence-serialization";
import { CURRENT_WIKI_POINTER_FILE, WIKI_GENERATIONS_DIRECTORY, WIKI_INDEX_FILE } from "./wiki-builder";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "memory-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("normalize-memory CLI", () => {
  it("normalize 명령의 project, git root, data dir를 해석한다", () => {
    const options = parseNormalizeArgs(["normalize", "--project", "tc-ocr", "--git-root", "./git", "--data-dir", "./data"]);
    assert.deepEqual(options, { project: "tc-ocr", gitRoot: path.resolve("./git"), dataDir: path.resolve("./data") });
  });

  it("필수 flag가 없으면 사용 전에 실패한다", () => {
    assert.throws(() => parseNormalizeArgs(["normalize", "--project", "tc-ocr"]), /--git-root/);
  });
});

describe("extract-memory CLI", () => {
  it("기본 project와 data dir, 단일 selection을 해석한다", () => {
    assert.deepEqual(parseExtractArgs(["extract", "--data-dir", "./data", "--sample-per-source", "3"]), {
      project: "tc-ocr",
      dataDir: path.resolve("./data"),
      samplePerSource: 3,
    });
    assert.deepEqual(parseExtractArgs(["extract", "--ids", "b,a"]), {
      project: "tc-ocr",
      dataDir: path.resolve(__dirname, "../../data"),
      ids: ["b", "a"],
    });
  });

  it("selection option은 상호 배타이고 양의 정수만 받는다", () => {
    assert.throws(() => parseExtractArgs(["extract", "--limit", "1", "--ids", "a"]), /상호 배타/);
    assert.throws(() => parseExtractArgs(["extract", "--sample-per-source", "0"]), /1 이상의 정수/);
  });

  it("model, provider, effort, concurrency override를 노출하지 않는다", () => {
    for (const flag of ["--model", "--provider", "--effort", "--concurrency"]) {
      assert.throws(() => parseExtractArgs(["extract", flag, "override"]), /지원하지 않는 option/);
    }
  });
});

describe("memory wiki/search CLI", () => {
  it("build 명령의 기본 project, data dir, allow-incomplete를 해석한다", () => {
    assert.deepEqual(parseBuildArgs(["build", "--data-dir", "./data", "--allow-incomplete"]), {
      project: "tc-ocr",
      dataDir: path.resolve("./data"),
      allowIncomplete: true,
    });
  });

  it("search 명령의 단일 JSON 계약 옵션을 해석한다", () => {
    assert.deepEqual(
      parseSearchArgs([
        "search",
        "--query",
        "운영 장애",
        "--project",
        "tc-ocr",
        "--repository",
        "ocr-api",
        "--module",
        "memory",
        "--path",
        "apps/api",
        "--top-k",
        "7",
        "--data-dir",
        "./data",
      ]),
      {
        query: "운영 장애",
        project: "tc-ocr",
        repository: "ocr-api",
        module: "memory",
        path: "apps/api",
        topK: 7,
        dataDir: path.resolve("./data"),
        allowIncomplete: false,
      },
    );
  });

  it("search는 query를 필수로 받고 allow-incomplete는 값 없는 boolean flag다", () => {
    assert.throws(() => parseSearchArgs(["search", "--project", "tc-ocr"]), /--query/);
    assert.equal(parseSearchArgs(["search", "--query", "q", "--allow-incomplete"]).allowIncomplete, true);
    assert.throws(() => parseSearchArgs(["search", "--query", "q", "--allow-incomplete", "true"]), /지원하지 않는 option/);
  });

  it("memory 명령은 project path segment를 manifest 계약으로 검증한다", () => {
    for (const invalid of ["../../outside", " ", ".hidden", "한글"]) {
      assert.throws(() => parseNormalizeArgs(["normalize", "--project", invalid, "--git-root", "./git"]), /project는/);
      assert.throws(() => parseExtractArgs(["extract", "--project", invalid]), /project는/);
      assert.throws(() => parseBuildArgs(["build", "--project", invalid]), /project는/);
      assert.throws(() => parseSearchArgs(["search", "--query", "q", "--project", invalid]), /project는/);
    }
  });

  it("정상 search 실행은 stdout에 JSON 하나만 쓴다", async () => {
    const dataDir = await temporaryDirectory();
    const projectDirectory = path.join(dataDir, "memory", "tc-ocr");
    const wikiGenerationId = `wiki-${"1".repeat(64)}`;
    const generationDirectory = path.join(projectDirectory, WIKI_GENERATIONS_DIRECTORY, wikiGenerationId);
    const record = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      id: `mem-${"a".repeat(64)}`,
      title: "검색 계약",
      kind: "decision",
      status: "active",
      confidence: "high",
      summary: "stdout JSON 계약",
      why: "agent 호출을 단순하게 한다.",
      doNot: [],
      scope: { project: "tc-ocr", repositories: [], modules: [], paths: [] },
      validFrom: "2026-08-11",
      validUntil: null,
      lastVerified: "2026-08-11",
      relatedTerms: [],
      sourceRefs: [{ sourceType: "dooray-task", sourceId: "task-a", title: "원문", url: "https://example.com/task-a" }],
    };
    const index = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      project: "tc-ocr",
      wikiGenerationId,
      extractionGenerationId: `ext-${"2".repeat(64)}`,
      sourceGenerationId: `src-${"3".repeat(64)}`,
      sourceManifestHash: `sha256:${"4".repeat(64)}`,
      extractionManifestHash: `sha256:${"5".repeat(64)}`,
      complete: true,
      documents: [
        {
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
          markdownPath: "decisions/search-contract.md",
          normalized: { title: "검색 계약", relatedTerms: [], summary: "stdout json 계약", why: "agent 호출을 단순하게 한다.", scope: "tc-ocr" },
          record,
        },
      ],
    };
    await mkdir(generationDirectory, { recursive: true });
    await writeFile(
      path.join(projectDirectory, CURRENT_WIKI_POINTER_FILE),
      `${canonicalString({ schemaVersion: MEMORY_SCHEMA_VERSION, generationId: wikiGenerationId })}\n`,
      "utf8",
    );
    await writeFile(path.join(generationDirectory, WIKI_INDEX_FILE), `${canonicalString(index)}\n`, "utf8");
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };
    try {
      await runMemoryCli(["search", "--query", "검색", "--data-dir", dataDir]);
      assert.equal(lines.length, 1);
      const output = JSON.parse(lines[0]) as { returned: number; results: Array<{ sourceRefs: Array<{ url: string }> }> };
      assert.equal(output.returned, 1);
      assert.equal(output.results[0]?.sourceRefs[0]?.url, "https://example.com/task-a");
    } finally {
      console.log = originalLog;
    }
  });
});
