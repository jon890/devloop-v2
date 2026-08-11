import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { parseExtractArgs, parseNormalizeArgs } from "./cli";

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
