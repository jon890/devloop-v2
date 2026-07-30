import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { EndpointIndex } from "../infer/llm-relationship-sanitizer";
import { assertEndpointIndexNotEmpty, parseResolveArgs } from "./cli";
import type { ResolveInput } from "./resolve";

function buildInput(endpointIndex: EndpointIndex): ResolveInput {
  return { parsed: [], inferred: [], dictionary: [], endpointIndex, previousDropped: [] };
}

const CONFIG_WITHOUT_DATA_DIR = {};
const CONFIG_WITH_DATA_DIR = { pipelineDataDir: "/tmp/devloop-data-from-config" };

test("--data-dir 는 절대 경로만 받는다 — 상대 경로는 거부한다", () => {
  assert.throws(
    () => parseResolveArgs(["--data-dir", "relative/data"], CONFIG_WITHOUT_DATA_DIR),
    /--data-dir 또는 PIPELINE_DATA_DIR 은 절대 경로여야 합니다/,
  );
});

// 회귀 테스트 — resolve-graph 가 PIPELINE_DATA_DIR 를 무시하면 sync-neo4j(같은 환경변수를 읽는다,
// neo4j/sync.ts)와 서로 다른 데이터를 본다. dry-run 비교가 실제 적재 대상과 어긋나는 문제였다.
test("--data-dir 가 없으면 PIPELINE_DATA_DIR 를 쓴다 — sync-neo4j 와 같은 우선순위다", () => {
  const options = parseResolveArgs([], CONFIG_WITH_DATA_DIR);
  assert.equal(options.dataDir, resolve("/tmp/devloop-data-from-config"));
});

test("--data-dir 가 있으면 PIPELINE_DATA_DIR 보다 우선한다", () => {
  const options = parseResolveArgs(["--data-dir", "/tmp/devloop-data-from-flag"], CONFIG_WITH_DATA_DIR);
  assert.equal(options.dataDir, resolve("/tmp/devloop-data-from-flag"));
});

test("PIPELINE_DATA_DIR 가 상대 경로면 --data-dir 와 같은 이유로 거부한다", () => {
  assert.throws(() => parseResolveArgs([], { pipelineDataDir: "relative/data" }), /--data-dir 또는 PIPELINE_DATA_DIR 은 절대 경로여야 합니다/);
});

test("--project·--out 을 지정하지 않으면 기본값을 쓴다", () => {
  const options = parseResolveArgs(["--data-dir", "/tmp/devloop-data"], CONFIG_WITHOUT_DATA_DIR);
  assert.equal(options.project, "tc-ocr");
  assert.equal(options.outPath, resolve("/tmp/devloop-data/graph/tc-ocr/resolved.jsonl"));
  assert.equal(options.reportPath, resolve("/tmp/devloop-data/graph/tc-ocr/resolve-report.json"));
});

test("--out 을 지정하면 리포트는 같은 디렉터리에 --out 의 basename 을 따른 이름이 된다 — 덮어쓰기 방지", () => {
  const options = parseResolveArgs(["--data-dir", "/tmp/devloop-data", "--out", "/tmp/before.jsonl"], CONFIG_WITHOUT_DATA_DIR);
  assert.equal(options.outPath, resolve("/tmp/before.jsonl"));
  assert.equal(options.reportPath, resolve("/tmp/before.resolve-report.json"));
});

test("--out 을 다르게 두 번 지정하면 리포트도 서로 다른 파일이 된다 — dry-run 비교에서 덮어써지지 않는다", () => {
  const before = parseResolveArgs(["--data-dir", "/tmp/devloop-data", "--out", "/tmp/before.jsonl"], CONFIG_WITHOUT_DATA_DIR);
  const after = parseResolveArgs(["--data-dir", "/tmp/devloop-data", "--out", "/tmp/after.jsonl"], CONFIG_WITHOUT_DATA_DIR);
  assert.notEqual(before.reportPath, after.reportPath);
  assert.equal(after.reportPath, resolve("/tmp/after.resolve-report.json"));
});

test("raw 끝점 색인이 완전히 비면 실패한다 — data/raw/<project> 부재를 잡아낸다", () => {
  assert.throws(
    () =>
      assertEndpointIndexNotEmpty(
        buildInput({
          taskNumbers: new Set(),
          taskIdToNumber: new Map(),
          wikiPageIds: new Set(),
          wikiIdToPageId: new Map(),
        }),
      ),
    /raw 문서\(Task·Wiki\)를 찾을 수 없습니다/,
  );
});

test("Task 나 Wiki 끝점이 하나라도 있으면 통과한다", () => {
  assert.doesNotThrow(() =>
    assertEndpointIndexNotEmpty(
      buildInput({
        taskNumbers: new Set(["483"]),
        taskIdToNumber: new Map(),
        wikiPageIds: new Set(),
        wikiIdToPageId: new Map(),
      }),
    ),
  );
});
