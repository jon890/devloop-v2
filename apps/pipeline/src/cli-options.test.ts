import assert from "node:assert/strict";
import test from "node:test";
import { parsePipelineOptions } from "./cli-options";

test("ingest 실행 옵션에서 project와 limit을 읽는다", () => {
  assert.deepEqual(parsePipelineOptions(["ingest", "--", "--project", "tc-ocr", "--limit", "5"]), { project: "tc-ocr", stage: "ingest", limit: 5 });
});

test("--docs의 쉼표 구분 sourceDocId 목록을 읽는다", () => {
  assert.deepEqual(parsePipelineOptions(["extract:llm", "--docs", " Task:483, Wiki:123 ,,Task:484 "]), {
    project: "tc-ocr",
    stage: "extract:llm",
    limit: undefined,
    docs: ["Task:483", "Wiki:123", "Task:484"],
  });
});

test("옵션 값이 누락되면 다음 플래그로 넘어가지 않고 실패한다", () => {
  assert.throws(() => parsePipelineOptions(["ingest", "--project", "--limit", "5"]), /--project 값을 입력해야 합니다/);
  assert.throws(() => parsePipelineOptions(["ingest", "--limit"]), /--limit 값을 입력해야 합니다/);
  assert.throws(() => parsePipelineOptions(["extract:llm", "--docs"]), /--docs 값을 입력해야 합니다/);
  assert.throws(() => parsePipelineOptions(["extract:llm", "--docs", " , , "]), /sourceDocId를 하나 이상 입력해야 합니다/);
});
