import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EndpointIndex } from "../infer/llm-relationship-sanitizer";
import { readResolveInput, writeResolved, writeResolveReport } from "./io";
import { resolveGraph } from "./resolve";
import type { ResolveResult } from "./resolve.schema";

const EMPTY_ENDPOINT_INDEX: EndpointIndex = {
  taskNumbers: new Set(),
  taskIdToNumber: new Map(),
  wikiPageIds: new Set(),
  wikiIdToPageId: new Map(),
};

async function makeDataDir(project: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "pipeline-resolve-io-"));
  await mkdir(join(dataDir, "graph", project), { recursive: true });
  return dataDir;
}

async function writeParsed(dataDir: string, project: string, lines: readonly unknown[]): Promise<void> {
  await writeFile(join(dataDir, "graph", project, "parsed.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function writeRawProject(dataDir: string, project: string): Promise<void> {
  const projectDir = join(dataDir, "raw", project);
  await mkdir(join(projectDir, "posts"), { recursive: true });
  await mkdir(join(projectDir, "wiki"), { recursive: true });
  await writeFile(join(projectDir, "posts", "1.json"), JSON.stringify({ post: { id: "p1", number: "483", subject: "t" }, comments: [] }), "utf8");
}

const TASK_483 = { label: "Task", key: "483", properties: { number: 483 } };

test("parsed.jsonl 과 inferred.jsonl 을 파일명으로 명시해 읽는다 — 디렉터리를 훑지 않는다", async () => {
  const project = "sample";
  const dataDir = await makeDataDir(project);
  try {
    await writeParsed(dataDir, project, [TASK_483]);
    await writeRawProject(dataDir, project);
    // resolved.jsonl 이 같은 디렉터리에 있어도 입력으로 딸려 들어오면 안 된다 (회귀 테스트).
    await writeFile(join(dataDir, "graph", project, "resolved.jsonl"), '{"label":"Task","key":"999","properties":{"number":999}}\n', "utf8");
    // jsonl 확장자를 가진 무관한 파일도 훑지 않아야 한다.
    await writeFile(join(dataDir, "graph", project, "garbage.jsonl"), "not json\n", "utf8");

    const input = await readResolveInput(dataDir, project);

    assert.deepEqual(
      input.parsed.map((record) => record.value),
      [TASK_483],
    );
    assert.equal(input.inferred.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("parsed.jsonl 이 없으면 즉시 실패한다", async () => {
  const project = "sample";
  const dataDir = await makeDataDir(project);
  try {
    await writeRawProject(dataDir, project);
    await assert.rejects(readResolveInput(dataDir, project), /parsed\.jsonl 이 없습니다/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("inferred.jsonl 이 없으면 경고하고 빈 배열로 진행한다", async () => {
  const project = "sample";
  const dataDir = await makeDataDir(project);
  try {
    await writeParsed(dataDir, project, [TASK_483]);
    await writeRawProject(dataDir, project);

    const input = await readResolveInput(dataDir, project);

    assert.equal(input.inferred.length, 0);
    assert.equal(input.parsed.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// 회귀 테스트 — raw 부재 검사는 resolve/cli.ts 의 책임이지 io.ts 의 책임이 아니다.
// 이 검사를 io.ts 로 잘못 내리면 sync-neo4j 도 raw 없이는 못 돌게 되어 적재 동작이 조용히 바뀐다.
// 누군가 그 실수를 하면 이 테스트가 실패해야 한다.
test("raw 문서(data/raw/<project>)가 없어도 io.ts 는 예외를 던지지 않는다 (raw 엄격 판정은 cli.ts 몫)", async () => {
  const project = "sample";
  const dataDir = await makeDataDir(project);
  try {
    await writeParsed(dataDir, project, [TASK_483]);
    // raw/ 디렉터리를 아예 만들지 않는다.

    const input = await readResolveInput(dataDir, project);

    assert.equal(input.endpointIndex.taskNumbers.size, 0);
    assert.equal(input.endpointIndex.wikiPageIds.size, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("writeResolved 는 입력 순서를 뒤섞어도 라벨→키, 유형→시작키→끝키 순 바이트 동등 출력을 낸다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pipeline-resolve-io-sort-"));
  try {
    const nodes = [
      { label: "Task", key: "2", properties: { number: 2 } },
      { label: "Task", key: "1", properties: { number: 1 } },
      { label: "Concept", key: "api", properties: { name: "api", kind: "tech" } },
    ];
    const relationships = [
      { type: "MENTIONS", startKey: "Task:2", endKey: "Concept:api", properties: {} },
      { type: "MENTIONS", startKey: "Task:1", endKey: "Concept:api", properties: {} },
    ];
    const records = [...nodes, ...relationships];

    const buildInput = (order: readonly number[]) => ({
      parsed: order.map((index) => ({ value: records[index], sourceFile: "parsed.jsonl" })),
      inferred: [],
      dictionary: [{ canonical: "api", kind: "tech" as const, aliases: [] }],
      endpointIndex: EMPTY_ENDPOINT_INDEX,
      previousDropped: [],
    });

    const graph1 = resolveGraph(buildInput([0, 1, 2, 3, 4]));
    const graph2 = resolveGraph(buildInput([4, 2, 3, 1, 0]));

    const outPath1 = join(dataDir, "out1.jsonl");
    const outPath2 = join(dataDir, "out2.jsonl");
    await writeResolved(outPath1, graph1);
    await writeResolved(outPath2, graph2);

    const [content1, content2] = await Promise.all([readFile(outPath1, "utf8"), readFile(outPath2, "utf8")]);
    assert.equal(content1, content2);

    const lines = content1
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => line.key ?? `${line.type}:${line.startKey}->${line.endKey}`),
      ["api", "1", "2", "MENTIONS:1->api", "MENTIONS:2->api"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("writeResolveReport 는 리포트 스키마에 맞는 JSON 파일을 쓴다", async () => {
  const project = "sample";
  const dataDir = await makeDataDir(project);
  try {
    const result: ResolveResult = {
      nodes: [],
      relationships: [],
      unknownConcepts: new Map([
        ["b", 1],
        ["a", 2],
      ]),
      skippedRelationships: { count: 0, samples: [] },
      droppedRelationships: { count: 0, documents: [] },
      rewrittenRelationships: 0,
    };
    const reportPath = join(dataDir, "resolve-report.json");
    await writeResolveReport(reportPath, result);

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.unknownConcepts, [
      ["a", 2],
      ["b", 1],
    ]);
    assert.equal(report.nodeCount, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// 회귀 테스트 — ResolveReportFileSchema 는 z.object 라 스키마에 없는 키를 조용히 버린다.
// droppedRelationships 를 스키마에서 빼도 위 테스트(nodeCount·unknownConcepts 만 확인)는 계속
// 통과하므로, 실제로 파일에 담기는지 이 필드를 직접 단언해 지켜야 한다.
test("writeResolveReport 는 droppedRelationships 를 파일에 그대로 담는다", async () => {
  const project = "sample";
  const dataDir = await makeDataDir(project);
  try {
    const droppedRelationships: ResolveResult["droppedRelationships"] = {
      count: 1,
      documents: [
        {
          sourceDocId: "Task:483",
          count: 1,
          relationships: [
            {
              relationship: { type: "MENTIONS", startKey: "Task:483", endKey: "Concept:api", properties: {} },
              reason: "unknown endpoint",
            },
          ],
        },
      ],
    };
    const result: ResolveResult = {
      nodes: [],
      relationships: [],
      unknownConcepts: new Map(),
      skippedRelationships: { count: 0, samples: [] },
      droppedRelationships,
      rewrittenRelationships: 0,
    };
    const reportPath = join(dataDir, "resolve-report.json");
    await writeResolveReport(reportPath, result);

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.droppedRelationships, droppedRelationships);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// 회귀 테스트 — (type, startKey, endKey) 가 같고 properties 만 다른 관계 2건은 relationshipTieBreakKey
// 없이는 순서가 정해지지 않는다(V8 안정 정렬로 우연히 입력 순서가 유지될 뿐). io.ts 위 주석 참조.
test("writeResolved 는 (type, startKey, endKey) 가 같고 properties 만 다른 관계도 tie-break 로 결정적 순서를 낸다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pipeline-resolve-io-tiebreak-"));
  try {
    const nodes = [
      { label: "Task", key: "1", properties: { number: 1 } },
      { label: "Concept", key: "api", properties: { name: "api", kind: "tech" } },
    ];
    const relationships = [
      { type: "TAGGED", startKey: "Task:1", endKey: "Concept:api", properties: { dimension: "secondary" } },
      { type: "TAGGED", startKey: "Task:1", endKey: "Concept:api", properties: { dimension: "primary" } },
    ];
    const records = [...nodes, ...relationships];

    const buildInput = (order: readonly number[]) => ({
      parsed: order.map((index) => ({ value: records[index], sourceFile: "parsed.jsonl" })),
      inferred: [],
      dictionary: [{ canonical: "api", kind: "tech" as const, aliases: [] }],
      endpointIndex: EMPTY_ENDPOINT_INDEX,
      previousDropped: [],
    });

    const graph1 = resolveGraph(buildInput([0, 1, 2, 3]));
    const graph2 = resolveGraph(buildInput([3, 2, 1, 0]));

    const outPath1 = join(dataDir, "out1.jsonl");
    const outPath2 = join(dataDir, "out2.jsonl");
    await writeResolved(outPath1, graph1);
    await writeResolved(outPath2, graph2);

    const [content1, content2] = await Promise.all([readFile(outPath1, "utf8"), readFile(outPath2, "utf8")]);
    assert.equal(content1, content2);

    const relationshipLines = content1
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === "TAGGED");
    assert.deepEqual(
      relationshipLines.map((line) => line.properties.dimension),
      ["primary", "secondary"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
