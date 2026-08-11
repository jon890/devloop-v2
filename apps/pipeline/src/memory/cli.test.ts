import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { parseNormalizeArgs } from "./cli";

describe("normalize-memory CLI", () => {
  it("normalize 명령의 project, git root, data dir를 해석한다", () => {
    const options = parseNormalizeArgs(["normalize", "--project", "tc-ocr", "--git-root", "./git", "--data-dir", "./data"]);
    assert.deepEqual(options, { project: "tc-ocr", gitRoot: path.resolve("./git"), dataDir: path.resolve("./data") });
  });

  it("필수 flag가 없으면 사용 전에 실패한다", () => {
    assert.throws(() => parseNormalizeArgs(["normalize", "--project", "tc-ocr"]), /--git-root/);
  });
});
