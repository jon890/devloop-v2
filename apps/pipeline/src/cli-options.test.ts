import assert from "node:assert/strict";
import test from "node:test";
import { parsePipelineOptions } from "./cli-options";

test("fetch-dooray 실행 옵션에서 project와 limit을 읽는다", () => {
  assert.deepEqual(parsePipelineOptions(["fetch-dooray", "--", "--project", "tc-ocr", "--limit", "5"]), {
    project: "tc-ocr",
    stage: "fetch-dooray",
    limit: 5,
  });
});

test("--docs의 쉼표 구분 sourceDocId 목록을 읽는다", () => {
  assert.deepEqual(parsePipelineOptions(["infer-knowledge", "--docs", " Task:483, Wiki:123 ,,Task:484 "]), {
    project: "tc-ocr",
    stage: "infer-knowledge",
    limit: undefined,
    docs: ["Task:483", "Wiki:123", "Task:484"],
  });
});

test("옵션 값이 누락되면 다음 플래그로 넘어가지 않고 실패한다", () => {
  assert.throws(() => parsePipelineOptions(["fetch-dooray", "--project", "--limit", "5"]), /--project 값을 입력해야 합니다/);
  assert.throws(() => parsePipelineOptions(["fetch-dooray", "--limit"]), /--limit 값을 입력해야 합니다/);
  assert.throws(() => parsePipelineOptions(["infer-knowledge", "--docs"]), /--docs 값을 입력해야 합니다/);
  assert.throws(() => parsePipelineOptions(["infer-knowledge", "--docs", " , , "]), /sourceDocId를 하나 이상 입력해야 합니다/);
});

test("project code는 path segment로 쓰기 전에 manifest 계약으로 검증한다", () => {
  for (const invalid of ["../../outside", " ", ".hidden", "한글"]) {
    assert.throws(() => parsePipelineOptions(["fetch-dooray", "--project", invalid]), /project는/);
  }
});
